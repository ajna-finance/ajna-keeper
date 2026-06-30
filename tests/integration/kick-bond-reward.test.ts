import './subgraph-mock';
import { AjnaSDK, ERC20Pool__factory, FungiblePool } from '@ajna-finance/sdk';
import { constants, Wallet } from 'ethers';
import { expect } from 'chai';
import { configureAjna } from '../../src/config';
import { MAINNET_CONFIG } from './test-config';
import { getProvider, resetHardhat, increaseTime } from './test-utils';
import {
  createFundedQuoteWallet,
  depositQuoteToken,
  drawDebt,
} from './loan-helpers';
import {
  makeGetLoansFromSdk,
  overrideGetLoans,
  makeGetLiquidationsFromSdk,
  overrideGetLiquidations,
  makeGetHighestMeaningfulBucket,
  overrideGetHighestMeaningfulBucket,
  makeGetBucketTakeLPAwardsFromSdk,
  overrideGetBucketTakeLPAwards,
} from './subgraph-mock';
import { getLoansToKick, kick } from '../../src/kick';
import { arbTakeLiquidation } from '../../src/take/arb';
import { arrayFromAsync, decimaledToWei, weiToDecimaled } from '../../src/utils';
import { SECONDS_PER_YEAR, SECONDS_PER_DAY } from '../../src/constants';
import { NonceTracker } from '../../src/nonce';

const POOL = MAINNET_CONFIG.SOL_WETH_POOL;

async function createKickedAuction(): Promise<{
  pool: FungiblePool;
  kicker: Wallet;
  borrower: string;
}> {
  configureAjna(MAINNET_CONFIG.AJNA_CONFIG);
  const pool: FungiblePool = await new AjnaSDK(
    getProvider()
  ).fungiblePoolFactory.getPoolByAddress(POOL.poolConfig.address);
  overrideGetLoans(makeGetLoansFromSdk(pool));
  overrideGetLiquidations(makeGetLiquidationsFromSdk(pool));
  overrideGetHighestMeaningfulBucket(makeGetHighestMeaningfulBucket(pool));
  overrideGetBucketTakeLPAwards(makeGetBucketTakeLPAwardsFromSdk(pool));

  await depositQuoteToken({
    pool,
    owner: POOL.quoteWhaleAddress,
    amount: 1,
    price: 0.07,
  });
  await drawDebt({
    pool,
    owner: POOL.collateralWhaleAddress,
    amountToBorrow: 0.9,
    collateralToPledge: 14,
  });
  // Interest accrual pushes TP above LUP -> the loan becomes kickable.
  await increaseTime(SECONDS_PER_YEAR * 2);

  const [loanToKick] = await arrayFromAsync(
    getLoansToKick({
      pool,
      poolConfig: POOL.poolConfig,
      config: { subgraphUrl: '', coinGeckoApiKey: '' },
    })
  );
  expect(loanToKick, 'loan should be kickable').to.not.equal(undefined);
  const kicker = await createFundedQuoteWallet(
    decimaledToWei(2),
    POOL.quoteAddress
  );
  await kick({ pool, signer: kicker, loanToKick, config: { dryRun: false } });
  NonceTracker.clearNonces();
  return { pool, kicker, borrower: POOL.collateralWhaleAddress };
}

// The kicker's reward/penalty is determined by the BUCKET price the take clears
// into vs the auction neutralPrice (TakerActions._prepareTake feeds bucketPrice
// into _bpf; isRewarded <=> bucketPrice <= NP). This drives an arbTake into a
// bucket below (rewarded) or above (penalized) NP via the low-level executor
// (arbTakeLiquidation does NOT apply the keeper's self-kick NP cap), proving the
// on-chain bond behavior the P2 cap is built to protect.
async function arbTakeRelativeToNp(rewarded: boolean): Promise<void> {
  const { pool, kicker, borrower } = await createKickedAuction();
  const kickerAddr = await kicker.getAddress();

  const auctionInfo = await pool.contract.auctionInfo(borrower);
  const np = Number(weiToDecimaled(auctionInfo.neutralPrice_));
  expect(np).to.be.greaterThan(0);

  // Seed a deposit bucket below (rewarded) or above (penalized) NP and take into it.
  const targetBucket = pool.getBucketByPrice(
    decimaledToWei(rewarded ? np * 0.95 : np * 1.05)
  );
  const bucketIndex = targetBucket.index;
  const bucketPriceWad = targetBucket.price;
  await depositQuoteToken({
    pool,
    owner: POOL.quoteWhaleAddress,
    amount: 2,
    price: Number(weiToDecimaled(bucketPriceWad)),
  });
  NonceTracker.clearNonces();

  const { locked: lockedBefore } = await pool.kickerInfo(kickerAddr);
  expect(lockedBefore.gt(constants.Zero), 'bond locked after kick').to.be.true;

  // Warp until the Dutch auction price decays below the target bucket price so
  // the bucketTake clears (otherwise it reverts).
  let decayed = false;
  for (let i = 0; i < 240; i++) {
    const status = await pool.getLiquidation(borrower).getStatus();
    if (status.price.lt(bucketPriceWad)) {
      decayed = true;
      break;
    }
    await increaseTime(SECONDS_PER_DAY);
  }
  expect(decayed, 'auction price should decay below the target bucket').to.be
    .true;

  await arbTakeLiquidation({
    pool,
    signer: kicker,
    liquidation: { borrower, hpbIndex: bucketIndex },
    config: { dryRun: false },
  });
  NonceTracker.clearNonces();

  const poolContract = ERC20Pool__factory.connect(
    pool.poolAddress,
    getProvider()
  );
  const awards = await poolContract.queryFilter(
    poolContract.filters.BucketTakeLPAwarded(null, kickerAddr),
    MAINNET_CONFIG.BLOCK_NUMBER
  );
  expect(awards.length, 'a BucketTakeLPAwarded event was emitted').to.be.greaterThan(
    0
  );
  const { lpAwardedKicker } = awards[awards.length - 1].args;
  const { locked: lockedAfter } = await pool.kickerInfo(kickerAddr);

  if (rewarded) {
    // bucketPrice <= NP: kicker is rewarded with bucket LP and the bond is NOT
    // decremented (the reward is LP, not a locked-bond change).
    expect(lpAwardedKicker.gt(constants.Zero), 'kicker LP credited').to.be.true;
    expect(
      lockedAfter.eq(lockedBefore),
      'locked bond unchanged (reward is LP, not a bond change)'
    ).to.be.true;
  } else {
    // bucketPrice > NP: no kicker reward and the locked bond is penalized.
    expect(lpAwardedKicker.eq(constants.Zero), 'no kicker LP reward').to.be.true;
    expect(lockedAfter.lt(lockedBefore), 'locked bond penalized').to.be.true;
  }
}

describe('kick -> arbTake kicker bond: reward vs penalty (P2)', function () {
  this.timeout(600000);
  beforeEach(async () => {
    await resetHardhat();
    NonceTracker.clearNonces();
  });

  it('rewards the kicker when the take bucket price is <= NP (bond preserved + LP)', async () => {
    await arbTakeRelativeToNp(true);
  });

  it('penalizes the kicker when the take bucket price is > NP (locked bond reduced)', async () => {
    await arbTakeRelativeToNp(false);
  });
});
