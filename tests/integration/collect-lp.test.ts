import { AjnaSDK, FungiblePool } from '@ajna-finance/sdk';

import { expect } from 'chai';
import { BigNumber, Wallet, constants, utils } from 'ethers';
import { RewardActionTracker } from '../../src/rewards';
import { makeSinglePoolLpCollector } from './lp-test-helpers';

import { configureAjna, TokenToCollect } from '../../src/config';
import { decimaledToWei } from '../../src/utils';
import { DexRouter } from '../../src/dex/router';
import { getBalanceOfErc20 } from '../../src/erc20';
import { handleKicks } from '../../src/kick';
import { NonceTracker } from '../../src/nonce';
import { processManualTakeCandidates, handleTakes } from '../../src/take';
import { depositQuoteToken, drawDebt } from './loan-helpers';
import './subgraph-mock';
import {
  makeGetBucketTakeLPAwardsFromSdk,
  makeGetHighestMeaningfulBucket,
  makeGetLiquidationsFromSdk,
  makeGetLoansFromSdk,
  overrideGetBucketTakeLPAwards,
  overrideGetHighestMeaningfulBucket,
  overrideGetLiquidations,
  overrideGetLoans,
} from './subgraph-mock';
import { createSubgraphReader } from '../../src/read-transports';
import { MAINNET_CONFIG, USER1_MNEMONIC } from './test-config';
import {
  getProvider,
  impersonateSigner,
  increaseTime,
  mine,
  resetHardhat,
} from './test-utils';
import { SECONDS_PER_YEAR, SECONDS_PER_DAY } from '../../src/constants';

const setup = async () => {
  configureAjna(MAINNET_CONFIG.AJNA_CONFIG);
  const ajna = new AjnaSDK(getProvider());
  const pool: FungiblePool = await ajna.fungiblePoolFactory.getPoolByAddress(
    MAINNET_CONFIG.SOL_WETH_POOL.poolConfig.address
  );
  overrideGetLoans(makeGetLoansFromSdk(pool));
  overrideGetLiquidations(makeGetLiquidationsFromSdk(pool));
  overrideGetHighestMeaningfulBucket(makeGetHighestMeaningfulBucket(pool));
  overrideGetBucketTakeLPAwards(makeGetBucketTakeLPAwardsFromSdk(pool));
  await depositQuoteToken({
    pool,
    owner: MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress,
    amount: 1,
    price: 0.07,
  });
  await drawDebt({
    pool,
    owner: MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress,
    amountToBorrow: 0.9,
    collateralToPledge: 14,
  });
  await increaseTime(SECONDS_PER_YEAR * 2);
  const signer = await impersonateSigner(
    MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2
  );
  await handleKicks({
    pool,
    poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
    signer,
    config: {
      dryRun: false,
      subgraphUrl: '',
      coinGeckoApiKey: '',
    },
  });
  await increaseTime(SECONDS_PER_DAY * 1.5);
  return pool;
};

