import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import { Wallet } from 'ethers';
import { JsonRpcProvider } from '../../src/provider';
import { TakeWriteTransportMode } from '../../src/config';
import {
  createTakeWriteTransport,
  PermanentTakeTransportError,
  resolveTakeWriteConfig,
  resolveTakeWriteTransport,
} from '../../src/take/write-transport';
import { NonceTracker, isNonceConsumedTransactionError } from '../../src/nonce';

import {
  installTakeWriteTransportTestState,
  relaySignerFixture,
  restoreTakeWriteTransportTestState,
  withTakeWrite,
} from './helpers/take-write-transport-fixture';

describe('take write transport', () => {
  beforeEach(() => {
    installTakeWriteTransportTestState();
  });

  afterEach(() => {
    restoreTakeWriteTransportTestState();
  });
  it('uses explicit private_rpc take write config', () => {
    expect(
      resolveTakeWriteConfig(
        withTakeWrite({
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://private-rpc',
        })
      )
    ).to.deep.equal({
      mode: TakeWriteTransportMode.PRIVATE_RPC,
      rpcUrl: 'http://private-rpc',
    });
  });

  it('rejects unknown take write transport modes', async () => {
    const signer = Wallet.createRandom();

    try {
      await createTakeWriteTransport({
        signer,
        config: withTakeWrite({
          mode: 'private-rpc',
          rpcUrl: 'http://private-rpc',
        }) as any,
        expectedChainId: 1,
      });
      expect.fail('Expected unknown take write mode to throw');
    } catch (error) {
      // Real-producer contract: the structural failure carries the typed error
      // run.ts classifies via instanceof (and propagates unwrapped).
      expect(error).to.be.instanceOf(PermanentTakeTransportError);
      expect((error as Error).message).to.include(
        'Unsupported take write transport mode: private-rpc'
      );
    }
  });

  it('throws a PermanentTakeTransportError when the private_rpc chainId mismatches', async () => {
    const signer = Wallet.createRandom();

    try {
      // detectNetwork is stubbed to chainId 1 in beforeEach; expecting 8453
      // triggers the real chainId-mismatch producer.
      await createTakeWriteTransport({
        signer,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://private-rpc',
        }) as any,
        expectedChainId: 8453,
      });
      expect.fail('Expected chainId mismatch to throw');
    } catch (error) {
      expect(error).to.be.instanceOf(PermanentTakeTransportError);
      expect((error as Error).message).to.include(
        'does not match keeper chainId'
      );
    }
  });

  it('creates a public transport when no dedicated take write config is present', async () => {
    const signer = Wallet.createRandom();

    const transport = await createTakeWriteTransport({
      signer,
      config: {} as any,
      expectedChainId: 1,
    });

    expect(transport.mode).to.equal(TakeWriteTransportMode.PUBLIC_RPC);
    expect(transport.signer).to.equal(signer);
  });

  it('uses an explicitly supplied take write transport over the public fallback', () => {
    const signer = Wallet.createRandom();
    const configuredTransport = {
      mode: TakeWriteTransportMode.RELAY,
      signer,
      submitTransaction: sinon.stub(),
    } as any;

    const resolved = resolveTakeWriteTransport(signer, {
      takeWriteTransport: configuredTransport,
    });

    expect(resolved).to.equal(configuredTransport);
  });

  it('rejects incomplete private_rpc and relay take write configs before startup', async () => {
    const signer = Wallet.createRandom();

    try {
      await createTakeWriteTransport({
        signer,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.PRIVATE_RPC,
        }) as any,
        expectedChainId: 1,
      });
      expect.fail('Expected missing private rpc url to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'takeWrite.mode=private_rpc requires takeWrite.rpcUrl'
      );
    }

    try {
      await createTakeWriteTransport({
        signer,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.RELAY,
          relay: {},
        }) as any,
        expectedChainId: 1,
      });
      expect.fail('Expected missing relay url to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'takeWrite.mode=relay requires takeWrite.relay.url'
      );
    }
  });

  it('rejects relay transport startup on signer chain mismatch or missing provider', async () => {
    const chainMismatch = relaySignerFixture({ chainId: 8453 }).signer;
    try {
      await createTakeWriteTransport({
        signer: chainMismatch,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        }) as any,
        expectedChainId: 1,
      });
      expect.fail('Expected relay chain mismatch to throw');
    } catch (error) {
      expect(error).to.be.instanceOf(PermanentTakeTransportError);
      expect((error as Error).message).to.include(
        'Configured relay signer chainId 8453 does not match keeper chainId 1'
      );
    }

    const noProvider = relaySignerFixture({ includeProvider: false }).signer;
    try {
      await createTakeWriteTransport({
        signer: noProvider,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        }) as any,
        expectedChainId: 1,
      });
      expect.fail('Expected relay signer without provider to throw');
    } catch (error) {
      expect(error).to.be.instanceOf(PermanentTakeTransportError);
      expect((error as Error).message).to.include(
        'requires the keeper signer to be connected to a provider'
      );
    }
  });

  it('wraps public rpc receipt wait failures as nonce-consumed errors', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    try {
      const signer = {
        sendTransaction: sinon.stub().resolves({
          hash: '0xpublic',
          wait: sinon.stub().returns(new Promise(() => {})),
        }),
      } as any;

      const transport = await createTakeWriteTransport({
        signer,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.PUBLIC_RPC,
          receiptTimeoutMs: 25,
        }) as any,
        expectedChainId: 1,
      });

      const submission = await transport.submitTransaction({
        to: '0x00000000000000000000000000000000000000bb',
        nonce: 7,
      });
      const waitPromise = submission.wait().then(
        () => {
          expect.fail('Expected public rpc wait to time out');
        },
        (error) => {
          expect(isNonceConsumedTransactionError(error)).to.equal(true);
          expect((error as Error).message).to.include(
            'Public RPC submission 0xpublic was accepted but receipt wait failed'
          );
        }
      );

      await clock.tickAsync(26);
      await waitPromise;
    } finally {
      clock.restore();
    }
  });

  it('wraps non-timeout public rpc receipt failures as nonce-consumed errors', async () => {
    const signer = {
      sendTransaction: sinon.stub().resolves({
        hash: '0xpublic',
        wait: sinon.stub().rejects(new Error('receipt reverted')),
      }),
    } as any;

    const transport = await createTakeWriteTransport({
      signer,
      config: withTakeWrite({
        mode: TakeWriteTransportMode.PUBLIC_RPC,
      }) as any,
      expectedChainId: 1,
    });

    const submission = await transport.submitTransaction({
      to: '0x00000000000000000000000000000000000000bb',
      nonce: 7,
    });

    try {
      await submission.wait();
      expect.fail('Expected public rpc wait to fail');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect((error as Error).message).to.include(
        'Public RPC submission 0xpublic was accepted but receipt wait failed'
      );
      expect(
        ((error as Error & { cause?: Error }).cause as Error).message
      ).to.equal('receipt reverted');
    }
  });

  it('times out a hung private_rpc network probe', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    try {
      const signer = Wallet.createRandom();
      sinon
        .stub(JsonRpcProvider.prototype, 'getNetwork')
        .returns(new Promise(() => {}));

      const createPromise = createTakeWriteTransport({
        signer,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://private-rpc',
        }) as any,
        expectedChainId: 1,
      }).then(
        () => {
          expect.fail('Expected private_rpc network probe to time out');
        },
        (error) => {
          expect((error as Error).message).to.include(
            'takeWrite private_rpc getNetwork for http://private-rpc timed out after 5000ms'
          );
        }
      );

      await clock.tickAsync(5001);
      await createPromise;
    } finally {
      clock.restore();
    }
  });

  it('creates a private transport from explicit private_rpc config', async () => {
    const signer = Wallet.createRandom();
    sinon
      .stub(JsonRpcProvider.prototype, 'getNetwork')
      .resolves({ chainId: 1 } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: withTakeWrite({
        mode: TakeWriteTransportMode.PRIVATE_RPC,
        rpcUrl: 'http://private-rpc',
      }) as any,
      expectedChainId: 1,
    });

    expect(transport.mode).to.equal(TakeWriteTransportMode.PRIVATE_RPC);
    expect(transport.signer).to.not.equal(signer);
  });

  it('wraps private rpc wait failures without a nonce without durable floor persistence', async () => {
    const writeSigner = {
      address: '0x00000000000000000000000000000000000000aa',
      sendTransaction: sinon.stub().resolves({
        hash: '0xprivate',
        wait: sinon.stub().rejects(new Error('receipt failed')),
      }),
    };
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      getTransactionCount: sinon.stub().resolves(7),
      connect: sinon.stub().returns(writeSigner),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
      },
    } as any;
    sinon
      .stub(JsonRpcProvider.prototype, 'getNetwork')
      .resolves({ chainId: 1 } as any);
    const durableFloorStub = sinon.stub(NonceTracker, 'markDurableNonceFloor');

    const transport = await createTakeWriteTransport({
      signer,
      config: withTakeWrite({
        mode: TakeWriteTransportMode.PRIVATE_RPC,
        rpcUrl: 'http://private-rpc',
      }) as any,
      expectedChainId: 1,
    });

    const submission = await transport.submitTransaction({
      to: '0x00000000000000000000000000000000000000bb',
    });

    try {
      await submission.wait();
      expect.fail('Expected private rpc wait failure');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect((error as Error).message).to.include(
        'Private RPC submission 0xprivate was accepted but receipt wait failed'
      );
    }
    expect(durableFloorStub.called).to.equal(false);
  });

  it('wraps private rpc durable nonce persistence failures after accepted submissions', async () => {
    const writeSigner = {
      address: '0x00000000000000000000000000000000000000aa',
      sendTransaction: sinon.stub().resolves({
        hash: '0xprivate',
        wait: sinon.stub().rejects(new Error('receipt failed')),
      }),
    };
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      getTransactionCount: sinon.stub().resolves(7),
      connect: sinon.stub().returns(writeSigner),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
      },
    } as any;
    sinon
      .stub(JsonRpcProvider.prototype, 'getNetwork')
      .resolves({ chainId: 1 } as any);
    sinon
      .stub(NonceTracker, 'markDurableNonceFloor')
      .rejects(new Error('disk full'));

    const transport = await createTakeWriteTransport({
      signer,
      config: withTakeWrite({
        mode: TakeWriteTransportMode.PRIVATE_RPC,
        rpcUrl: 'http://private-rpc',
      }) as any,
      expectedChainId: 1,
    });

    const submission = await transport.submitTransaction({
      to: '0x00000000000000000000000000000000000000bb',
      nonce: 7,
    });

    try {
      await submission.wait();
      expect.fail('Expected durable nonce persistence failure');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect((error as Error).message).to.include(
        'Private RPC submission 0xprivate was accepted but durable nonce floor persistence failed'
      );
    }
  });

  it('persists a long-lived time-based durable nonce floor for private rpc receipt wait failures', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    try {
      const writeSigner = {
        address: '0x00000000000000000000000000000000000000aa',
        sendTransaction: sinon.stub().resolves({
          hash: '0xprivate',
          nonce: 7,
          wait: sinon.stub().returns(new Promise(() => {})),
        }),
      };
      const signer = {
        getAddress: sinon
          .stub()
          .resolves('0x00000000000000000000000000000000000000aa'),
        getChainId: sinon.stub().resolves(1),
        getTransactionCount: sinon.stub().resolves(7),
        connect: sinon.stub().returns(writeSigner),
        provider: {
          getBlockNumber: sinon.stub().resolves(100),
        },
      } as any;
      sinon
        .stub(JsonRpcProvider.prototype, 'getNetwork')
        .resolves({ chainId: 1 } as any);

      const transport = await createTakeWriteTransport({
        signer,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://private-rpc',
          receiptTimeoutMs: 25,
        }) as any,
        expectedChainId: 1,
      });

      const submission = await transport.submitTransaction({
        to: '0x00000000000000000000000000000000000000bb',
        nonce: 7,
      });
      const waitPromise = submission.wait().then(
        () => {
          expect.fail('Expected private rpc wait to fail');
        },
        (error) => {
          expect(isNonceConsumedTransactionError(error)).to.equal(true);
          expect((error as Error).message).to.include(
            'Private RPC submission 0xprivate was accepted but receipt wait failed'
          );
        }
      );

      await clock.tickAsync(26);
      await waitPromise;

      NonceTracker.clearNonces();
      const nonceBeforeExpiry = await NonceTracker.getNonce(signer);
      expect(nonceBeforeExpiry).to.equal(8);

      await clock.tickAsync(15 * 60_000 + 1);

      NonceTracker.clearNonces();
      const nonceAfterExpiry = await NonceTracker.getNonce(signer);
      expect(nonceAfterExpiry).to.equal(7);
    } finally {
      clock.restore();
    }
  });

  it('creates a relay transport and submits a private transaction with a durable nonce floor', async () => {
    const { signer, localTxHash } = relaySignerFixture();
    sinon.stub(axios, 'post').resolves({
      data: {
        result: localTxHash,
      },
    } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: withTakeWrite({
        mode: TakeWriteTransportMode.RELAY,
        relay: {
          url: 'https://relay.example',
        },
      }) as any,
      expectedChainId: 1,
    });

    expect(transport.mode).to.equal(TakeWriteTransportMode.RELAY);
    expect(transport.signer).to.equal(signer);

    const submission = await transport.submitTransaction({
      to: '0x00000000000000000000000000000000000000bb',
      data: '0xdeadbeef',
      nonce: 7,
    });
    const receipt = await submission.wait();

    expect(receipt.transactionHash).to.equal(localTxHash);
    const axiosPostStub = axios.post as sinon.SinonStub;
    expect(axiosPostStub.calledOnce).to.be.true;
    expect(axiosPostStub.firstCall.args[0]).to.equal('https://relay.example');
    expect(axiosPostStub.firstCall.args[1]).to.include({
      jsonrpc: '2.0',
      method: 'eth_sendPrivateTransaction',
    });
    expect(axiosPostStub.firstCall.args[1].params).to.deep.equal([
      {
        tx: '0x1234',
        maxBlockNumber: '0x7d',
      },
    ]);
    expect(axiosPostStub.firstCall.args[2]).to.include({
      timeout: 15000,
    });

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(8);
  });

  it('applies only a local durable nonce expiry for custom relay methods', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    try {
      const {
        signer,
        localTxHash,
        getBlockNumber: getBlockNumberStub,
      } = relaySignerFixture({
        waitForTransaction: sinon.stub().resolves({
          transactionHash:
            '0x3333333333333333333333333333333333333333333333333333333333333333',
        }),
      });
      sinon.stub(axios, 'post').resolves({
        data: {
          result: localTxHash,
        },
      } as any);

      const transport = await createTakeWriteTransport({
        signer,
        config: withTakeWrite({
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
            sendMethod: 'eth_sendRawTransactionConditional',
            maxBlockNumberOffset: 25,
            receiptTimeoutMs: 25,
          },
        }) as any,
        expectedChainId: 1,
      });

      await transport.submitTransaction({
        to: '0x00000000000000000000000000000000000000bb',
        data: '0xdeadbeef',
        nonce: 7,
      });

      const axiosPostStub = axios.post as sinon.SinonStub;
      expect(axiosPostStub.firstCall.args[1].params).to.deep.equal(['0x1234']);
      expect(getBlockNumberStub.called).to.equal(false);

      NonceTracker.clearNonces();
      const nonceBeforeExpiry = await NonceTracker.getNonce(signer);
      expect(nonceBeforeExpiry).to.equal(8);

      await clock.tickAsync(15 * 60_000 + 1);

      NonceTracker.clearNonces();
      const nonceAfterExpiry = await NonceTracker.getNonce(signer);
      expect(nonceAfterExpiry).to.equal(7);
    } finally {
      clock.restore();
    }
  });

  it('does not preserve a nonce when a relay explicitly returns a null result', async () => {
    const { signer } = relaySignerFixture({
      waitForTransaction: sinon.stub(),
    });
    sinon.stub(axios, 'post').resolves({
      data: {
        result: null,
      },
    } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: withTakeWrite({
        mode: TakeWriteTransportMode.RELAY,
        relay: {
          url: 'https://relay.example',
        },
      }) as any,
      expectedChainId: 1,
    });

    try {
      await transport.submitTransaction({
        to: '0x00000000000000000000000000000000000000bb',
        data: '0xdeadbeef',
        nonce: 7,
      });
      expect.fail('Expected null relay result to throw');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(false);
      expect((error as Error).message).to.include(
        'Relay submission did not return a valid tx hash'
      );
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(7);
  });
});
