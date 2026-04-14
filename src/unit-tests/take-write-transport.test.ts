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
} from '../take/write-transport';
import { NonceTracker, isNonceConsumedTransactionError } from '../nonce';

describe('take write transport', () => {
  let durableStatePath: string;

  beforeEach(() => {
    durableStatePath = path.join(
      '/tmp',
      `ajna-keeper-take-write-${Date.now()}-${Math.random()}.json`
    );
    NonceTracker.setDurableNonceStateFilePathForTests(durableStatePath);
    NonceTracker.clearDurableNonceStateForTests();
  });

  afterEach(() => {
    sinon.restore();
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

  it('times out public rpc receipt waits using the configured timeout', async () => {
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
      });
      const waitPromise = submission.wait().then(
        () => {
          expect.fail('Expected public rpc wait to time out');
        },
        (error) => {
          expect((error as Error).message).to.include(
            'Transaction confirmation timeout after 25ms'
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

  it('wraps private rpc receipt wait failures as nonce-consumed errors', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    try {
      const writeSigner = {
        address: '0x00000000000000000000000000000000000000aa',
        sendTransaction: sinon.stub().resolves({
          hash: '0xprivate',
          wait: sinon.stub().returns(new Promise(() => {})),
        }),
      };
      const signer = {
        connect: sinon.stub().returns(writeSigner),
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

  it('applies a local durable nonce expiry for custom relay methods', async () => {
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
        getBlockNumber: sinon.stub().onFirstCall().resolves(100).onSecondCall().resolves(130),
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

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(7);
  });

  it('rejects a relay response with an invalid tx hash before advancing durable nonce state', async () => {
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
      expect.fail('Expected invalid relay hash to throw');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Relay submission returned invalid tx hash'
      );
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(7);
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
