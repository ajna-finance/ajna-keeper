import { expect } from 'chai';
import sinon from 'sinon';
import {
  KeeperConfig,
  PriceOriginSource,
  TokenToCollect,
} from '../../src/config';
import {
  buildPoolConfigByAddress,
  createLpRedeemerResolver,
  LpRedeemer,
} from '../../src/rewards';
import { logger } from '../../src/logging';

const BASE_CONFIG: KeeperConfig = {
  network: {
    rpcUrl: 'http://localhost:8545',
    subgraph: {
      url: 'http://example-subgraph',
    },
  },
  signer: {
    keystore: '/tmp/keeper.json',
  },
  runtime: {
    logLevel: 'debug',
    delayBetweenRuns: 1,
  },
  ajna: {
    erc20PoolFactory: '0x0000000000000000000000000000000000000001',
    erc721PoolFactory: '0x0000000000000000000000000000000000000002',
    poolUtils: '0x0000000000000000000000000000000000000003',
    positionManager: '0x0000000000000000000000000000000000000004',
    ajnaToken: '0x0000000000000000000000000000000000000005',
  },
  manual: {
    pools: [],
  },
};

function makeLpPool(poolAddress: string) {
  return {
    name: 'LP Pool',
    poolAddress,
    collateralAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
    quoteAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
    collateralSymbol: 'TCOL',
    getBucketByIndex: sinon.stub(),
  } as any;
}

describe('LP reward redeemer resolver', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('hydrates and caches redeemers by normalized pool address', async () => {
    const poolAddress = '0xAaA0000000000000000000000000000000000001';
    const normalizedPoolAddress = poolAddress.toLowerCase();
    const pool = makeLpPool(normalizedPoolAddress);
    const getPoolByAddressStub = sinon.stub().resolves(pool);
    const getPoolAddressStub = sinon.stub().resolves(normalizedPoolAddress);
    const redeemers = new Map<string, LpRedeemer>();
    const resolver = createLpRedeemerResolver({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: getPoolByAddressStub,
          getPoolAddress: getPoolAddressStub,
        },
      } as any,
      poolMap: new Map(),
      config: {
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            redeemFirst: TokenToCollect.QUOTE,
            minAmountQuote: 1,
            minAmountCollateral: 2,
          },
        },
      },
      signer: {
        getAddress: sinon
          .stub()
          .resolves('0x9999999999999999999999999999999999999999'),
      } as any,
      exchangeTracker: { addToken: sinon.stub() } as any,
      hydrationCooldowns: new Map(),
      redeemers,
    });

    const first = await resolver(poolAddress);
    const second = await resolver(normalizedPoolAddress);

    expect(first).to.be.instanceOf(LpRedeemer);
    expect(second).to.equal(first);
    expect(getPoolByAddressStub.calledOnceWith(normalizedPoolAddress)).to.equal(
      true
    );
    expect(redeemers.get(normalizedPoolAddress)).to.equal(first);
    expect((first as any).settings.redeemFirst).to.equal(TokenToCollect.QUOTE);
  });

  it('uses per-pool LP settings and an internal redeemer cache when no default reward is configured', async () => {
    const poolAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const pool = makeLpPool(poolAddress);
    const getPoolByAddressStub = sinon.stub().resolves(pool);
    const resolver = createLpRedeemerResolver({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: getPoolByAddressStub,
          getPoolAddress: sinon.stub().resolves(poolAddress),
        },
      } as any,
      poolMap: new Map(),
      config: {
        ...BASE_CONFIG,
        manual: {
          pools: [
            {
              name: 'LP Pool',
              address: poolAddress,
              price: { source: PriceOriginSource.FIXED, value: 1 },
              collectLpReward: {
                redeemFirst: TokenToCollect.COLLATERAL,
                minAmountQuote: 3,
                minAmountCollateral: 4,
              },
            },
          ],
        },
      },
      signer: {
        getAddress: sinon
          .stub()
          .resolves('0x9999999999999999999999999999999999999999'),
      } as any,
      exchangeTracker: { addToken: sinon.stub() } as any,
      hydrationCooldowns: new Map(),
    });

    const first = await resolver(poolAddress);
    const second = await resolver(poolAddress);

    expect(second).to.equal(first);
    expect(getPoolByAddressStub.calledOnce).to.equal(true);
    expect((first as any).settings).to.deep.include({
      redeemFirst: TokenToCollect.COLLATERAL,
      minAmountQuote: 3,
      minAmountCollateral: 4,
    });
  });

  it('returns undefined when a hydrated pool has no LP collection settings', async () => {
    const poolAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const redeemers = new Map<string, LpRedeemer>();
    const resolver = createLpRedeemerResolver({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: sinon.stub().resolves(makeLpPool(poolAddress)),
          getPoolAddress: sinon.stub().resolves(poolAddress),
        },
      } as any,
      poolMap: new Map(),
      config: BASE_CONFIG,
      signer: {
        getAddress: sinon
          .stub()
          .resolves('0x9999999999999999999999999999999999999999'),
      } as any,
      exchangeTracker: { addToken: sinon.stub() } as any,
      hydrationCooldowns: new Map(),
      redeemers,
    });

    expect(await resolver(poolAddress)).to.equal(undefined);
    expect(redeemers.size).to.equal(0);
  });

  it('returns undefined when pool hydration fails', async () => {
    sinon.stub(logger, 'error');
    const poolAddress = '0xcccccccccccccccccccccccccccccccccccccccc';
    const redeemers = new Map<string, LpRedeemer>();
    const resolver = createLpRedeemerResolver({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: sinon.stub().rejects(new Error('pool unavailable')),
          getPoolAddress: sinon.stub(),
        },
      } as any,
      poolMap: new Map(),
      config: {
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            redeemFirst: TokenToCollect.QUOTE,
            minAmountQuote: 1,
            minAmountCollateral: 2,
          },
        },
      },
      signer: {
        getAddress: sinon
          .stub()
          .resolves('0x9999999999999999999999999999999999999999'),
      } as any,
      exchangeTracker: { addToken: sinon.stub() } as any,
      hydrationCooldowns: new Map(),
      redeemers,
    });

    expect(await resolver(poolAddress)).to.equal(undefined);
    expect(redeemers.size).to.equal(0);
  });

  it('builds a normalized pool config lookup for run-loop reuse', () => {
    const map = buildPoolConfigByAddress({
      ...BASE_CONFIG,
      manual: {
        pools: [
          {
            name: 'Mixed Case Pool',
            address: '0xDdD0000000000000000000000000000000000001',
            price: { source: PriceOriginSource.FIXED, value: 1 },
            collectLpReward: {
              minAmountQuote: 1,
              minAmountCollateral: 1,
            },
          },
        ],
      },
    });

    expect(map.has('0xddd0000000000000000000000000000000000001')).to.equal(
      true
    );
  });
});
