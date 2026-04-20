import { expect } from 'chai';
import {
  isLpCollectionEnabled,
  resolveCollectLpRewardForPool,
  TokenToCollect,
} from '../config';

describe('resolveCollectLpRewardForPool', () => {
  it('returns undefined when neither default nor override is set', () => {
    const resolved = resolveCollectLpRewardForPool(
      undefined,
      undefined,
      '0xpool'
    );
    expect(resolved).to.be.undefined;
  });

  it('returns the default unchanged when no override is set', () => {
    const resolved = resolveCollectLpRewardForPool(
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 5,
        minAmountCollateral: 10,
      },
      undefined,
      '0xpool'
    );
    expect(resolved!.redeemFirst).to.equal(TokenToCollect.QUOTE);
    expect(resolved!.minAmountQuote).to.equal(5);
    expect(resolved!.minAmountCollateral).to.equal(10);
  });

  it('applies a per-pool override on top of the default', () => {
    const resolved = resolveCollectLpRewardForPool(
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 5,
        minAmountCollateral: 10,
      },
      { minAmountQuote: 99 },
      '0xpool'
    );
    expect(resolved!.redeemFirst).to.equal(TokenToCollect.QUOTE);
    expect(resolved!.minAmountQuote).to.equal(99); // override won
    expect(resolved!.minAmountCollateral).to.equal(10); // fell through
  });

  it('allows override to switch redeemFirst', () => {
    const resolved = resolveCollectLpRewardForPool(
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 5,
        minAmountCollateral: 10,
      },
      { redeemFirst: TokenToCollect.COLLATERAL },
      '0xpool'
    );
    expect(resolved!.redeemFirst).to.equal(TokenToCollect.COLLATERAL);
  });

  it('accepts a complete per-pool entry when there is no default (legacy mode)', () => {
    const resolved = resolveCollectLpRewardForPool(
      undefined,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 7,
        minAmountCollateral: 3,
      },
      '0xpool'
    );
    expect(resolved!.redeemFirst).to.equal(TokenToCollect.QUOTE);
    expect(resolved!.minAmountQuote).to.equal(7);
    expect(resolved!.minAmountCollateral).to.equal(3);
  });

  it('throws when legacy per-pool entry omits mandatory fields without a default', () => {
    expect(() =>
      resolveCollectLpRewardForPool(
        undefined,
        { redeemFirst: TokenToCollect.QUOTE }, // no min amounts
        '0xpool'
      )
    ).to.throw(/minAmountQuote and minAmountCollateral are required/);
  });
});

describe('isLpCollectionEnabled', () => {
  const baseConfig: any = {
    ethRpcUrl: 'https://rpc.invalid',
    logLevel: 'info',
    subgraphUrl: 'https://subgraph.invalid',
    keeperKeystore: '/tmp/keeper.json',
    ajna: {},
    delayBetweenActions: 1,
    delayBetweenRuns: 10,
  };

  it('returns false when neither defaultLpReward nor any per-pool entry is set', () => {
    expect(isLpCollectionEnabled({ ...baseConfig, pools: [] })).to.be.false;
    expect(
      isLpCollectionEnabled({
        ...baseConfig,
        pools: [{ address: '0xa', price: {} }],
      })
    ).to.be.false;
  });

  it('returns true when defaultLpReward is set (chain-wide mode)', () => {
    expect(
      isLpCollectionEnabled({
        ...baseConfig,
        pools: [],
        defaultLpReward: {
          minAmountQuote: 0,
          minAmountCollateral: 0,
        },
      })
    ).to.be.true;
  });

  it('returns true when any pool has a per-pool collectLpReward (legacy mode)', () => {
    expect(
      isLpCollectionEnabled({
        ...baseConfig,
        pools: [
          { address: '0xa', price: {} },
          {
            address: '0xb',
            price: {},
            collectLpReward: {
              redeemFirst: TokenToCollect.QUOTE,
              minAmountQuote: 0,
              minAmountCollateral: 0,
            },
          },
        ],
      })
    ).to.be.true;
  });
});
