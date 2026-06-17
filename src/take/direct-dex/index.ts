import { Signer, FungiblePool } from '@ajna-finance/sdk';
import {
  getErrorMessage,
  mapWithConcurrencyPreservingOrder,
} from '../../utils';
import { LiquiditySource, formatLiquiditySource } from '../../config';
import { logger } from '../../logging';
import { BigNumber } from 'ethers';
import {
  ApprovedDirectDexQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import { ExternalTakeAdapter } from '../engine';
import {
  bindExternalTakeQuoteToExecutionResult,
  getExternalTakeExecutionPlanPrimaryEvaluation,
} from '../external-take/execution-plan';
import { approveDirectDexQuoteForExecution } from '../external-take/quote-approval-rules';
import {
  DirectDexExecutionConfig,
  DirectDexQuoteConfig,
  DirectDexQuoteProviderRuntimeCache,
  DirectDexRouteCandidate,
  DirectDexRouteProfitabilityContext,
  DirectDexRouteSelectionOptions,
  DirectDexTakeParams,
  applyDirectDexRouteProfitabilityPolicy,
  buildDirectDexRouteEvaluationContext,
  filterDirectDexRouteCandidatesByAvailability,
  formatDirectDexRouteCandidate,
  getDirectDexRouteCandidates,
  orderDirectDexRouteCandidates,
  recordDirectDexRouteSuccess,
  selectBestDirectDexRouteEvaluation,
  throwIfRouteProbeAborted,
} from './route-selection';
import { evaluateCurveDirectDexQuote, executeCurveDirectDexTake } from './curve';
import {
  evaluateUniswapV3DirectDexQuote,
  executeUniswapV3DirectDexTake,
} from './uniswap';
import { buildRouteRejectionEvaluation } from './route-rejection';

const DIRECT_DEX_ROUTE_QUOTE_CONCURRENCY = 3;

interface DirectDexRouteEvaluationEntry {
  route: DirectDexRouteCandidate;
  evaluation: ExternalTakeQuoteEvaluation;
}

export type {
  DirectDexExecutionConfig,
  DirectDexQuoteConfig,
  DirectDexQuoteProviderRuntimeCache,
  DirectDexQuoteProviderRuntimeStats,
  DirectDexRouteProfitabilityContext,
  DirectDexRouteSelectionOptions,
  DirectDexTakeParams,
} from './route-selection';
export {
  computeDirectDexAmountOutMinimum,
  createDirectDexQuoteProviderRuntimeCache,
  prewarmDirectDexRouteAvailability,
} from './route-selection';

export function createDirectDexTakeAdapter(params: {
  quoteConfig: DirectDexQuoteConfig;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  routeSelection?: DirectDexRouteSelectionOptions;
}): ExternalTakeAdapter<TakeActionConfig, DirectDexExecutionConfig> {
  return {
    kind: 'direct_dex',
    evaluateExternalTake: async ({
      pool,
      signer,
      poolConfig,
      candidate,
      auctionPrice,
      collateral,
    }) => {
      const quoteEvaluation = await getDirectDexTakeQuoteEvaluation(
        pool,
        auctionPrice,
        collateral,
        poolConfig,
        params.quoteConfig,
        signer,
        params.runtimeCache,
        params.routeSelection
      );
      return bindExternalTakeQuoteToExecutionResult({
        quoteEvaluation,
        poolName: pool.name,
        borrower: candidate.borrower,
      });
    },
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
      return takeLiquidationDirectDex({
        pool,
        signer,
        poolConfig,
        liquidation,
        config: executionConfig,
      });
    },
  };
}

/**
 * Splits ordered route candidates into the routes that still need an
 * availability probe and the routes already rejected by the precomputed
 * route-profitability context. Rejected routes are pushed onto `evaluations`
 * in iteration order, preserving the original side effect.
 */
