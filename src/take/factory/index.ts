import { Signer, FungiblePool } from '@ajna-finance/sdk';
import { mapWithConcurrencyPreservingOrder, weiToDecimaled } from '../../utils';
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
import { createArbTakeStrategy } from '../arb-strategy';
import { resolveSubgraphConfig } from '../../read-transports';
import {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryRouteCandidate,
  FactoryRouteEvaluationContext,
  FactoryRouteSelectionOptions,
  FactoryTakeConfig,
  FactoryTakeParams,
  applyFactoryRouteProfitabilityPolicy,
  buildFactoryRouteEvaluationContext,
  createFactoryQuoteProviderRuntimeCache,
  deriveApprovedMinOutRaw,
  filterFactoryRouteCandidatesByAvailability,
  formatFactoryRouteCandidate,
  getFactoryRouteCandidates,
  orderFactoryRouteCandidates,
  recordFactoryRouteSuccess,
  selectBestFactoryRouteEvaluation,
} from './shared';
import { evaluateCurveFactoryQuote, executeCurveFactoryTake } from './curve';
import {
  evaluateSushiSwapFactoryQuote,
  executeSushiSwapFactoryTake,
} from './sushiswap';
import {
  evaluateUniswapV3FactoryQuote,
  executeUniswapV3FactoryTake,
} from './uniswap';

type LiquidationToTake = TakeLiquidationPlan;

const FACTORY_ROUTE_QUOTE_CONCURRENCY = 3;

export type {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryRouteProfitabilityContext,
  FactoryRouteSelectionOptions,
  FactoryTakeParams,
} from './shared';
export {
  computeFactoryAmountOutMinimum,
  createFactoryQuoteProviderRuntimeCache,
} from './shared';

/**
 * Handle external takes using the factory strategy while the shared candidate
 * engine independently evaluates arbTake for the same auction candidates.
 */
export async function handleFactoryTakes({
  signer,
  takeWriteTransport,
  pool,
  poolConfig,
  config,
}: FactoryTakeParams) {
  const resolvedConfig: FactoryTakeConfig = resolveSubgraphConfig(config);
  logger.debug(`Factory external take strategy starting for pool: ${pool.name}`);
  const quoteProviderCache = createFactoryQuoteProviderRuntimeCache();
  const candidates = await getTakeBorrowerCandidates({
    subgraph: resolvedConfig.subgraph,
    poolAddress: pool.poolAddress,
    minCollateral: poolConfig.take.minCollateral ?? 0,
  });

  const externalTakeAdapter = createFactoryTakeAdapter({
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
    arbTakeStrategy: createArbTakeStrategy({
      actionLabel: 'Factory ArbTake',
      logPrefix: 'Factory: ',
    }),
    externalExecutionConfig: {
      dryRun: resolvedConfig.dryRun,
      keeperTakerFactory: resolvedConfig.keeperTakerFactory,
      universalRouterOverrides: resolvedConfig.universalRouterOverrides,
      sushiswapRouterOverrides: resolvedConfig.sushiswapRouterOverrides,
      curveRouterOverrides: resolvedConfig.curveRouterOverrides,
      tokenAddresses: resolvedConfig.tokenAddresses,
      takeWriteTransport,
      runtimeCache: quoteProviderCache,
    },
    dryRun: resolvedConfig.dryRun ?? false,
    delayBetweenActions: resolvedConfig.delayBetweenActions ?? 0,
    takeWriteTransport,
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
  routeSelection?: FactoryRouteSelectionOptions;
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
        params.runtimeCache,
        params.routeSelection
      ),
    executeExternalTake: async ({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    }) => {
      const executionConfig =
        params.runtimeCache && !config.runtimeCache
          ? { ...config, runtimeCache: params.runtimeCache }
          : config;
      return takeLiquidationFactory({
        pool,
        signer,
        poolConfig,
        liquidation,
        config: executionConfig,
      });
    },
  };
}

