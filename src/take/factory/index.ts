import { Signer, FungiblePool } from '@ajna-finance/sdk';
import { weiToDecimaled } from '../../utils';
import { LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { BigNumber } from 'ethers';
import {
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import {
  ExternalTakeAdapter,
  formatTakeStrategyLog,
  getTakeBorrowerCandidates,
  logSkippedTakeCandidate,
  processTakeCandidates,
} from '../engine';
import { resolveSubgraphConfig } from '../../read-transports';
import {
  FactoryExecutionConfig,
  FactoryTakeConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryTakeParams,
  createFactoryQuoteProviderRuntimeCache,
} from './shared';
import {
  evaluateCurveFactoryQuote,
  executeCurveFactoryTake,
} from './curve';
import {
  evaluateSushiSwapFactoryQuote,
  executeSushiSwapFactoryTake,
} from './sushiswap';
import {
  evaluateUniswapV3FactoryQuote,
  executeUniswapV3FactoryTake,
} from './uniswap';

type LiquidationToTake = TakeLiquidationPlan;

export type {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryTakeParams,
} from './shared';
export {
  computeFactoryAmountOutMinimum,
  createFactoryQuoteProviderRuntimeCache,
} from './shared';

/**
 * Handle takes using factory pattern (Uniswap V3, future DEXs)
 * Completely separate from existing 1inch logic
 */
export async function handleFactoryTakes({
  signer,
  takeWriteTransport,
  pool,
  poolConfig,
  config,
}: FactoryTakeParams) {
  const resolvedConfig: FactoryTakeConfig = resolveSubgraphConfig(config);
  logger.debug(`Factory take handler starting for pool: ${pool.name}`);
  const quoteProviderCache = createFactoryQuoteProviderRuntimeCache();
  const candidates = await getTakeBorrowerCandidates({
    subgraph: resolvedConfig.subgraph,
    poolAddress: pool.poolAddress,
    minCollateral: poolConfig.take.minCollateral ?? 0,
  });

  const externalTakeAdapter: ExternalTakeAdapter<any, any> = createFactoryTakeAdapter({
    quoteConfig: {
      universalRouterOverrides: resolvedConfig.universalRouterOverrides,
      sushiswapRouterOverrides: resolvedConfig.sushiswapRouterOverrides,
      curveRouterOverrides: resolvedConfig.curveRouterOverrides,
      tokenAddresses: resolvedConfig.tokenAddresses,
    },
    runtimeCache: quoteProviderCache,
  });

  await processTakeCandidates({
    pool,
    signer,
    poolConfig,
    candidates,
    subgraph: resolvedConfig.subgraph,
    externalTakeAdapter,
    externalExecutionConfig: {
      dryRun: resolvedConfig.dryRun,
      keeperTakerFactory: resolvedConfig.keeperTakerFactory,
      universalRouterOverrides: resolvedConfig.universalRouterOverrides,
      sushiswapRouterOverrides: resolvedConfig.sushiswapRouterOverrides,
      curveRouterOverrides: resolvedConfig.curveRouterOverrides,
      tokenAddresses: resolvedConfig.tokenAddresses,
      takeWriteTransport,
    },
    dryRun: resolvedConfig.dryRun ?? false,
    delayBetweenActions: resolvedConfig.delayBetweenActions ?? 0,
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

function failFactoryTakeExecution(message: string): false {
  logger.error(message);
  return false;
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
  config: Pick<
    FactoryTakeParams['config'],
    'dryRun' | 'keeperTakerFactory' | 'universalRouterOverrides' | 'sushiswapRouterOverrides' | 'curveRouterOverrides' | 'tokenAddresses'
  > & { takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'] };
}): Promise<boolean> {
  const { borrower } = liquidation;
  const { dryRun, keeperTakerFactory } = config;

  if (dryRun) {
    logger.info(
      `DryRun - would Factory Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower} using ${poolConfig.take.liquiditySource}`
    );
    return true;
  }

  if (!keeperTakerFactory) {
    return failFactoryTakeExecution(
      'Factory: keeperTakerFactory address not configured'
    );
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
    return failFactoryTakeExecution(
      `Factory: Take quote no longer satisfies execution policy for ${pool.name}/${borrower}: ${externalTakeQuoteEvaluation.reason ?? 'not takeable'}`
    );
  }

  if (!externalTakeQuoteEvaluation.quoteAmountRaw) {
    return failFactoryTakeExecution(
      `Factory: Missing raw quote amount for ${pool.name}/${borrower}; refusing to send an unbounded swap`
    );
  }

  try {
    if (poolConfig.take.liquiditySource === LiquiditySource.UNISWAPV3) {
      await takeWithUniswapV3Factory({
        pool,
        poolConfig,
        signer,
        liquidation,
        quoteEvaluation: externalTakeQuoteEvaluation,
        config,
      });
      return true;
    }

    if (poolConfig.take.liquiditySource === LiquiditySource.SUSHISWAP) {
      await takeWithSushiSwapFactory({
        pool,
        poolConfig,
        signer,
        liquidation,
        quoteEvaluation: externalTakeQuoteEvaluation,
        config,
      });
      return true;
    }

    if (poolConfig.take.liquiditySource === LiquiditySource.CURVE) {
      await takeWithCurveFactory({
        pool,
        poolConfig,
        signer,
        liquidation,
        quoteEvaluation: externalTakeQuoteEvaluation,
        config,
      });
      return true;
    }

    return failFactoryTakeExecution(
      `Factory: Unsupported liquidity source: ${poolConfig.take.liquiditySource}`
    );
  } catch (error) {
    logger.error(
      `Factory take execution failed for ${pool.name}/${borrower}`,
      error
    );
    return false;
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
  config: Pick<FactoryTakeParams['config'], 'keeperTakerFactory' | 'universalRouterOverrides'> & { takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'] };
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
  config: Pick<FactoryTakeParams['config'], 'keeperTakerFactory' | 'sushiswapRouterOverrides'> & { takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'] };
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
  config: Pick<FactoryTakeParams['config'], 'keeperTakerFactory' | 'curveRouterOverrides' | 'tokenAddresses'> & { takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'] };
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