function prefilterRoutesByRejection(params: {
  routes: DirectDexRouteCandidate[];
  routeProfitabilityContext?: DirectDexRouteProfitabilityContext;
  evaluations: DirectDexRouteEvaluationEntry[];
}): DirectDexRouteCandidate[] {
  const routeRejectionReasons =
    params.routeProfitabilityContext?.routeRejectionReasonsBySource;
  const availabilityCandidateRoutes: DirectDexRouteCandidate[] = [];

  for (const route of params.routes) {
    const rejectionReason = routeRejectionReasons?.[route.liquiditySource];
    if (rejectionReason) {
      params.evaluations.push({
        route,
        evaluation: buildRouteRejectionEvaluation({
          reason: rejectionReason,
          route,
          gasPolicyRejectCode:
            params.routeProfitabilityContext?.gasPolicyRejectCodeBySource?.[
              route.liquiditySource
            ],
          gasQuoteAttempts:
            params.routeProfitabilityContext?.gasQuoteAttemptsBySource?.[
              route.liquiditySource
            ],
        }),
      });
    } else {
      availabilityCandidateRoutes.push(route);
    }
  }

  return availabilityCandidateRoutes;
}

/**
 * Lazily builds the route-profitability context from the available sources
 * when one was not supplied up front. Returns the existing context unchanged
 * when already present or when no builder/source is available.
 */
async function resolveProfitabilityContext(params: {
  routeProfitabilityContext?: DirectDexRouteProfitabilityContext;
  routeSelection?: DirectDexRouteSelectionOptions;
  availableRoutes: DirectDexRouteCandidate[];
}): Promise<DirectDexRouteProfitabilityContext | undefined> {
  let routeProfitabilityContext = params.routeProfitabilityContext;
  if (
    !routeProfitabilityContext &&
    params.routeSelection?.routeProfitabilityContextBuilder
  ) {
    const availableSources = Array.from(
      new Set(params.availableRoutes.map((route) => route.liquiditySource))
    );
    if (availableSources.length > 0) {
      throwIfRouteProbeAborted(
        params.routeSelection?.routeProbeAbortSignal,
        'direct DEX route profitability context'
      );
      routeProfitabilityContext =
        await params.routeSelection.routeProfitabilityContextBuilder(
          availableSources
        );
    }
  }
  return routeProfitabilityContext;
}

/**
 * Partitions available routes into gas-policy-approved and gas-policy-rejected
 * sets. Rejected routes are pushed onto `evaluations` in iteration order,
 * preserving the original side effect.
 */
function applyGasPolicyRejections(params: {
  availableRoutes: DirectDexRouteCandidate[];
  routeProfitabilityContext?: DirectDexRouteProfitabilityContext;
  evaluations: DirectDexRouteEvaluationEntry[];
}): {
  gasApprovedRoutes: DirectDexRouteCandidate[];
  gasRejectedRoutes: DirectDexRouteCandidate[];
} {
  const gasRejectedRoutes: DirectDexRouteCandidate[] = [];
  const gasApprovedRoutes = params.availableRoutes.filter((route) => {
    const rejectionReason =
      params.routeProfitabilityContext?.routeRejectionReasonsBySource?.[
        route.liquiditySource
      ];
    if (!rejectionReason) {
      return true;
    }
    gasRejectedRoutes.push(route);
    params.evaluations.push({
      route,
      evaluation: buildRouteRejectionEvaluation({
        reason: rejectionReason,
        route,
        gasPolicyRejectCode:
          params.routeProfitabilityContext?.gasPolicyRejectCodeBySource?.[
            route.liquiditySource
          ],
        gasQuoteAttempts:
          params.routeProfitabilityContext?.gasQuoteAttemptsBySource?.[
            route.liquiditySource
          ],
      }),
    });
    return false;
  });
  return { gasApprovedRoutes, gasRejectedRoutes };
}

/**
 * Applies the per-candidate route quote budget, emitting the gas-policy and
 * budget-exhaustion debug logs in their original order, and returns the routes
 * to evaluate alongside the routes skipped by the budget.
 */
