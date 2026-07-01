import path from 'path';
import { BigNumber, ethers } from 'ethers';
import sinon from 'sinon';
import { JsonRpcProvider } from '../../../src/provider';
import { NonceTracker } from '../../../src/nonce';

export const withTakeWrite = (take: any) => ({ writes: { take } });

export function relaySignerFixture(
  params: {
    chainId?: number;
    includeProvider?: boolean;
    populateTransaction?: (tx: any) => any;
    waitForTransaction?: sinon.SinonStub;
    getBlockNumber?: sinon.SinonStub;
  } = {}
) {
  const rawTx = '0x1234';
  const localTxHash = ethers.utils.keccak256(rawTx);
  const waitForTransaction =
    params.waitForTransaction ??
    sinon.stub().resolves({
      transactionHash: localTxHash,
    });
  const getBlockNumber = params.getBlockNumber ?? sinon.stub().resolves(100);
  const signer = {
    getAddress: sinon
      .stub()
      .resolves('0x00000000000000000000000000000000000000aa'),
    getChainId: sinon.stub().resolves(params.chainId ?? 1),
    getTransactionCount: sinon.stub().resolves(7),
    populateTransaction: sinon.stub().callsFake(async (tx) => {
      if (params.populateTransaction) {
        return params.populateTransaction(tx);
      }
      return {
        ...tx,
        chainId: 1,
        nonce: tx.nonce ?? 7,
        gasLimit: tx.gasLimit ?? BigNumber.from(21000),
        maxFeePerGas: BigNumber.from(1),
        maxPriorityFeePerGas: BigNumber.from(1),
      };
    }),
    signTransaction: sinon.stub().resolves(rawTx),
    provider:
      params.includeProvider === false
        ? undefined
        : {
            getBlockNumber,
            waitForTransaction,
          },
  } as any;

  return {
    signer,
    rawTx,
    localTxHash,
    waitForTransaction,
    getBlockNumber,
  };
}

export function installTakeWriteTransportTestState(): void {
  const durableStatePath = path.join(
    '/tmp',
    'ajna-keeper-take-write-' + Date.now() + '-' + Math.random() + '.json'
  );
  sinon
    .stub(JsonRpcProvider.prototype, 'detectNetwork')
    .resolves({ chainId: 1, name: 'unknown' } as any);
  NonceTracker.clearNonces();
  NonceTracker.setDurableNonceStateFilePathForTests(durableStatePath);
  NonceTracker.clearDurableNonceStateForTests();
}

export function restoreTakeWriteTransportTestState(): void {
  sinon.restore();
  NonceTracker.clearNonces();
  NonceTracker.clearDurableNonceStateForTests();
}
