import { expect } from 'chai';
import sinon from 'sinon';
import path from 'path';
import axios from 'axios';
import { BigNumber, Wallet, ethers } from 'ethers';
import { JsonRpcProvider } from '../provider';
import {
  TakeWriteTransportMode,
} from '../config';
import {
  createTakeWriteTransport,
  resolveTakeWriteConfig,
  submitTakeTransaction,
} from '../take/write-transport';
import { NonceTracker, isNonceConsumedTransactionError } from '../nonce';

describe('take write transport', () => {
  let durableStatePath: string;

  beforeEach(() => {
    durableStatePath = path.join(
      '/tmp',
      `ajna-keeper-take-write-${Date.now()}-${Math.random()}.json`
    );
    NonceTracker.clearNonces();
    NonceTracker.setDurableNonceStateFilePathForTests(durableStatePath);
    NonceTracker.clearDurableNonceStateForTests();
  });

  afterEach(() => {
    sinon.restore();
    NonceTracker.clearNonces();
    NonceTracker.clearDurableNonceStateForTests();
  });

  it('normalizes legacy takeWriteRpcUrl to private_rpc mode', () => {
    expect(
      resolveTakeWriteConfig({
        takeWriteRpcUrl: 'http://private-rpc',
      } as any)
    ).to.deep.equal({
      mode: TakeWriteTransportMode.PRIVATE_RPC,
      rpcUrl: 'http://private-rpc',
    });
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
        config: {
          takeWrite: {
            mode: TakeWriteTransportMode.PUBLIC_RPC,
            receiptTimeoutMs: 25,
          },
        } as any,
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

  it('creates a private transport from explicit private_rpc config', async () => {
    const signer = Wallet.createRandom();
    sinon
      .stub(JsonRpcProvider.prototype, 'getNetwork')
      .resolves({ chainId: 1 } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://private-rpc',
        },
      } as any,
      expectedChainId: 1,
    });

    expect(transport.mode).to.equal(TakeWriteTransportMode.PRIVATE_RPC);
    expect(transport.signer).to.not.equal(signer);
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
        config: {
          takeWrite: {
            mode: TakeWriteTransportMode.PRIVATE_RPC,
            rpcUrl: 'http://private-rpc',
            receiptTimeoutMs: 25,
          },
        } as any,
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
    const localTxHash = ethers.utils.keccak256('0x1234');
    const waitForTransactionStub = sinon.stub().resolves({
      transactionHash: localTxHash,
    });
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      getTransactionCount: sinon.stub().resolves(7),
      populateTransaction: sinon.stub().callsFake(async (tx) => ({
        ...tx,
        chainId: 1,
        nonce: tx.nonce ?? 7,
        gasLimit: tx.gasLimit ?? BigNumber.from(21000),
        maxFeePerGas: BigNumber.from(1),
        maxPriorityFeePerGas: BigNumber.from(1),
      })),
      signTransaction: sinon.stub().resolves('0x1234'),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
        waitForTransaction: waitForTransactionStub,
      },
    } as any;
    sinon.stub(axios, 'post').resolves({
      data: {
        result: localTxHash,
      },
    } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        },
      } as any,
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
      const getBlockNumberStub = sinon.stub().resolves(100);
      const signer = {
        getAddress: sinon
          .stub()
          .resolves('0x00000000000000000000000000000000000000aa'),
        getChainId: sinon.stub().resolves(1),
        getTransactionCount: sinon.stub().resolves(7),
        populateTransaction: sinon.stub().callsFake(async (tx) => ({
          ...tx,
          chainId: 1,
          nonce: tx.nonce ?? 7,
          gasLimit: tx.gasLimit ?? BigNumber.from(21000),
          maxFeePerGas: BigNumber.from(1),
          maxPriorityFeePerGas: BigNumber.from(1),
        })),
        signTransaction: sinon.stub().resolves('0x1234'),
        provider: {
          getBlockNumber: getBlockNumberStub,
          waitForTransaction: sinon.stub().resolves({
            transactionHash:
              '0x3333333333333333333333333333333333333333333333333333333333333333',
          }),
        },
      } as any;
      const localTxHash = ethers.utils.keccak256('0x1234');
      sinon.stub(axios, 'post').resolves({
        data: {
          result: localTxHash,
        },
      } as any);

      const transport = await createTakeWriteTransport({
        signer,
        config: {
          takeWrite: {
            mode: TakeWriteTransportMode.RELAY,
            relay: {
              url: 'https://relay.example',
              sendMethod: 'eth_sendRawTransactionConditional',
              maxBlockNumberOffset: 25,
              receiptTimeoutMs: 25,
            },
          },
        } as any,
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

  it('preserves the consumed nonce when a relay response body lacks a usable tx hash', async () => {
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      getTransactionCount: sinon.stub().resolves(7),
      populateTransaction: sinon.stub().callsFake(async (tx) => ({
        ...tx,
        chainId: 1,
        nonce: tx.nonce ?? 7,
        gasLimit: tx.gasLimit ?? BigNumber.from(21000),
        maxFeePerGas: BigNumber.from(1),
        maxPriorityFeePerGas: BigNumber.from(1),
      })),
      signTransaction: sinon.stub().resolves('0x1234'),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
        waitForTransaction: sinon.stub(),
      },
    } as any;
    sinon.stub(axios, 'post').resolves({
      data: {
        result: '0x1234',
      },
    } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        },
      } as any,
      expectedChainId: 1,
    });

    try {
      await transport.submitTransaction({
        to: '0x00000000000000000000000000000000000000bb',
        data: '0xdeadbeef',
        nonce: 7,
      });
      expect.fail('Expected unusable relay response to throw');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect((error as Error).message).to.include(
        'may have been accepted but the response body did not contain a usable transaction hash'
      );
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(8);
  });

  it('preserves the consumed nonce when a relay returns a different valid tx hash', async () => {
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      getTransactionCount: sinon.stub().resolves(7),
      populateTransaction: sinon.stub().callsFake(async (tx) => ({
        ...tx,
        chainId: 1,
        nonce: tx.nonce ?? 7,
        gasLimit: tx.gasLimit ?? BigNumber.from(21000),
        maxFeePerGas: BigNumber.from(1),
        maxPriorityFeePerGas: BigNumber.from(1),
      })),
      signTransaction: sinon.stub().resolves('0x1234'),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
        waitForTransaction: sinon.stub(),
      },
    } as any;
    sinon.stub(axios, 'post').resolves({
      data: {
        result:
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        },
      } as any,
      expectedChainId: 1,
    });

    try {
      await transport.submitTransaction({
        to: '0x00000000000000000000000000000000000000bb',
        data: '0xdeadbeef',
        nonce: 7,
      });
      expect.fail('Expected mismatched relay hash to throw');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect((error as Error).message).to.include(
        'may have been accepted but the response body did not contain a usable transaction hash'
      );
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(8);
  });

  it('rejects relay submissions without an explicit nonce', async () => {
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      populateTransaction: sinon.stub(),
      signTransaction: sinon.stub(),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
        waitForTransaction: sinon.stub(),
      },
    } as any;

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        },
      } as any,
      expectedChainId: 1,
    });

    try {
      await transport.submitTransaction({
        to: '0x00000000000000000000000000000000000000bb',
        data: '0xdeadbeef',
      });
      expect.fail('Expected missing nonce to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Relay take submission requires an explicit nonce'
      );
    }
  });

  it('preserves the consumed nonce when relay acceptance is followed by durable floor persistence failure', async () => {
    const localTxHash = ethers.utils.keccak256('0x1234');
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      getTransactionCount: sinon.stub().resolves(7),
      populateTransaction: sinon.stub().callsFake(async (tx) => ({
        ...tx,
        chainId: 1,
        nonce: tx.nonce ?? 7,
        gasLimit: tx.gasLimit ?? BigNumber.from(21000),
        maxFeePerGas: BigNumber.from(1),
        maxPriorityFeePerGas: BigNumber.from(1),
      })),
      signTransaction: sinon.stub().resolves('0x1234'),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
        waitForTransaction: sinon.stub(),
      },
    } as any;
    sinon.stub(axios, 'post').resolves({
      data: {
        result: localTxHash,
      },
    } as any);
    sinon
      .stub(NonceTracker, 'markDurableNonceFloor')
      .rejects(new Error('disk full'));

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        },
      } as any,
      expectedChainId: 1,
    });

    try {
      await NonceTracker.queueTransaction(signer, async (nonce) => {
        return await submitTakeTransaction(transport, {
          to: '0x00000000000000000000000000000000000000bb',
          data: '0xdeadbeef',
          nonce,
        });
      });
      expect.fail('Expected relay durable nonce persistence failure');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect((error as Error).message).to.include(
        'Relay accepted transaction'
      );
    }

    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(8);
  });


  it('does not preserve the nonce for ordinary relay HTTP error bodies without a result payload', async () => {
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      getTransactionCount: sinon.stub().resolves(7),
      populateTransaction: sinon.stub().callsFake(async (tx) => ({
        ...tx,
        chainId: 1,
        nonce: tx.nonce ?? 7,
        gasLimit: tx.gasLimit ?? BigNumber.from(21000),
        maxFeePerGas: BigNumber.from(1),
        maxPriorityFeePerGas: BigNumber.from(1),
      })),
      signTransaction: sinon.stub().resolves('0x1234'),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
        waitForTransaction: sinon.stub(),
      },
    } as any;
    sinon.stub(axios, 'post').rejects(
      Object.assign(new Error('bad gateway'), {
        isAxiosError: true,
        response: {
          status: 502,
          data: {
            message: 'upstream failed',
          },
        },
      })
    );

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        },
      } as any,
      expectedChainId: 1,
    });

    try {
      await NonceTracker.queueTransaction(signer, async (nonce) => {
        return await submitTakeTransaction(transport, {
          to: '0x00000000000000000000000000000000000000bb',
          data: '0xdeadbeef',
          nonce,
        });
      });
      expect.fail('Expected relay HTTP error to bubble without consuming the nonce');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(false);
      expect((error as Error).message).to.equal('bad gateway');
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(7);
  });

  it('preserves the consumed nonce when a relay response times out after possible acceptance', async () => {
    const localTxHash = ethers.utils.keccak256('0x1234');
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      getTransactionCount: sinon.stub().resolves(7),
      populateTransaction: sinon.stub().callsFake(async (tx) => ({
        ...tx,
        chainId: 1,
        nonce: tx.nonce ?? 7,
        gasLimit: tx.gasLimit ?? BigNumber.from(21000),
        maxFeePerGas: BigNumber.from(1),
        maxPriorityFeePerGas: BigNumber.from(1),
      })),
      signTransaction: sinon.stub().resolves('0x1234'),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
        waitForTransaction: sinon.stub(),
      },
    } as any;
    sinon.stub(axios, 'post').rejects(
      Object.assign(new Error('timeout of 15000ms exceeded'), {
        isAxiosError: true,
        code: 'ECONNABORTED',
      })
    );

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
          },
        },
      } as any,
      expectedChainId: 1,
    });

    try {
      await NonceTracker.queueTransaction(signer, async (nonce) => {
        return await submitTakeTransaction(transport, {
          to: '0x00000000000000000000000000000000000000bb',
          data: '0xdeadbeef',
          nonce,
        });
      });
      expect.fail('Expected relay timeout to preserve the nonce');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect((error as Error).message).to.include(localTxHash);
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(8);
  });

  it('wraps relay receipt wait failures as nonce-consumed errors', async () => {
    const signer = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
      getChainId: sinon.stub().resolves(1),
      populateTransaction: sinon.stub().callsFake(async (tx) => ({
        ...tx,
        chainId: 1,
        nonce: tx.nonce ?? 7,
        gasLimit: tx.gasLimit ?? BigNumber.from(21000),
        maxFeePerGas: BigNumber.from(1),
        maxPriorityFeePerGas: BigNumber.from(1),
      })),
      signTransaction: sinon.stub().resolves('0x1234'),
      provider: {
        getBlockNumber: sinon.stub().resolves(100),
        waitForTransaction: sinon.stub().rejects(new Error('timed out')),
      },
    } as any;
    const localTxHash = ethers.utils.keccak256('0x1234');
    sinon.stub(axios, 'post').resolves({
      data: {
        result: localTxHash,
      },
    } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: {
        takeWrite: {
          mode: TakeWriteTransportMode.RELAY,
          relay: {
            url: 'https://relay.example',
            requestTimeoutMs: 750,
            receiptTimeoutMs: 1000,
          },
        },
      } as any,
      expectedChainId: 1,
    });

    const submission = await transport.submitTransaction({
      to: '0x00000000000000000000000000000000000000bb',
      data: '0xdeadbeef',
      nonce: 7,
    });

    const axiosPostStub = axios.post as sinon.SinonStub;
    expect(axiosPostStub.firstCall.args[2]).to.include({
      timeout: 750,
    });

    try {
      await submission.wait();
      expect.fail('Expected relay wait to fail');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
    }
  });
});
