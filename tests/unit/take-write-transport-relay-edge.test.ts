import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import { BigNumber } from 'ethers';
import { TakeWriteTransportMode } from '../../src/config';
import {
  createTakeWriteTransport,
  submitTakeTransaction,
} from '../../src/take/write-transport';
import { NonceTracker, isNonceConsumedTransactionError } from '../../src/nonce';
import {
  installTakeWriteTransportTestState,
  relaySignerFixture,
  restoreTakeWriteTransportTestState,
  withTakeWrite,
} from './helpers/take-write-transport-fixture';

describe('take write relay edge cases', () => {
  beforeEach(() => {
    installTakeWriteTransportTestState();
  });

  afterEach(() => {
    restoreTakeWriteTransportTestState();
  });

  it('preserves the consumed nonce when a relay response body lacks a usable tx hash', async () => {
    const { signer } = relaySignerFixture({
      waitForTransaction: sinon.stub(),
    });
    sinon.stub(axios, 'post').resolves({
      data: {
        result: '0x1234',
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
    const { signer } = relaySignerFixture({
      waitForTransaction: sinon.stub(),
    });
    sinon.stub(axios, 'post').resolves({
      data: {
        result:
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
    const { signer } = relaySignerFixture({
      waitForTransaction: sinon.stub(),
    });

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
      });
      expect.fail('Expected missing nonce to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Relay take submission requires an explicit nonce'
      );
    }
  });

  it('rejects relay submissions when transaction population drops the nonce', async () => {
    const signer = relaySignerFixture({
      populateTransaction: async (tx) => {
        const { nonce: _nonce, ...withoutNonce } = tx;
        return {
          ...withoutNonce,
          chainId: 1,
          gasLimit: BigNumber.from(21000),
          maxFeePerGas: BigNumber.from(1),
          maxPriorityFeePerGas: BigNumber.from(1),
        };
      },
    }).signer;

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
      expect.fail('Expected missing populated nonce to throw');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Relay take submission requires a populated nonce'
      );
    }
  });

  it('preserves the consumed nonce when relay acceptance is followed by durable floor persistence failure', async () => {
    const { signer, localTxHash } = relaySignerFixture({
      waitForTransaction: sinon.stub(),
    });
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
      config: withTakeWrite({
        mode: TakeWriteTransportMode.RELAY,
        relay: {
          url: 'https://relay.example',
        },
      }) as any,
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
      expect((error as Error).message).to.include('Relay accepted transaction');
    }

    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(8);
  });

  it('preserves the consumed nonce when a relay error response contains an accepted tx hash', async () => {
    const { signer, localTxHash } = relaySignerFixture();
    sinon.stub(axios, 'post').rejects(
      Object.assign(new Error('relay surfaced accepted tx as an error'), {
        isAxiosError: true,
        response: {
          status: 500,
          data: {
            result: {
              txHash: localTxHash,
            },
          },
        },
      })
    );

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
      await NonceTracker.queueTransaction(signer, async (nonce) => {
        return await submitTakeTransaction(transport, {
          to: '0x00000000000000000000000000000000000000bb',
          data: '0xdeadbeef',
          nonce,
        });
      });
      expect.fail(
        'Expected relay error response with tx hash to preserve nonce'
      );
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect((error as Error).message).to.equal(
        `Relay accepted transaction ${localTxHash} but the submission response was surfaced as an error`
      );
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(8);
  });

  it('includes custom relay headers and accepts object-form relay hashes', async () => {
    const { signer, localTxHash } = relaySignerFixture();
    sinon.stub(axios, 'post').resolves({
      data: {
        result: {
          hash: localTxHash,
        },
      },
    } as any);

    const transport = await createTakeWriteTransport({
      signer,
      config: withTakeWrite({
        mode: TakeWriteTransportMode.RELAY,
        relay: {
          url: 'https://relay.example',
          headers: {
            'X-Relay-Key': 'secret',
          },
        },
      }) as any,
      expectedChainId: 1,
    });

    const submission = await transport.submitTransaction({
      to: '0x00000000000000000000000000000000000000bb',
      data: '0xdeadbeef',
      nonce: 7,
    });

    expect(submission.txHash).to.equal(localTxHash);
    const axiosPostStub = axios.post as sinon.SinonStub;
    expect(axiosPostStub.firstCall.args[2].headers).to.deep.include({
      'Content-Type': 'application/json',
      'X-Relay-Key': 'secret',
    });
  });

  it('bubbles explicit relay errors without preserving the nonce', async () => {
    const { signer } = relaySignerFixture();
    sinon.stub(axios, 'post').resolves({
      data: {
        error: {
          code: -32000,
          message: 'relay rejected',
        },
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
      await NonceTracker.queueTransaction(signer, async (nonce) => {
        return await submitTakeTransaction(transport, {
          to: '0x00000000000000000000000000000000000000bb',
          data: '0xdeadbeef',
          nonce,
        });
      });
      expect.fail('Expected explicit relay error to bubble');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(false);
      expect((error as Error).message).to.include('Relay submission failed');
      expect((error as Error).message).to.include('relay rejected');
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(7);
  });

  it('wraps null relay receipts as nonce-consumed after acceptance', async () => {
    const { signer, localTxHash } = relaySignerFixture({
      waitForTransaction: sinon.stub().resolves(null),
    });
    sinon.stub(axios, 'post').resolves({
      data: {
        result: {
          txHash: localTxHash,
        },
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

    const submission = await transport.submitTransaction({
      to: '0x00000000000000000000000000000000000000bb',
      data: '0xdeadbeef',
      nonce: 7,
    });

    try {
      await submission.wait();
      expect.fail('Expected null relay receipt to be nonce-consumed');
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(true);
      expect(
        ((error as Error & { cause?: Error }).cause as Error).message
      ).to.equal(
        `No receipt returned for accepted relay transaction ${localTxHash}`
      );
    }
  });

  it('does not preserve the nonce for ordinary relay HTTP error bodies without a result payload', async () => {
    const { signer } = relaySignerFixture({
      waitForTransaction: sinon.stub(),
    });
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
      config: withTakeWrite({
        mode: TakeWriteTransportMode.RELAY,
        relay: {
          url: 'https://relay.example',
        },
      }) as any,
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
      expect.fail(
        'Expected relay HTTP error to bubble without consuming the nonce'
      );
    } catch (error) {
      expect(isNonceConsumedTransactionError(error)).to.equal(false);
      expect((error as Error).message).to.equal('bad gateway');
    }

    NonceTracker.clearNonces();
    const nextNonce = await NonceTracker.getNonce(signer);
    expect(nextNonce).to.equal(7);
  });

  it('preserves the consumed nonce when a relay response times out after possible acceptance', async () => {
    const { signer, localTxHash } = relaySignerFixture({
      waitForTransaction: sinon.stub(),
    });
    sinon.stub(axios, 'post').rejects(
      Object.assign(new Error('timeout of 15000ms exceeded'), {
        isAxiosError: true,
        code: 'ECONNABORTED',
      })
    );

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
    const { signer, localTxHash } = relaySignerFixture({
      waitForTransaction: sinon.stub().rejects(new Error('timed out')),
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
          requestTimeoutMs: 750,
          receiptTimeoutMs: 1000,
        },
      }) as any,
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
