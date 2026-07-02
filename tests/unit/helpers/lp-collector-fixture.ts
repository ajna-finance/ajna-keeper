import { BigNumber, constants } from 'ethers';
import sinon from 'sinon';
import { makeSinglePoolLpCollector } from '../../helpers/rewards';
import { CollectLpRewardSettings, TokenToCollect } from '../../../src/config';

export const FAKE_POOL_ADDRESS = '0xpool';

export function makeFakeBucket(position: {
  lpBalance: BigNumber;
  depositRedeemable?: BigNumber;
  collateralRedeemable?: BigNumber;
  deposit?: BigNumber;
  collateral?: BigNumber;
}) {
  return {
    getStatus: sinon.stub().resolves({
      deposit: position.deposit ?? constants.Zero,
      collateral: position.collateral ?? constants.Zero,
    }),
    getPosition: sinon.stub().resolves({
      lpBalance: position.lpBalance,
      depositRedeemable: position.depositRedeemable ?? constants.Zero,
      collateralRedeemable: position.collateralRedeemable ?? constants.Zero,
    }),
    // These fakes model a 1:1 LP<->token bucket, matching how the fixtures
    // construct positions (lpBalance == deposit == depositRedeemable). The
    // redemption now bounds its first leg to the reward's token-equivalent
    // (lpToQuoteTokens/lpToCollateral of rewardLp), so these must convert
    // faithfully rather than collapse to zero (which would skip every redeem).
    lpToQuoteTokens: sinon.stub().callsFake(async (lp: BigNumber) => lp),
    lpToCollateral: sinon.stub().callsFake(async (lp: BigNumber) => lp),
  };
}

export function makeBucketPosition(position: {
  lpBalance: BigNumber;
  depositRedeemable?: BigNumber;
  collateralRedeemable?: BigNumber;
}) {
  return {
    lpBalance: position.lpBalance,
    depositRedeemable: position.depositRedeemable ?? constants.Zero,
    collateralRedeemable: position.collateralRedeemable ?? constants.Zero,
  };
}

export function setBucketPositionSequence(
  bucket: ReturnType<typeof makeFakeBucket>,
  positions: Array<Parameters<typeof makeBucketPosition>[0]>
) {
  positions.forEach((position, index) => {
    bucket.getPosition.onCall(index).resolves(makeBucketPosition(position));
  });
}

/**
 * Test facade for a single fake pool. Wraps `makeSinglePoolLpCollector`
 * with the fake-pool / fake-signer construction and `pool.id`
 * auto-injection that unit-test fixtures need. Keeps the old
 * `LpCollector`-shaped API (`lpMap`, `ingestNewAwardsFromSubgraph`,
 * `collectLpRewards`) so existing tests need no per-test rewiring.
 */
export function makeCollector(opts: {
  signerAddress: string;
  getBucketTakeLPAwards: sinon.SinonStub;
  bucket?: ReturnType<typeof makeFakeBucket>;
  settings?: CollectLpRewardSettings;
  exchangeTracker?: { addToken: sinon.SinonStub };
  runtime?: {
    logLevel: string;
    delayBetweenRuns: number;
    dryRun: boolean;
  };
}) {
  const fakePool: any = {
    poolAddress: FAKE_POOL_ADDRESS,
    name: 'TEST',
    quoteAddress: '0xquote',
    collateralAddress: '0xcollat',
    collateralSymbol: 'TCOL',
    getBucketByIndex: sinon
      .stub()
      .returns(opts.bucket ?? makeFakeBucket({ lpBalance: constants.Zero })),
  };
  const fakeSigner: any = {
    getAddress: sinon.stub().resolves(opts.signerAddress),
  };
  // Wrap the caller-supplied stub so events without `pool` get a synthetic
  // `pool.id = FAKE_POOL_ADDRESS`. Production events always have `pool`;
  // unit-test fixtures omit it for brevity.
  const wrappedGetAwards = async (...args: any[]) => {
    const result = await opts.getBucketTakeLPAwards(...args);
    if (result && Array.isArray(result.bucketTakes)) {
      return {
        ...result,
        bucketTakes: result.bucketTakes.map((t: any) =>
          t && !t.pool ? { ...t, pool: { id: FAKE_POOL_ADDRESS } } : t
        ),
      };
    }
    return result;
  };
  const fakeSubgraph: any = { getBucketTakeLPAwards: wrappedGetAwards };
  const fakeTracker: any = opts.exchangeTracker ?? { addToken: sinon.stub() };

  return makeSinglePoolLpCollector(
    fakePool,
    fakeSigner,
    opts.settings ?? {
      redeemFirst: TokenToCollect.QUOTE,
      minAmountQuote: 0,
      minAmountCollateral: 0,
    },
    {
      runtime: {
        logLevel: 'debug',
        delayBetweenRuns: 0,
        dryRun: false,
        ...opts.runtime,
      },
    },
    fakeTracker,
    fakeSubgraph
  );
}