describe('LpCollector ingest', () => {
  beforeEach(async () => {
    await resetHardhat();
  });

  it('Tracks taker reward after BucketTake', async () => {
    const pool = await setup();
    const signer = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress2
    );
    const dexRouter = new DexRouter(signer);
    const lpCollector = makeSinglePoolLpCollector(
      pool,
      signer,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
      {},
      new RewardActionTracker(
        signer,
        {
          uniswapOverrides: {
            wethAddress: MAINNET_CONFIG.WETH_ADDRESS,
            uniswapV3Router: MAINNET_CONFIG.UNISWAP_V3_ROUTER,
          },
          manual: {
            pools: [],
          },
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );
    await processManualTakeCandidates({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer,
      config: {
        dryRun: false,
        subgraphUrl: '',
      },
    });
    await lpCollector.ingestNewAwardsFromSubgraph();
    const entries = Array.from(lpCollector.lpMap.entries());
    const rewardLp: BigNumber | undefined = entries?.[0]?.[1];
    expect(!!rewardLp && rewardLp.gt(constants.Zero)).to.be.true;
  });

  it('Does not track bucket takes of other users', async () => {
    const pool = await setup();
    const wallet = Wallet.fromMnemonic(USER1_MNEMONIC);
    const noActionSigner = wallet.connect(getProvider());
    const dexRouter = new DexRouter(noActionSigner);
    const lpCollector = makeSinglePoolLpCollector(
      pool,
      noActionSigner,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
      {},
      new RewardActionTracker(
        noActionSigner,
        {
          uniswapOverrides: {
            wethAddress: MAINNET_CONFIG.WETH_ADDRESS,
            uniswapV3Router: MAINNET_CONFIG.UNISWAP_V3_ROUTER,
          },
          manual: {
            pools: [],
          },
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );
    const takerSigner = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2
    );
    await processManualTakeCandidates({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer: takerSigner,
      config: {
        dryRun: false,
        subgraphUrl: '',
      },
    });
    await lpCollector.ingestNewAwardsFromSubgraph();
    const entries = Array.from(lpCollector.lpMap.entries());
    expect(entries.length).equals(0);
  });

  it('Tracks rewards for kicker', async () => {
    const pool = await setup();
    const kickerSigner = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2
    );
    const dexRouter = new DexRouter(kickerSigner);
    const lpCollector = makeSinglePoolLpCollector(
      pool,
      kickerSigner,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
      {},
      new RewardActionTracker(
        kickerSigner,
        {
          uniswapOverrides: {
            wethAddress: MAINNET_CONFIG.WETH_ADDRESS,
            uniswapV3Router: MAINNET_CONFIG.UNISWAP_V3_ROUTER,
          },
          manual: {
            pools: [],
          },
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );
    const takerSigner = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress2
    );
    await processManualTakeCandidates({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer: takerSigner,
      config: {
        dryRun: false,
        subgraphUrl: '',
      },
    });
    await lpCollector.ingestNewAwardsFromSubgraph();
    const entries = Array.from(lpCollector.lpMap.entries());
    const rewardLp: BigNumber | undefined = entries?.[0]?.[1];
    expect(!!rewardLp && rewardLp.gt(constants.Zero)).to.be.true;
  });
});

describe('LpCollector collections', () => {
  beforeEach(async () => {
    await resetHardhat();
  });

  // TODO: Refactor this into two tests, one redeeming quote first and another redeeming collateral first
  it('Collects tracked rewards', async () => {
    const pool = await setup();
    const signer = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2
    );
    const dexRouter = new DexRouter(signer);

    const lpCollector = makeSinglePoolLpCollector(
      pool,
      signer,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
      {},
      new RewardActionTracker(
        signer,
        {
          uniswapOverrides: {
            wethAddress: MAINNET_CONFIG.WETH_ADDRESS,
            uniswapV3Router: MAINNET_CONFIG.UNISWAP_V3_ROUTER,
          },
          manual: {
            pools: [],
          },
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );
    await processManualTakeCandidates({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer,
      config: {
        dryRun: false,
        subgraphUrl: '',
      },
    });
    const liquidation = pool.getLiquidation(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress
    );
    const settleTx = await liquidation.settle(signer);
    await settleTx.verifyAndSubmit();
    await NonceTracker.getNonce(signer);

    const balanceBeforeCollection = await getBalanceOfErc20(
      signer,
      pool.quoteAddress
    );
    await lpCollector.collectLpRewards();
    const balanceAfterCollection = await getBalanceOfErc20(
      signer,
      pool.quoteAddress
    );
    expect(balanceAfterCollection.gt(balanceBeforeCollection)).to.be.true;
  });

  it('prunes stale entries on cold-start replay after rewards were already redeemed', async () => {
    // Simulates keeper restart: first run accrues + redeems LP, then a fresh
    // LpCollector instance replays the full history from cursor '0'. The new
    // collector must NOT re-redeem rewards that are already gone (lpBalance=0);
    // the zero-balance prune should drop stale entries on the first sweep so
    // the lpMap is empty at the end.
    const pool = await setup();
    const signer = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2
    );
    const dexRouter = new DexRouter(signer);

    const makeCollector = () =>
      makeSinglePoolLpCollector(
        pool,
        signer,
        {
          redeemFirst: TokenToCollect.QUOTE,
          minAmountQuote: 0,
          minAmountCollateral: 0,
        },
        {},
        new RewardActionTracker(
          signer,
          {
            uniswapOverrides: {
              wethAddress: MAINNET_CONFIG.WETH_ADDRESS,
              uniswapV3Router: MAINNET_CONFIG.UNISWAP_V3_ROUTER,
            },
            manual: {
              pools: [],
            },
          } as any,
          dexRouter
        ),
        createSubgraphReader({ subgraphUrl: 'mock://' })
      );

    // First keeper run: accrue rewards via bucketTake, settle, redeem.
    const firstRun = makeCollector();
    await processManualTakeCandidates({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer,
      config: {
        dryRun: false,
        subgraphUrl: '',
      },
    });
    const liquidation = pool.getLiquidation(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress
    );
    const settleTx = await liquidation.settle(signer);
    await settleTx.verifyAndSubmit();
    await NonceTracker.getNonce(signer);
    await firstRun.collectLpRewards();

    // Simulated cold start: construct a brand-new collector, which replays
    // history with cursor='0'. The subgraph returns the same BucketTake
    // events but the signer's on-chain lpBalance is now 0.
    //
    // Respect the facade's pick-one contract: ingest once, sweep directly
    // via `redeemer.sweep()` (not `collectLpRewards()`, which would ingest
    // a second time).
    const secondRun = makeCollector();
    await secondRun.ingestNewAwardsFromSubgraph();
    // Guard: the test is only meaningful if ingest actually replayed
    // events. Without this pre-check, `lpMap.size === 0` at the end would
    // also pass trivially if the mock returned zero events.
    expect(secondRun.lpMap.size).to.be.greaterThan(0);

    await secondRun.redeemer.sweep();

    // The stale reward should have been pruned via the lpBalance=0 path in
    // collectLpRewardFromBucket, leaving lpMap empty.
    expect(secondRun.lpMap.size).to.equal(0);
  });

  // P1-4 money-safety: LP redemption must NEVER burn lender PRINCIPAL — only the
  // accrued reward. The collector trusts the subgraph's reported reward amount
  // and does no on-chain validation of it, so a STALE (cold-start replay) or
  // INFLATED reward row reporting more LP than was actually earned must not let
  // the sweep redeem the signer's principal deposit in that bucket. (Reachable
  // when the keeper signer also lends from the same hot wallet.)
  it('does not burn lender principal when an inflated/stale BucketTake reward is reported for a bucket the signer also lent into', async () => {
    // No active auction here (a kicked auction with a decayed ~0 price would
    // reject any addQuoteToken as AddAboveAuctionPrice). This test is purely
    // about the LP sweep, so a clean pool + a principal deposit is enough.
    configureAjna(MAINNET_CONFIG.AJNA_CONFIG);
    const ajna = new AjnaSDK(getProvider());
    const pool: FungiblePool =
      await ajna.fungiblePoolFactory.getPoolByAddress(
        MAINNET_CONFIG.SOL_WETH_POOL.poolConfig.address
      );
    const signerAddress = MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress2;
    const signer = await impersonateSigner(signerAddress);

    // The signer deposits PRINCIPAL into a deep bucket — a clean quote-only,
    // fully-redeemable position.
    const principalPrice = 0.04;
    await depositQuoteToken({
      pool,
      owner: signerAddress,
      amount: 0.5,
      price: principalPrice,
    });
    const bucket = await pool.getBucketByPrice(decimaledToWei(principalPrice));
    const principalLp = (await bucket.getPosition(signerAddress)).lpBalance;
    expect(principalLp.gt(constants.Zero)).to.be.true; // precondition: has principal

    // Report a reward strictly SMALLER than the signer's LP balance (one fifth),
    // so the line-514 "clamp to lpBalance" does NOT fire — this is the cleanly
    // fixable case: the redemption must consume at most the reported reward, not
    // the whole position. (A reward > balance is an inherent fungibility limit:
    // on-chain LP can't be split into principal vs reward — documented, not
    // fixed here.)
    const reportedRewardLp = principalLp.div(5);
    overrideGetBucketTakeLPAwards(async (_subgraphUrl, sa) => {
      if (sa.toLowerCase() !== signerAddress.toLowerCase()) {
        return { bucketTakes: [] };
      }
      return {
        bucketTakes: [
          {
            id: '0xstalereward000000000000000000000000000000000000000000000000000001',
            index: bucket.index,
            taker: signerAddress.toLowerCase(),
            pool: { id: pool.poolAddress.toLowerCase() },
            lpAwarded: {
              lpAwardedTaker: utils.formatUnits(reportedRewardLp, 18),
              lpAwardedKicker: '0',
              kicker: constants.AddressZero,
            },
            blockTimestamp: '1',
          },
        ],
      };
    });

    const dexRouter = new DexRouter(signer);
    const lpCollector = makeSinglePoolLpCollector(
      pool,
      signer,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
      {},
      new RewardActionTracker(
        signer,
        {
          uniswapOverrides: {
            wethAddress: MAINNET_CONFIG.WETH_ADDRESS,
            uniswapV3Router: MAINNET_CONFIG.UNISWAP_V3_ROUTER,
          },
          manual: { pools: [] },
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );

    await lpCollector.ingestNewAwardsFromSubgraph();
    // Precondition: the reward was actually credited (else the test would pass
    // trivially without exercising the redemption path).
    const credited = lpCollector.lpMap.get(bucket.index);
    expect(!!credited && credited.gt(constants.Zero)).to.be.true;

    // depositQuoteToken leaves the NonceTracker one ahead of chain (its trailing
    // getNonce allocates an unused slot via a separate wallet instance). Settle
    // the deposit and clear the cache so the sweep reads the true chain nonce —
    // otherwise the withdrawal tx nonce-fails and the assertion passes vacuously.
    await mine();
    NonceTracker.clearNonces();

    await lpCollector.redeemer.sweep();

    const principalLpAfter = (await bucket.getPosition(signerAddress)).lpBalance;
    const lpConsumed = principalLp.sub(principalLpAfter);
    // MONEY-SAFETY INVARIANT: the sweep must consume at most the REPORTED reward
    // LP — never reach into principal. Allow a 1-wei rounding slack on the LP
    // math. (Current code redeems min(depositRedeemable, deposit) = the whole
    // position, so lpConsumed == principalLp >> reportedRewardLp and this fails.)
    expect(
      lpConsumed.lte(reportedRewardLp.add(1)),
      `sweep consumed more LP than the reported reward (burned principal): ` +
        `consumed=${lpConsumed.toString()} reportedReward=${reportedRewardLp.toString()} ` +
        `principalBefore=${principalLp.toString()} after=${principalLpAfter.toString()}`
    ).to.be.true;
  });
});
