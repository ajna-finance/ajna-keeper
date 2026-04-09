import { Signer, FungiblePool } from '@ajna-finance/sdk';
import { weiToDecimaled } from './utils';
import { LiquiditySource } from './config-types';
import { logger } from './logging';
import { BigNumber } from 'ethers';
import {
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from './take-types';
import {
  ExternalTakeAdapter,
  formatTakeStrategyLog,
  getTakeBorrowerCandidates,
  logSkippedTakeCandidate,
  processTakeCandidates,
} from './take-engine';
import {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryTakeParams,
  createFactoryQuoteProviderRuntimeCache,
} from './take-factory/shared';
import {
  evaluateCurveFactoryQuote,
  executeCurveFactoryTake,
} from './take-factory/curve';
import {
  evaluateSushiSwapFactoryQuote,
  executeSushiSwapFactoryTake,
} from './take-factory/sushiswap';
import {
  evaluateUniswapV3FactoryQuote,
  executeUniswapV3FactoryTake,
} from './take-factory/uniswap';

type LiquidationToTake = TakeLiquidationPlan;

export type {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryTakeParams,
} from './take-factory/shared';
export {
  computeFactoryAmountOutMinimum,
  createFactoryQuoteProviderRuntimeCache,
} from './take-factory/shared';

/**
 * Handle takes using factory pattern (Uniswap V3, future DEXs)
 * Completely separate from existing 1inch logic
 */
export async function handleFactoryTakes({
  signer,
  pool,
  poolConfig,
  config,
}: FactoryTakeParams) {
  logger.debug(`Factory take handler starting for pool: ${pool.name}`);
  const quoteProviderCache = createFactoryQuoteProviderRuntimeCache();
  const candidates = await getTakeBorrowerCandidates({
    subgraphUrl: config.subgraphUrl,
    poolAddress: pool.poolAddress,
    minCollateral: poolConfig.take.minCollateral ?? 0,
  });

  const externalTakeAdapter: ExternalTakeAdapter<any, any> = createFactoryTakeAdapter({
    quoteConfig: {
      universalRouterOverrides: config.universalRouterOverrides,
      sushiswapRouterOverrides: config.sushiswapRouterOverrides,
      curveRouterOverrides: config.curveRouterOverrides,
      tokenAddresses: config.tokenAddresses,
    },
    runtimeCache: quoteProviderCache,
  });

  await processTakeCandidates({
    pool,
    signer,
    poolConfig,
    candidates,
    subgraphUrl: config.subgraphUrl,
    externalTakeAdapter,
    externalExecutionConfig: {
      dryRun: config.dryRun,
      keeperTakerFactory: config.keeperTakerFactory,
      universalRouterOverrides: config.universalRouterOverrides,
      sushiswapRouterOverrides: config.sushiswapRouterOverrides,
      curveRouterOverrides: config.curveRouterOverrides,
      tokenAddresses: config.tokenAddresses,
    },
    dryRun: config.dryRun ?? false,
    delayBetweenActions: config.delayBetweenActions ?? 0,
    arbTakeActionLabel: 'Factory ArbTake',
    arbTakeLogPrefix: 'Factory: ',
    onFound: (decision) => {
      logger.debug(
        `Found liquidation to ${formatTakeStrategyLog(
          externalTakeAdapter.kind,
          decision.approvedTake,
          decision.approvedArbTake
        )} - pool: ${pool.name}, borrower: ${decision.borrower}, price: ${Number(
          weiToDecimaled(decision.auctionPrice)
        )}`
      );
    },
    onSkip: ({ candidate, reason }) => {
      logSkippedTakeCandidate({
        pool,
        borrower: candidate.borrower,
        reason,
        prefix: 'Factory: ',
      });
    },
  });
}

export function createFactoryTakeAdapter(params: {
  quoteConfig: FactoryQuoteConfig;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): ExternalTakeAdapter<TakeActionConfig, FactoryExecutionConfig> {
  return {
    kind: 'factory',
    evaluateExternalTake: async ({
      pool,
      signer,
      poolConfig,
      auctionPrice,
      collateral,
    }) =>
      getFactoryTakeQuoteEvaluation(
        pool,
        auctionPrice,
        collateral,
        poolConfig,
        params.quoteConfig,
        signer,
        params.runtimeCache
      ),
    executeExternalTake: async ({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    }) =>
      takeLiquidationFactory({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }),
  };
}

export async function getFactoryTakeQuoteEvaluation(
  pool: FungiblePool,
  auctionPriceWad: BigNumber,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Pick<
    FactoryTakeParams['config'],
    'universalRouterOverrides' | 'sushiswapRouterOverrides' | 'curveRouterOverrides' | 'tokenAddresses'
  >,
  signer: Signer,
  runtimeCache?: FactoryQuoteProviderRuntimeCache
): Promise<ExternalTakeQuoteEvaluation> {
  if (!poolConfig.take.marketPriceFactor) {
    return {
      isTakeable: false,
      reason: 'marketPriceFactor is not configured',
    };
  }

  if (!collateral.gt(0)) {
    logger.debug(`Factory: Invalid collateral amount: ${collateral.toString()} for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'collateral must be greater than zero',
    };
  }

  try {
    if (poolConfig.take.liquiditySource === LiquiditySource.UNISWAPV3) {
      return await checkUniswapV3Quote(
        pool,
        auctionPriceWad,
        collateral,
        poolConfig,
        config,
        signer,
        runtimeCache
      );
    }
    if (poolConfig.take.liquiditySource === LiquiditySource.SUSHISWAP) {
      return await checkSushiSwapQuote(
        pool,
        auctionPriceWad,
        collateral,
        poolConfig,
        config,
        signer,
        runtimeCache
      );
    }
    if (poolConfig.take.liquiditySource === LiquiditySource.CURVE) {
      return await checkCurveQuote(
        pool,
        auctionPriceWad,
        collateral,
        poolConfig,
        config,
        signer,
        runtimeCache
      );
    }

    logger.debug(`Factory: Unsupported liquidity source: ${poolConfig.take.liquiditySource}`);
    return {
      isTakeable: false,
      reason: `unsupported liquidity source ${poolConfig.take.liquiditySource}`,
    };
  } catch (error) {
    logger.error(`Factory: Failed to check takeability for pool ${pool.name}: ${error}`);
    return {
      isTakeable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * PHASE 3: Real Uniswap V3 quote check using OFFICIAL QuoterV2 contract
 * Uses the same method as Uniswap's frontend - guaranteed accurate prices
 */
async function checkUniswapV3Quote(
  pool: FungiblePool,
  auctionPriceWad: BigNumber,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Pick<FactoryTakeParams['config'], 'universalRouterOverrides'>,
  signer: Signer,
  runtimeCache?: FactoryQuoteProviderRuntimeCache
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateUniswapV3FactoryQuote({
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    config,
    signer,
    runtimeCache,
  });
}


/**
 * Check SushiSwap V3 profitability using official QuoterV2 contract
 */
async function checkSushiSwapQuote(
  pool: FungiblePool,
  auctionPriceWad: BigNumber,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Pick<FactoryTakeParams['config'], 'sushiswapRouterOverrides'>,
  signer: Signer,
  runtimeCache?: FactoryQuoteProviderRuntimeCache
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateSushiSwapFactoryQuote({
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    config,
    signer,
    runtimeCache,
  });
}

/**
 * Check Curve profitability using CurveQuoteProvider
 * FIXED: Now passes tokenAddresses for reliable pool discovery
 */
async function checkCurveQuote(
  pool: FungiblePool,
  auctionPriceWad: BigNumber,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Pick<FactoryTakeParams['config'], 'curveRouterOverrides' | 'tokenAddresses'>,
  signer: Signer,
  runtimeCache?: FactoryQuoteProviderRuntimeCache
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateCurveFactoryQuote({
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    config,
    signer,
    runtimeCache,
  });
}

/**
 * Execute external take using factory pattern
 */
export async function takeLiquidationFactory({
  pool,
  poolConfig,
  signer,
  liquidation,
  config,
}: {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: LiquidationToTake;
  config: Pick<FactoryTakeParams['config'], 'dryRun' | 'keeperTakerFactory' | 'universalRouterOverrides' | 'sushiswapRouterOverrides' | 'curveRouterOverrides' | 'tokenAddresses' >;
}) {
  
  const { borrower } = liquidation;
  const { dryRun, keeperTakerFactory } = config;

  if (dryRun) {
    logger.info(
      `DryRun - would Factory Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower} using ${poolConfig.take.liquiditySource}`
    );
    return;
  }

  if (!keeperTakerFactory) {
    logger.error('Factory: keeperTakerFactory address not configured');
    return;
  }

  const externalTakeQuoteEvaluation =
    liquidation.externalTakeQuoteEvaluation ??
    (await getFactoryTakeQuoteEvaluation(
      pool,
      liquidation.auctionPrice,
      liquidation.collateral,
      poolConfig,
      config,
      signer
    ));

  if (!externalTakeQuoteEvaluation.isTakeable) {
    logger.error(
      `Factory: Take quote no longer satisfies execution policy for ${pool.name}/${borrower}: ${externalTakeQuoteEvaluation.reason ?? 'not takeable'}`
    );
    return;
  }

  if (!externalTakeQuoteEvaluation.quoteAmountRaw) {
    logger.error(
      `Factory: Missing raw quote amount for ${pool.name}/${borrower}; refusing to send an unbounded swap`
    );
    return;
  }

  if (poolConfig.take.liquiditySource === LiquiditySource.UNISWAPV3) {
    await takeWithUniswapV3Factory({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation: externalTakeQuoteEvaluation,
      config,
    });
  } else if (poolConfig.take.liquiditySource === LiquiditySource.SUSHISWAP) {
  await takeWithSushiSwapFactory({
    pool,
    poolConfig,
    signer,
    liquidation,
    quoteEvaluation: externalTakeQuoteEvaluation,
    config,
  });
  } else if (poolConfig.take.liquiditySource === LiquiditySource.CURVE) {
  await takeWithCurveFactory({
    pool,
    poolConfig,
    signer,
    liquidation,
    quoteEvaluation: externalTakeQuoteEvaluation,
    config,
  });
  } else {
    logger.error(`Factory: Unsupported liquidity source: ${poolConfig.take.liquiditySource}`);
  }
}

/**
 * FIXED: Execute Uniswap V3 take via factory
 * Now follows 1inch pattern - sends WAD amounts to smart contract
 */
async function takeWithUniswapV3Factory({
  pool,
  poolConfig,
  signer,
  liquidation,
  quoteEvaluation,
  config,
}: {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: LiquidationToTake;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  config: Pick<FactoryTakeParams['config'], 'keeperTakerFactory' | 'universalRouterOverrides'>;
}) {
  await executeUniswapV3FactoryTake({
    pool,
    poolConfig,
    signer,
    liquidation,
    quoteEvaluation,
    config,
  });
}




/**
 * Execute SushiSwap take via factory
 */

/**
 * FIXED: Execute SushiSwap take via factory  
 * Now follows 1inch pattern - sends WAD amounts to smart contract
 */
async function takeWithSushiSwapFactory({
  pool,
  poolConfig,
  signer,
  liquidation,
  quoteEvaluation,
  config,
}: {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: LiquidationToTake;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  config: Pick<FactoryTakeParams['config'], 'keeperTakerFactory' | 'sushiswapRouterOverrides'>;
}) {
  await executeSushiSwapFactoryTake({
    pool,
    poolConfig,
    signer,
    liquidation,
    quoteEvaluation,
    config,
  });
}

/**
 * Execute Curve take via factory
 * FIXED: Now uses the same address→symbol→config lookup pattern as working Phase 1
 */
async function takeWithCurveFactory({
  pool,
  poolConfig,
  signer,
  liquidation,
  quoteEvaluation,
  config,
}: {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: LiquidationToTake;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  config: Pick<FactoryTakeParams['config'], 'keeperTakerFactory' | 'curveRouterOverrides' | 'tokenAddresses'>;
}) {
  await executeCurveFactoryTake({
    pool,
    poolConfig,
    signer,
    liquidation,
    quoteEvaluation,
    config,
  });
}