function applyRouteQuoteBudget(params: {
  gasApprovedRoutes: DirectDexRouteCandidate[];
  gasRejectedRoutes: DirectDexRouteCandidate[];
  routeQuoteBudget?: number;
  routeProfitabilityContext?: DirectDexRouteProfitabilityContext;
  poolName: string;
}): {
  routesToEvaluate: DirectDexRouteCandidate[];
  skippedRoutes: DirectDexRouteCandidate[];
} {
  const { gasApprovedRoutes, gasRejectedRoutes, routeQuoteBudget } = params;
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
      `Direct DEX: skipped gas-policy-rejected routes for pool ${params.poolName}: ${gasRejectedRoutes
        .map(
          (route) =>
            `${formatDirectDexRouteCandidate(route)}=${params.routeProfitabilityContext?.routeRejectionReasonsBySource?.[route.liquiditySource] ?? 'route gas policy rejected source'}`
        )
        .join(', ')}`
    );
  }
  if (skippedRoutes.length > 0) {
    logger.debug(
      `Direct DEX: route quote budget exhausted for pool ${params.poolName}; skipped routes=${skippedRoutes
        .map(formatDirectDexRouteCandidate)
        .join(', ')}`
    );
  }
  return { routesToEvaluate, skippedRoutes };
}

