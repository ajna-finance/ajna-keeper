import { AjnaSDK, FungiblePool } from '@ajna-finance/sdk';

import { expect } from 'chai';
import { BigNumber, Wallet, constants } from 'ethers';
import { RewardActionTracker } from '../rewards';
import { makeSinglePoolLpCollector } from './lp-test-helpers';

import { configureAjna, TokenToCollect } from '../config';
import { DexRouter } from '../dex/router';
import { getBalanceOfErc20 } from '../erc20';
import { handleKicks } from '../kick';
import { NonceTracker } from '../nonce';
import { handleLegacyOrArbTakes, handleTakes } from '../take';
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
import { createSubgraphReader } from '../read-transports';
import { MAINNET_CONFIG, USER1_MNEMONIC } from './test-config';
import {
  getProvider,
  impersonateSigner,
  increaseTime,
  resetHardhat,
} from './test-utils';
import { SECONDS_PER_YEAR, SECONDS_PER_DAY } from '../constants';

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
      delayBetweenActions: 0,
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
          delayBetweenActions: 0,
          pools: [],
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );
    await handleLegacyOrArbTakes({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer,
      config: {
        dryRun: false,
        subgraphUrl: '',
        delayBetweenActions: 0,
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
          delayBetweenActions: 0,
          pools: [],
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );
    const takerSigner = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2
    );
    await handleLegacyOrArbTakes({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer: takerSigner,
      config: {
        dryRun: false,
        subgraphUrl: '',
        delayBetweenActions: 0,
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
          delayBetweenActions: 0,
          pools: [],
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );
    const takerSigner = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress2
    );
    await handleLegacyOrArbTakes({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer: takerSigner,
      config: {
        dryRun: false,
        subgraphUrl: '',
        delayBetweenActions: 0,
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
          delayBetweenActions: 0,
          pools: [],
        } as any,
        dexRouter
      ),
      createSubgraphReader({ subgraphUrl: 'mock://' })
    );
    await handleLegacyOrArbTakes({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer,
      config: {
        dryRun: false,
        subgraphUrl: '',
        delayBetweenActions: 0,
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
            delayBetweenActions: 0,
            pools: [],
          } as any,
          dexRouter
        ),
        createSubgraphReader({ subgraphUrl: 'mock://' })
      );

    // First keeper run: accrue rewards via bucketTake, settle, redeem.
    const firstRun = makeCollector();
    await handleLegacyOrArbTakes({
      pool,
      poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
      signer,
      config: {
        dryRun: false,
        subgraphUrl: '',
        delayBetweenActions: 0,
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
    const secondRun = makeCollector();
    await secondRun.ingestNewAwardsFromSubgraph();
    // Guard: the test is only meaningful if ingest actually replayed events.
    // Without this pre-check, `lpMap.size === 0` at the end would also pass
    // trivially if the mock returned zero events for any reason.
    expect(secondRun.lpMap.size).to.be.greaterThan(0);

    await secondRun.collectLpRewards();

    // The stale reward should have been pruned via the lpBalance=0 path in
    // collectLpRewardFromBucket, leaving lpMap empty.
    expect(secondRun.lpMap.size).to.equal(0);
  });
});
