import { Signer, FungiblePool } from '@ajna-finance/sdk';
import {
  getErrorMessage,
  mapWithConcurrencyPreservingOrder,
} from '../../utils';
import { LiquiditySource, formatLiquiditySource } from '../../config';
import { logger } from '../../logging';
import { BigNumber } from 'ethers';
import {
  ApprovedCurveFactoryQuoteEvaluation,
  ApprovedFactoryQuoteEvaluation,
  ApprovedSushiSwapFactoryQuoteEvaluation,
  ApprovedUniswapV3FactoryQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import { ExternalTakeAdapter } from '../engine';
import {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryRouteCandidate,
  FactoryRouteEvaluationContext,
  FactoryRouteSelectionOptions,
  FactoryTakeParams,
  applyFactoryRouteProfitabilityPolicy,
  buildFactoryRouteEvaluationContext,
  deriveApprovedMinOutRaw,
  filterFactoryRouteCandidatesByAvailability,
  formatFactoryRouteCandidate,
  getFactoryRouteCandidates,
  orderFactoryRouteCandidates,
  recordFactoryRouteSuccess,
  selectBestFactoryRouteEvaluation,
  throwIfRouteProbeAborted,
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

const FACTORY_ROUTE_QUOTE_CONCURRENCY = 3;

export type {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryQuoteProviderRuntimeStats,
  FactoryRouteProfitabilityContext,
  FactoryRouteSelectionOptions,
  FactoryTakeParams,
} from './shared';
export {
  computeFactoryAmountOutMinimum,
  createFactoryQuoteProviderRuntimeCache,
  prewarmFactoryRouteAvailability,
} from './shared';

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
      throwIfRouteProbeAborted(
        routeSelection?.routeProbeAbortSignal,
        'factory route evaluation'
      );
      const routeContext = await buildFactoryRouteEvaluationContext({
        pool,
        signer,
        auctionPriceWad,
        collateral,
        marketPriceFactor: poolConfig.take.marketPriceFactor!,
        runtimeCache,
      });
      throwIfRouteProbeAborted(
        routeSelection?.routeProbeAbortSignal,
        'factory route evaluation context'
      );
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
          routeProbeLimiter: routeSelection?.routeProbeLimiter,
          routeProbeAbortSignal: routeSelection?.routeProbeAbortSignal,
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
          throwIfRouteProbeAborted(
            routeSelection?.routeProbeAbortSignal,
            'factory route profitability context'
          );
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
        throwIfRouteProbeAborted(
          routeSelection?.routeProbeAbortSignal,
          `factory quote ${formatFactoryRouteCandidate(route)}`
        );
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
        async (route) =>
          routeSelection?.routeProbeLimiter
            ? await routeSelection.routeProbeLimiter.run(
                `factory quote ${formatFactoryRouteCandidate(route)}`,
                async () => await evaluateFactoryRoute(route),
                { signal: routeSelection.routeProbeAbortSignal }
              )
            : await evaluateFactoryRoute(route)
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
      reason: getErrorMessage(error),
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

type FactoryQuoteApprovalResult =
  | { approved: true; quoteEvaluation: ApprovedFactoryQuoteEvaluation }
  | { approved: false; reason: string };

function approveFactoryQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  poolName: string;
  borrower: string;
}): FactoryQuoteApprovalResult {
  const { quoteEvaluation, poolName, borrower } = params;

  if (!quoteEvaluation.isTakeable) {
    return {
      approved: false,
      reason: `Factory: Take quote no longer satisfies execution policy for ${poolName}/${borrower}: ${quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }

  if (!quoteEvaluation.quoteAmountRaw) {
    return {
      approved: false,
      reason: `Factory: Missing raw quote amount for ${poolName}/${borrower}; refusing to send an unbounded swap`,
    };
  }

  const selectedLiquiditySource = quoteEvaluation.selectedLiquiditySource;
  if (selectedLiquiditySource === undefined) {
    return {
      approved: false,
      reason: `Factory: Missing selected liquidity source for ${poolName}/${borrower}; refusing to execute an unbound route`,
    };
  }

  if (
    quoteEvaluation.externalTakePath !== undefined &&
    quoteEvaluation.externalTakePath !== 'factory'
  ) {
    return {
      approved: false,
      reason: `Factory: Received non-factory approved path for ${poolName}/${borrower}; refusing to execute an unbound route`,
    };
  }

  const approvedMinOutRaw = deriveApprovedMinOutRaw({
    routeMinOutRaw: quoteEvaluation.routeMinOutRaw,
    profitMinOutRaw: quoteEvaluation.profitMinOutRaw,
    fallbackMinOutRaw: quoteEvaluation.approvedMinOutRaw,
  });
  if (!approvedMinOutRaw) {
    return {
      approved: false,
      reason: `Factory: Missing approved min-out floor for ${poolName}/${borrower}; refusing to execute an unbound swap`,
    };
  }

  const approvedBase = {
    ...quoteEvaluation,
    isTakeable: true as const,
    quoteAmountRaw: quoteEvaluation.quoteAmountRaw,
    approvedMinOutRaw,
  };

  if (selectedLiquiditySource === LiquiditySource.UNISWAPV3) {
    if (quoteEvaluation.selectedFeeTier === undefined) {
      return {
        approved: false,
        reason: `Factory: Missing selected fee tier for ${poolName}/${borrower}; refusing to execute an unbound route`,
      };
    }
    return {
      approved: true,
      quoteEvaluation: {
        ...approvedBase,
        externalTakePath: 'factory',
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        selectedFeeTier: quoteEvaluation.selectedFeeTier,
      },
    };
  }

  if (selectedLiquiditySource === LiquiditySource.SUSHISWAP) {
    if (quoteEvaluation.selectedFeeTier === undefined) {
      return {
        approved: false,
        reason: `Factory: Missing selected fee tier for ${poolName}/${borrower}; refusing to execute an unbound route`,
      };
    }
    return {
      approved: true,
      quoteEvaluation: {
        ...approvedBase,
        externalTakePath: 'factory',
        selectedLiquiditySource: LiquiditySource.SUSHISWAP,
        selectedFeeTier: quoteEvaluation.selectedFeeTier,
      },
    };
  }

  if (selectedLiquiditySource === LiquiditySource.CURVE) {
    if (!quoteEvaluation.curvePool) {
      return {
        approved: false,
        reason: `Factory: Missing selected Curve pool for ${poolName}/${borrower}; refusing to execute an unbound route`,
      };
    }
    return {
      approved: true,
      quoteEvaluation: {
        ...approvedBase,
        externalTakePath: 'factory',
        selectedLiquiditySource: LiquiditySource.CURVE,
        curvePool: quoteEvaluation.curvePool,
      },
    };
  }

  return {
    approved: false,
    reason: `Factory: Unsupported liquidity source: ${selectedLiquiditySource}`,
  };
}

function recordExecutedFactoryRouteSuccess(params: {
  pool: FungiblePool;
  quoteEvaluation: ApprovedFactoryQuoteEvaluation;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): void {
  recordFactoryRouteSuccess({
    route: {
      liquiditySource: params.quoteEvaluation.selectedLiquiditySource,
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
  liquidation: TakeLiquidationPlan;
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
    onFactoryExecutionFailure?: FactoryExecutionConfig['onFactoryExecutionFailure'];
  };
}

async function executeSelectedFactoryRoute(
  params: FactoryLiquidationExecutionParams & {
    quoteEvaluation: ApprovedFactoryQuoteEvaluation;
  }
): Promise<boolean> {
  const { pool, poolConfig, signer, liquidation, config, quoteEvaluation } =
    params;

  if (quoteEvaluation.selectedLiquiditySource === LiquiditySource.UNISWAPV3) {
    await takeWithUniswapV3Factory({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation,
      config,
    });
  } else if (
    quoteEvaluation.selectedLiquiditySource === LiquiditySource.SUSHISWAP
  ) {
    await takeWithSushiSwapFactory({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation,
      config,
    });
  } else {
    await takeWithCurveFactory({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation,
      config,
    });
  }

  recordExecutedFactoryRouteSuccess({
    pool,
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

  const approval = approveFactoryQuoteForExecution({
    quoteEvaluation: externalTakeQuoteEvaluation,
    poolName: pool.name,
    borrower,
  });
  if (!approval.approved) {
    return failFactoryTakeExecution(approval.reason);
  }
  const approvedQuoteEvaluation = approval.quoteEvaluation;

  if (dryRun) {
    logger.info(
      `DryRun - would Factory Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, selectedSource=${approvedQuoteEvaluation.selectedLiquiditySource}, selectedFeeTier=${approvedQuoteEvaluation.selectedFeeTier ?? 'n/a'}, approvedMinOutRaw=${approvedQuoteEvaluation.approvedMinOutRaw.toString()}`
    );
    return true;
  }

  if (!keeperTakerFactory) {
    return failFactoryTakeExecution(
      'Factory: keeperTakerFactory address not configured'
    );
  }

  const routeMetadata =
    `source=${formatLiquiditySource(approvedQuoteEvaluation.selectedLiquiditySource)}` +
    ` feeTier=${approvedQuoteEvaluation.selectedFeeTier ?? 'n/a'}` +
    ` approvedMinOutRaw=${approvedQuoteEvaluation.approvedMinOutRaw.toString()}` +
    ` curvePool=${approvedQuoteEvaluation.curvePool?.address ?? 'n/a'}`;

  try {
    return await executeSelectedFactoryRoute({
      pool,
      poolConfig,
      signer,
      liquidation,
      config,
      quoteEvaluation: approvedQuoteEvaluation,
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
  liquidation: TakeLiquidationPlan;
  quoteEvaluation: ApprovedUniswapV3FactoryQuoteEvaluation;
  config: Pick<
    FactoryTakeParams['config'],
    'keeperTakerFactory' | 'universalRouterOverrides'
  > & {
    takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'];
    runtimeCache?: FactoryQuoteProviderRuntimeCache;
    onFactoryExecutionFailure?: FactoryExecutionConfig['onFactoryExecutionFailure'];
  };
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
  liquidation: TakeLiquidationPlan;
  quoteEvaluation: ApprovedSushiSwapFactoryQuoteEvaluation;
  config: Pick<
    FactoryTakeParams['config'],
    'keeperTakerFactory' | 'sushiswapRouterOverrides'
  > & {
    takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'];
    runtimeCache?: FactoryQuoteProviderRuntimeCache;
    onFactoryExecutionFailure?: FactoryExecutionConfig['onFactoryExecutionFailure'];
  };
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
  liquidation: TakeLiquidationPlan;
  quoteEvaluation: ApprovedCurveFactoryQuoteEvaluation;
  config: Pick<
    FactoryTakeParams['config'],
    'keeperTakerFactory' | 'curveRouterOverrides' | 'tokenAddresses'
  > & {
    takeWriteTransport?: FactoryExecutionConfig['takeWriteTransport'];
    runtimeCache?: FactoryQuoteProviderRuntimeCache;
    onFactoryExecutionFailure?: FactoryExecutionConfig['onFactoryExecutionFailure'];
  };
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