export async function getDirectDexTakeQuoteEvaluation(
  pool: FungiblePool,
  auctionPriceWad: BigNumber,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Pick<
    DirectDexTakeParams['config'],
    | 'uniswapV3RouterOverrides'
    | 'curveRouterOverrides'
    | 'tokenAddresses'
  >,
  signer: Signer,
  runtimeCache?: DirectDexQuoteProviderRuntimeCache,
  routeSelection?: DirectDexRouteSelectionOptions
): Promise<ExternalTakeQuoteEvaluation> {
  if (!poolConfig.take.marketPriceFactor) {
    return {
      isTakeable: false,
      reason: 'marketPriceFactor is not configured',
    };
  }

  if (!collateral.gt(0)) {
    logger.debug(
      `Direct DEX: Invalid collateral amount: ${collateral.toString()} for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'collateral must be greater than zero',
    };
  }

  try {
    if (
      poolConfig.take.liquiditySource === LiquiditySource.UNISWAPV3 ||
      poolConfig.take.liquiditySource === LiquiditySource.CURVE
    ) {
      throwIfRouteProbeAborted(
        routeSelection?.routeProbeAbortSignal,
        'direct DEX route evaluation'
      );
      const routeContext = await buildDirectDexRouteEvaluationContext({
        pool,
        signer,
        auctionPriceWad,
        collateral,
        marketPriceFactor: poolConfig.take.marketPriceFactor!,
        runtimeCache,
      });
      throwIfRouteProbeAborted(
        routeSelection?.routeProbeAbortSignal,
        'direct DEX route evaluation context'
      );
      const routes = orderDirectDexRouteCandidates({
        routes: getDirectDexRouteCandidates({
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
      const evaluations: DirectDexRouteEvaluationEntry[] = [];
      const availabilityCandidateRoutes = prefilterRoutesByRejection({
        routes,
        routeProfitabilityContext,
        evaluations,
      });

      const { availableRoutes, unavailableRoutes } =
        await filterDirectDexRouteCandidatesByAvailability({
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
          `Direct DEX: skipped unavailable routes for pool ${pool.name}: ${unavailableRoutes
            .map(
              ({ route, reason }) =>
                `${formatDirectDexRouteCandidate(route)}=${reason}`
            )
            .join(', ')}`
        );
      }

      routeProfitabilityContext = await resolveProfitabilityContext({
        routeProfitabilityContext,
        routeSelection,
        availableRoutes,
      });

      const { gasApprovedRoutes, gasRejectedRoutes } = applyGasPolicyRejections({
        availableRoutes,
        routeProfitabilityContext,
        evaluations,
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

      const { routesToEvaluate, skippedRoutes } = applyRouteQuoteBudget({
        gasApprovedRoutes,
        gasRejectedRoutes,
        routeQuoteBudget,
        routeProfitabilityContext,
        poolName: pool.name,
      });

      const evaluateDirectDexRoute = async (
        route: DirectDexRouteCandidate
      ): Promise<DirectDexRouteEvaluationEntry> => {
        throwIfRouteProbeAborted(
          routeSelection?.routeProbeAbortSignal,
          `direct DEX quote ${formatDirectDexRouteCandidate(route)}`
        );
        const rawEvaluation =
          route.liquiditySource === LiquiditySource.UNISWAPV3
            ? await evaluateUniswapV3DirectDexQuote({
                pool,
                auctionPriceWad,
                collateral,
                poolConfig,
                config,
                signer,
                runtimeCache,
                feeTier: route.feeTier,
                routeContext,
              })
            : route.liquiditySource === LiquiditySource.CURVE
              ? await evaluateCurveDirectDexQuote({
                  pool,
                  auctionPriceWad,
                  collateral,
                  poolConfig,
                  config,
                  signer,
                  runtimeCache,
                  routeContext,
                })
              : {
                  isTakeable: false,
                  reason: `unsupported route source ${route.liquiditySource}`,
                  selectedLiquiditySource: route.liquiditySource,
                };
        const evaluation = applyDirectDexRouteProfitabilityPolicy({
          evaluation: rawEvaluation,
          liquiditySource: route.liquiditySource,
          context: routeProfitabilityContext,
        });
        return { route, evaluation };
      };

      const routeEvaluationResults = await mapWithConcurrencyPreservingOrder(
        routesToEvaluate,
        DIRECT_DEX_ROUTE_QUOTE_CONCURRENCY,
        async (route) =>
          routeSelection?.routeProbeLimiter
            ? await routeSelection.routeProbeLimiter.run(
                `direct DEX quote ${formatDirectDexRouteCandidate(route)}`,
                async () => await evaluateDirectDexRoute(route),
                { signal: routeSelection.routeProbeAbortSignal }
              )
            : await evaluateDirectDexRoute(route)
      );

      if (routeEvaluationResults.length > 1) {
        logger.debug(
          `Direct DEX: quoted ${routeEvaluationResults.length} route(s) for pool ${pool.name} with concurrency=${Math.min(
            DIRECT_DEX_ROUTE_QUOTE_CONCURRENCY,
            routeEvaluationResults.length
          )}`
        );
      }
      evaluations.push(...routeEvaluationResults);

      const selectedRoute = selectBestDirectDexRouteEvaluation({
        evaluations,
        defaultLiquiditySource: poolConfig.take.liquiditySource,
        config,
      });
      if (selectedRoute) {
        const selected = selectedRoute.evaluation;
        logger.debug(
          `Direct DEX: selected route source=${selected.selectedLiquiditySource} feeTier=${selected.selectedFeeTier ?? 'n/a'} expectedNetProfitRaw=${selected.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} requiredOutputFloorRaw=${selected.routeProfitability?.requiredOutputFloorQuoteRaw?.toString() ?? selected.approvedMinOutRaw?.toString() ?? 'n/a'} surplusRaw=${selected.routeProfitability?.surplusOverFloorQuoteRaw?.toString() ?? 'n/a'} for pool ${pool.name}${
            skippedRoutes.length > 0 ? ' (route quote budget limited)' : ''
          }`
        );
        return selected;
      }

      const reason = [
        ...evaluations.map(
          ({ route, evaluation }) =>
            `${formatDirectDexRouteCandidate(route)}=${evaluation.reason ?? 'not takeable'}`
        ),
        ...unavailableRoutes.map(
          ({ route, reason }) =>
            `${formatDirectDexRouteCandidate(route)}=${reason}`
        ),
        ...skippedRoutes.map(
          (route) =>
            `${formatDirectDexRouteCandidate(route)}=skipped by route quote budget`
        ),
      ].join('; ');
      const gasRejectedEvaluation = evaluations
        .map(({ evaluation }) => evaluation)
        .find(
          (evaluation) =>
            evaluation.routeProfitability?.gasPolicyRejectCode !== undefined
        );
      return {
        isTakeable: false,
        reason: reason
          ? `no viable direct DEX route: ${reason}`
          : 'no direct DEX routes configured',
        routeProfitability: gasRejectedEvaluation?.routeProfitability,
      };
    }

    logger.debug(
      `Direct DEX: Unsupported liquidity source: ${poolConfig.take.liquiditySource}`
    );
    return {
      isTakeable: false,
      reason: `unsupported liquidity source ${poolConfig.take.liquiditySource}`,
    };
  } catch (error) {
    logger.error(
      `Direct DEX: Failed to check takeability for pool ${pool.name}: ${error}`
    );
    return {
      isTakeable: false,
      reason: getErrorMessage(error),
    };
  }
}

function failDirectDexTakeExecution(message: string): false {
  logger.error(message);
  return false;
}

function recordExecutedDirectDexRouteSuccess(params: {
  pool: FungiblePool;
  quoteEvaluation: ApprovedDirectDexQuoteEvaluation;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): void {
  recordDirectDexRouteSuccess({
    route: {
      liquiditySource: params.quoteEvaluation.selectedLiquiditySource,
      feeTier: params.quoteEvaluation.selectedFeeTier,
    },
    pool: params.pool,
    runtimeCache: params.runtimeCache,
  });
}

interface DirectDexLiquidationExecutionParams {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: TakeLiquidationPlan;
  config: Pick<
    DirectDexTakeParams['config'],
    | 'dryRun'
    | 'keeperTakerRouter'
    | 'uniswapV3RouterOverrides'
    | 'curveRouterOverrides'
    | 'tokenAddresses'
  > & {
    takeWriteTransport?: DirectDexExecutionConfig['takeWriteTransport'];
    runtimeCache?: DirectDexQuoteProviderRuntimeCache;
    onDirectDexExecutionFailure?: DirectDexExecutionConfig['onDirectDexExecutionFailure'];
  };
}

async function executeSelectedDirectDexRoute(
  params: DirectDexLiquidationExecutionParams & {
    quoteEvaluation: ApprovedDirectDexQuoteEvaluation;
  }
): Promise<boolean> {
  const { pool, poolConfig, signer, liquidation, config, quoteEvaluation } =
    params;

  if (quoteEvaluation.selectedLiquiditySource === LiquiditySource.UNISWAPV3) {
    await executeUniswapV3DirectDexTake({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation,
      config,
    });
  } else {
    await executeCurveDirectDexTake({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation,
      config,
    });
  }

  recordExecutedDirectDexRouteSuccess({
    pool,
    quoteEvaluation,
    runtimeCache: config.runtimeCache,
  });
  return true;
}

/**
 * Execute external take through the Direct DEX router
 */
export async function takeLiquidationDirectDex({
  pool,
  poolConfig,
  signer,
  liquidation,
  config,
}: DirectDexLiquidationExecutionParams): Promise<boolean> {
  const { borrower } = liquidation;
  const { dryRun, keeperTakerRouter } = config;

  const externalTakeQuoteEvaluation =
    getExternalTakeExecutionPlanPrimaryEvaluation(
      liquidation.externalTakeExecutionPlan
    ) ??
    (await getDirectDexTakeQuoteEvaluation(
      pool,
      liquidation.auctionPrice,
      liquidation.collateral,
      poolConfig,
      config,
      signer,
      config.runtimeCache
    ));

  const approval = approveDirectDexQuoteForExecution({
    quoteEvaluation: externalTakeQuoteEvaluation,
    poolName: pool.name,
    borrower,
  });
  if (!approval.approved) {
    return failDirectDexTakeExecution(approval.reason);
  }
  const approvedQuoteEvaluation = approval.quoteEvaluation;

  if (dryRun) {
    logger.info(
      `DryRun - would Direct DEX Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, selectedSource=${approvedQuoteEvaluation.selectedLiquiditySource}, selectedFeeTier=${approvedQuoteEvaluation.selectedFeeTier ?? 'n/a'}, approvedMinOutRaw=${approvedQuoteEvaluation.approvedMinOutRaw.toString()}`
    );
    return true;
  }

  if (!keeperTakerRouter) {
    return failDirectDexTakeExecution(
      'Direct DEX: keeperTakerRouter address not configured'
    );
  }

  const routeMetadata =
    `source=${formatLiquiditySource(approvedQuoteEvaluation.selectedLiquiditySource)}` +
    ` feeTier=${approvedQuoteEvaluation.selectedFeeTier ?? 'n/a'}` +
    ` approvedMinOutRaw=${approvedQuoteEvaluation.approvedMinOutRaw.toString()}` +
    ` curvePool=${approvedQuoteEvaluation.curvePool?.address ?? 'n/a'}`;

  try {
    return await executeSelectedDirectDexRoute({
      pool,
      poolConfig,
      signer,
      liquidation,
      config,
      quoteEvaluation: approvedQuoteEvaluation,
    });
  } catch (error) {
    logger.error(
      `Direct DEX take execution failed for ${pool.name}/${borrower} ${routeMetadata}`,
      error
    );
    return false;
  }
}