export async function getFactoryTakeQuoteEvaluation(
  pool: FungiblePool,
  auctionPriceWad: BigNumber,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Pick<
    FactoryTakeParams['config'],
    | 'universalRouterOverrides'
    | 'sushiswapRouterOverrides'
    | 'curveRouterOverrides'
    | 'tokenAddresses'
  >,
  signer: Signer,
  runtimeCache?: FactoryQuoteProviderRuntimeCache,
  routeSelection?: FactoryRouteSelectionOptions
): Promise<ExternalTakeQuoteEvaluation> {
  if (!poolConfig.take.marketPriceFactor) {
    return {
      isTakeable: false,
      reason: 'marketPriceFactor is not configured',
    };
  }

  if (!collateral.gt(0)) {
    logger.debug(
      `Factory: Invalid collateral amount: ${collateral.toString()} for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'collateral must be greater than zero',
    };
  }

  try {
    if (
      poolConfig.take.liquiditySource === LiquiditySource.UNISWAPV3 ||
      poolConfig.take.liquiditySource === LiquiditySource.SUSHISWAP ||
      poolConfig.take.liquiditySource === LiquiditySource.CURVE
    ) {
      const routeContext = await buildFactoryRouteEvaluationContext({
        pool,
        signer,
        auctionPriceWad,
        collateral,
        marketPriceFactor: poolConfig.take.marketPriceFactor!,
        runtimeCache,
      });
      const routes = orderFactoryRouteCandidates({
        routes: getFactoryRouteCandidates({
          defaultLiquiditySource: poolConfig.take.liquiditySource,
          config,
          selection: routeSelection,
        }),
        defaultLiquiditySource: poolConfig.take.liquiditySource,
        config,
        pool,
        runtimeCache,
      });
      const routeQuoteBudget = routeSelection?.routeQuoteBudgetPerCandidate;
      let routeProfitabilityContext = routeSelection?.routeProfitabilityContext;
      const routeRejectionReasons =
        routeProfitabilityContext?.routeRejectionReasonsBySource;
      const evaluations: Array<{
        route: FactoryRouteCandidate;
        evaluation: ExternalTakeQuoteEvaluation;
      }> = [];
      const availabilityCandidateRoutes: FactoryRouteCandidate[] = [];

      for (const route of routes) {
        const rejectionReason = routeRejectionReasons?.[route.liquiditySource];
        if (rejectionReason) {
          evaluations.push({
            route,
            evaluation: {
              isTakeable: false,
              reason: rejectionReason,
              selectedLiquiditySource: route.liquiditySource,
              selectedFeeTier: route.feeTier,
            },
          });
        } else {
          availabilityCandidateRoutes.push(route);
        }
      }

      const { availableRoutes, unavailableRoutes } =
        await filterFactoryRouteCandidatesByAvailability({
          routes: availabilityCandidateRoutes,
          pool,
          signer,
          config,
          runtimeCache,
        });
      if (unavailableRoutes.length > 0) {
        logger.debug(
          `Factory: skipped unavailable routes for pool ${pool.name}: ${unavailableRoutes
            .map(
              ({ route, reason }) =>
                `${formatFactoryRouteCandidate(route)}=${reason}`
            )
            .join(', ')}`
        );
      }

      if (
        !routeProfitabilityContext &&
        routeSelection?.routeProfitabilityContextFactory
      ) {
        const availableSources = Array.from(
          new Set(availableRoutes.map((route) => route.liquiditySource))
        );
        if (availableSources.length > 0) {
          routeProfitabilityContext =
            await routeSelection.routeProfitabilityContextFactory(
              availableSources
            );
        }
      }

      const gasRejectedRoutes: FactoryRouteCandidate[] = [];
      const gasApprovedRoutes = availableRoutes.filter((route) => {
        const rejectionReason =
          routeProfitabilityContext?.routeRejectionReasonsBySource?.[
            route.liquiditySource
          ];
        if (!rejectionReason) {
          return true;
        }
        gasRejectedRoutes.push(route);
        evaluations.push({
          route,
          evaluation: {
            isTakeable: false,
            reason: rejectionReason,
            selectedLiquiditySource: route.liquiditySource,
            selectedFeeTier: route.feeTier,
          },
        });
        return false;
      });

      const availableSourceCount = new Set(
        gasApprovedRoutes.map((route) => route.liquiditySource)
      ).size;
      if (availableSourceCount > 1 && !routeProfitabilityContext) {
        return {
          isTakeable: false,
          reason:
            'route profitability context required for dynamic liquidity source selection',
        };
      }

      const routesToEvaluate =
        routeQuoteBudget !== undefined
          ? gasApprovedRoutes.slice(0, routeQuoteBudget)
          : gasApprovedRoutes;
      const skippedRoutes =
        routeQuoteBudget !== undefined &&
        gasApprovedRoutes.length > routeQuoteBudget
          ? gasApprovedRoutes.slice(routeQuoteBudget)
          : [];
      if (gasRejectedRoutes.length > 0) {
        logger.debug(
          `Factory: skipped gas-policy-rejected routes for pool ${pool.name}: ${gasRejectedRoutes
            .map(
              (route) =>
                `${formatFactoryRouteCandidate(route)}=${routeProfitabilityContext?.routeRejectionReasonsBySource?.[route.liquiditySource] ?? 'route gas policy rejected source'}`
            )
            .join(', ')}`
        );
      }
      if (skippedRoutes.length > 0) {
        logger.debug(
          `Factory: route quote budget exhausted for pool ${pool.name}; skipped routes=${skippedRoutes
            .map(formatFactoryRouteCandidate)
            .join(', ')}`
        );
      }

      const evaluateFactoryRoute = async (
        route: FactoryRouteCandidate
      ): Promise<{
        route: FactoryRouteCandidate;
        evaluation: ExternalTakeQuoteEvaluation;
      }> => {
        const rawEvaluation =
          route.liquiditySource === LiquiditySource.UNISWAPV3
            ? await checkUniswapV3Quote(
                pool,
                auctionPriceWad,
                collateral,
                poolConfig,
                config,
                signer,
                runtimeCache,
                route.feeTier,
                routeContext
              )
            : route.liquiditySource === LiquiditySource.SUSHISWAP
              ? await checkSushiSwapQuote(
                  pool,
                  auctionPriceWad,
                  collateral,
                  poolConfig,
                  config,
                  signer,
                  runtimeCache,
                  route.feeTier,
                  routeContext
                )
              : route.liquiditySource === LiquiditySource.CURVE
                ? await checkCurveQuote(
                    pool,
                    auctionPriceWad,
                    collateral,
                    poolConfig,
                    config,
                    signer,
                    runtimeCache,
                    routeContext
                  )
                : {
                    isTakeable: false,
                    reason: `unsupported route source ${route.liquiditySource}`,
                    selectedLiquiditySource: route.liquiditySource,
                  };
        const evaluation = applyFactoryRouteProfitabilityPolicy({
          evaluation: rawEvaluation,
          liquiditySource: route.liquiditySource,
          context: routeProfitabilityContext,
        });
        return { route, evaluation };
      };

      const routeEvaluationResults = await mapWithConcurrencyPreservingOrder(
        routesToEvaluate,
        FACTORY_ROUTE_QUOTE_CONCURRENCY,
        evaluateFactoryRoute
      );

      if (routeEvaluationResults.length > 1) {
        logger.debug(
          `Factory: quoted ${routeEvaluationResults.length} route(s) for pool ${pool.name} with concurrency=${Math.min(
            FACTORY_ROUTE_QUOTE_CONCURRENCY,
            routeEvaluationResults.length
          )}`
        );
      }
      evaluations.push(...routeEvaluationResults);

      const selectedRoute = selectBestFactoryRouteEvaluation({
        evaluations,
        defaultLiquiditySource: poolConfig.take.liquiditySource,
        config,
      });
      if (selectedRoute) {
        const selected = selectedRoute.evaluation;
        logger.debug(
          `Factory: selected route source=${selected.selectedLiquiditySource} feeTier=${selected.selectedFeeTier ?? 'n/a'} expectedNetProfitRaw=${selected.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} requiredOutputFloorRaw=${selected.routeProfitability?.requiredOutputFloorQuoteRaw?.toString() ?? selected.approvedMinOutRaw?.toString() ?? 'n/a'} surplusRaw=${selected.routeProfitability?.surplusOverFloorQuoteRaw?.toString() ?? 'n/a'} for pool ${pool.name}${
            skippedRoutes.length > 0 ? ' (route quote budget limited)' : ''
          }`
        );
        return selected;
      }

      const reason = [
        ...evaluations.map(
          ({ route, evaluation }) =>
            `${formatFactoryRouteCandidate(route)}=${evaluation.reason ?? 'not takeable'}`
        ),
        ...unavailableRoutes.map(
          ({ route, reason }) =>
            `${formatFactoryRouteCandidate(route)}=${reason}`
        ),
        ...skippedRoutes.map(
          (route) =>
            `${formatFactoryRouteCandidate(route)}=skipped by route quote budget`
        ),
      ].join('; ');
      return {
        isTakeable: false,
        reason: reason
          ? `no viable factory route: ${reason}`
          : 'no factory routes configured',
      };
    }

    logger.debug(
      `Factory: Unsupported liquidity source: ${poolConfig.take.liquiditySource}`
    );
    return {
      isTakeable: false,
      reason: `unsupported liquidity source ${poolConfig.take.liquiditySource}`,
    };
  } catch (error) {
    logger.error(
      `Factory: Failed to check takeability for pool ${pool.name}: ${error}`
    );
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
  runtimeCache?: FactoryQuoteProviderRuntimeCache,
  feeTier?: number,
  routeContext?: FactoryRouteEvaluationContext
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateUniswapV3FactoryQuote({
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    config,
    signer,
    runtimeCache,
    feeTier,
    routeContext,
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
  runtimeCache?: FactoryQuoteProviderRuntimeCache,
  feeTier?: number,
  routeContext?: FactoryRouteEvaluationContext
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateSushiSwapFactoryQuote({
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    config,
    signer,
    runtimeCache,
    feeTier,
    routeContext,
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
  config: Pick<
    FactoryTakeParams['config'],
    'curveRouterOverrides' | 'tokenAddresses'
  >,
  signer: Signer,
  runtimeCache?: FactoryQuoteProviderRuntimeCache,
  routeContext?: FactoryRouteEvaluationContext
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateCurveFactoryQuote({
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    config,
    signer,
    runtimeCache,
    routeContext,
  });
}

function failFactoryTakeExecution(message: string): false {
  logger.error(message);
  return false;
}

function recordExecutedFactoryRouteSuccess(params: {
  pool: FungiblePool;
  selectedLiquiditySource: LiquiditySource;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): void {
  recordFactoryRouteSuccess({
    route: {
      liquiditySource: params.selectedLiquiditySource,
      feeTier: params.quoteEvaluation.selectedFeeTier,
    },
    pool: params.pool,
    runtimeCache: params.runtimeCache,
  });
}

interface FactoryLiquidationExecutionParams {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: LiquidationToTake;
  config: Pick<
    FactoryTakeParams['config'],
    | 'dryRun'
    | 'keeperTakerFactory'
    | 'universalRouterOverrides'
    | 'sushiswapRouterOverrides'
    | 'curveRouterOverrides'
    | 'tokenAddresses'
  > & {
    takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'];
    runtimeCache?: FactoryQuoteProviderRuntimeCache;
  };
}

async function executeSelectedFactoryRoute(
  params: FactoryLiquidationExecutionParams & {
    selectedLiquiditySource: LiquiditySource;
    quoteEvaluation: ExternalTakeQuoteEvaluation;
  }
): Promise<boolean> {
  const {
    pool,
    poolConfig,
    signer,
    liquidation,
    config,
    selectedLiquiditySource,
    quoteEvaluation,
  } = params;

  if (selectedLiquiditySource === LiquiditySource.UNISWAPV3) {
    await takeWithUniswapV3Factory({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation,
      config,
    });
  } else if (selectedLiquiditySource === LiquiditySource.SUSHISWAP) {
    await takeWithSushiSwapFactory({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation,
      config,
    });
  } else if (selectedLiquiditySource === LiquiditySource.CURVE) {
    await takeWithCurveFactory({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation,
      config,
    });
  } else {
    return failFactoryTakeExecution(
      `Factory: Unsupported liquidity source: ${selectedLiquiditySource}`
    );
  }

  recordExecutedFactoryRouteSuccess({
    pool,
    selectedLiquiditySource,
    quoteEvaluation,
    runtimeCache: config.runtimeCache,
  });
  return true;
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
}: FactoryLiquidationExecutionParams): Promise<boolean> {
  const { borrower } = liquidation;
  const { dryRun, keeperTakerFactory } = config;

  const externalTakeQuoteEvaluation =
    liquidation.externalTakeQuoteEvaluation ??
    (await getFactoryTakeQuoteEvaluation(
      pool,
      liquidation.auctionPrice,
      liquidation.collateral,
      poolConfig,
      config,
      signer,
      config.runtimeCache
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

  const selectedLiquiditySource =
    externalTakeQuoteEvaluation.selectedLiquiditySource;
  if (selectedLiquiditySource === undefined) {
    return failFactoryTakeExecution(
      `Factory: Missing selected liquidity source for ${pool.name}/${borrower}; refusing to execute an unbound route`
    );
  }
  const approvedMinOutRaw = deriveApprovedMinOutRaw({
    routeMinOutRaw: externalTakeQuoteEvaluation.routeMinOutRaw,
    profitMinOutRaw: externalTakeQuoteEvaluation.profitMinOutRaw,
    fallbackMinOutRaw: externalTakeQuoteEvaluation.approvedMinOutRaw,
  });
  if (!approvedMinOutRaw) {
    return failFactoryTakeExecution(
      `Factory: Missing approved min-out floor for ${pool.name}/${borrower}; refusing to execute an unbound swap`
    );
  }
  externalTakeQuoteEvaluation.approvedMinOutRaw = approvedMinOutRaw;
  if (
    (selectedLiquiditySource === LiquiditySource.UNISWAPV3 ||
      selectedLiquiditySource === LiquiditySource.SUSHISWAP) &&
    externalTakeQuoteEvaluation.selectedFeeTier === undefined
  ) {
    return failFactoryTakeExecution(
      `Factory: Missing selected fee tier for ${pool.name}/${borrower}; refusing to execute an unbound route`
    );
  }
  if (
    selectedLiquiditySource === LiquiditySource.CURVE &&
    !externalTakeQuoteEvaluation.curvePool
  ) {
    return failFactoryTakeExecution(
      `Factory: Missing selected Curve pool for ${pool.name}/${borrower}; refusing to execute an unbound route`
    );
  }

  if (dryRun) {
    logger.info(
      `DryRun - would Factory Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, selectedSource=${externalTakeQuoteEvaluation.selectedLiquiditySource ?? 'n/a'}, selectedFeeTier=${externalTakeQuoteEvaluation.selectedFeeTier ?? 'n/a'}, approvedMinOutRaw=${externalTakeQuoteEvaluation.approvedMinOutRaw?.toString() ?? 'n/a'}`
    );
    return true;
  }

  if (!keeperTakerFactory) {
    return failFactoryTakeExecution(
      'Factory: keeperTakerFactory address not configured'
    );
  }

  const routeMetadata =
    `source=${LiquiditySource[selectedLiquiditySource] ?? selectedLiquiditySource}` +
    ` feeTier=${externalTakeQuoteEvaluation.selectedFeeTier ?? 'n/a'}` +
    ` approvedMinOutRaw=${externalTakeQuoteEvaluation.approvedMinOutRaw.toString()}` +
    ` curvePool=${externalTakeQuoteEvaluation.curvePool?.address ?? 'n/a'}`;

  try {
    return await executeSelectedFactoryRoute({
      pool,
      poolConfig,
      signer,
      liquidation,
      config,
      selectedLiquiditySource,
      quoteEvaluation: externalTakeQuoteEvaluation,
    });
  } catch (error) {
    logger.error(
      `Factory take execution failed for ${pool.name}/${borrower} ${routeMetadata}`,
      error
    );
    return false;
  }
}

/**
 * Execute Uniswap V3 take via factory using WAD auction amounts.
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
  config: Pick<
    FactoryTakeParams['config'],
    'keeperTakerFactory' | 'universalRouterOverrides'
  > & { takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'] };
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
 * Execute SushiSwap take via factory using WAD auction amounts.
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
  config: Pick<
    FactoryTakeParams['config'],
    'keeperTakerFactory' | 'sushiswapRouterOverrides'
  > & { takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'] };
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
  config: Pick<
    FactoryTakeParams['config'],
    'keeperTakerFactory' | 'curveRouterOverrides' | 'tokenAddresses'
  > & { takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'] };
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
