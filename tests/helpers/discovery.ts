import { BigNumber } from 'ethers';
import sinon from 'sinon';

export function createDiscoveryTransports(
  gasPrice: BigNumber = BigNumber.from(1)
) {
  return {
    subgraph: {
      cacheKey: 'test-subgraph',
      getLoans: sinon.stub().rejects(new Error('unused')),
      getLiquidations: sinon.stub().rejects(new Error('unused')),
      getHighestMeaningfulBucket: sinon.stub().rejects(new Error('unused')),
      getUnsettledAuctions: sinon.stub().rejects(new Error('unused')),
      getChainwideLiquidationAuctions: sinon
        .stub()
        .rejects(new Error('unused')),
      getChainwideKickableLoans: sinon.stub().rejects(new Error('unused')),
      getBucketTakeLPAwards: sinon.stub().rejects(new Error('unused')),
      getSubgraphMeta: sinon.stub().rejects(new Error('unused')),
    },
    readRpc: {
      getGasPrice: sinon.stub().resolves(gasPrice),
    },
  };
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
