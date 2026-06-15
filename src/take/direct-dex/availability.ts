import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  DEFAULT_FEE_TIER_BY_SOURCE,
  LiquiditySource,
  resolveUniswapV3DirectDexRouteConfig,
} from '../../config';
import { logger } from '../../logging';
import {
  AsyncOperationLimiter,
  getErrorMessage,
  mapWithConcurrencyPreservingOrder,
  withTimeout,
  withTimeoutAbort,
} from '../../utils';
import { TakeActionConfig } from '../types';
import {
  DirectDexQuoteProviderRuntimeCache,
  incrementDirectDexRuntimeStat,
} from './runtime-cache';
import {
  DirectDexQuoteConfig,
  DirectDexRouteCandidate,
  DirectDexRouteSelectionOptions,
} from './route-types';
import { DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS } from './route-amounts';
import {
  formatDirectDexRouteCandidate,
  getDirectDexRouteCandidates,
  isDynamicDirectDexSource,
  orderDirectDexRouteCandidates,
} from './route-candidates';
import {
  getCurveQuoteProvider,
  getUniswapV3QuoteProvider,
  throwIfRouteProbeAborted,
} from './providers';

const DIRECT_DEX_ROUTE_AVAILABILITY_CONCURRENCY = 3;

export interface DirectDexRouteAvailabilitySkip {
  route: DirectDexRouteCandidate;
  reason: string;
}

type DirectDexRouteAvailabilityResult =
  | { route: DirectDexRouteCandidate; available: true }
  | { route: DirectDexRouteCandidate; available: false; reason: string };

interface DirectDexRouteAvailabilityCheckParams {
  route: DirectDexRouteCandidate;
  pool: Pick<FungiblePool, 'name' | 'collateralAddress' | 'quoteAddress'>;
  signer: Signer;
  config: DirectDexQuoteConfig;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}

interface V3StylePoolExistenceProvider {
  poolExists(tokenA: string, tokenB: string, feeTier: number): Promise<boolean>;
}

function availableDirectDexRoute(
  route: DirectDexRouteCandidate
): DirectDexRouteAvailabilityResult {
  return { route, available: true };
}

function unavailableDirectDexRoute(
  route: DirectDexRouteCandidate,
  reason: string
): DirectDexRouteAvailabilityResult {
  return { route, available: false, reason };
}

async function checkV3StyleRouteAvailability(
  params: DirectDexRouteAvailabilityCheckParams & {
    label: string;
    quoteProvider: V3StylePoolExistenceProvider | undefined;
    configuredFeeTier?: number;
    defaultFeeTier: number;
  }
): Promise<DirectDexRouteAvailabilityResult> {
  const { route } = params;
  if (!params.quoteProvider) {
    return unavailableDirectDexRoute(
      route,
      `${params.label} quote provider unavailable`
    );
  }

  const feeTier =
    route.feeTier ?? params.configuredFeeTier ?? params.defaultFeeTier;
  let exists: boolean;
  try {
    exists = await withTimeout(
      params.quoteProvider.poolExists(
        params.pool.collateralAddress,
        params.pool.quoteAddress,
        feeTier
      ),
      DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
      `${params.label} pool existence check`
    );
  } catch (error) {
    return unavailableDirectDexRoute(
      route,
      `${params.label} pool existence check failed: ${getErrorMessage(error)}`
    );
  }

  return exists
    ? availableDirectDexRoute(route)
    : unavailableDirectDexRoute(route, `${params.label} pool not found`);
}

async function checkUniswapV3RouteAvailability(
  params: DirectDexRouteAvailabilityCheckParams
): Promise<DirectDexRouteAvailabilityResult> {
  const quoteConfig = resolveUniswapV3DirectDexRouteConfig(
    params.config.uniswapV3RouterOverrides
  );
  const quoteProvider = getUniswapV3QuoteProvider({
    signer: params.signer,
    quoteConfig,
    runtimeCache: params.runtimeCache,
  });
  return await checkV3StyleRouteAvailability({
    ...params,
    label: 'Uniswap V3',
    quoteProvider,
    configuredFeeTier: quoteConfig?.defaultFeeTier,
    defaultFeeTier: DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3],
  });
}

async function checkCurveRouteAvailability(
  params: DirectDexRouteAvailabilityCheckParams
): Promise<DirectDexRouteAvailabilityResult> {
  const { route } = params;
  const quoteProvider = await getCurveQuoteProvider({
    signer: params.signer,
    routerConfig: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
    runtimeCache: params.runtimeCache,
  });
  if (!quoteProvider) {
    return unavailableDirectDexRoute(route, 'Curve quote provider unavailable');
  }

  let exists: boolean;
  try {
    exists = await withTimeout(
      quoteProvider.poolExists(
        params.pool.collateralAddress,
        params.pool.quoteAddress
      ),
      DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
      'Curve pool existence check'
    );
  } catch (error) {
    return unavailableDirectDexRoute(
      route,
      `Curve pool existence check failed: ${getErrorMessage(error)}`
    );
  }
  return exists
    ? availableDirectDexRoute(route)
    : unavailableDirectDexRoute(
        route,
        'Curve pool not configured for token pair'
      );
}

async function checkDirectDexRouteCandidateAvailability(
  params: DirectDexRouteAvailabilityCheckParams
): Promise<DirectDexRouteAvailabilityResult> {
  switch (params.route.liquiditySource) {
    case LiquiditySource.UNISWAPV3:
      return await checkUniswapV3RouteAvailability(params);
    case LiquiditySource.CURVE:
      return await checkCurveRouteAvailability(params);
    default:
      return unavailableDirectDexRoute(
        params.route,
        `unsupported route source ${params.route.liquiditySource}`
      );
  }
}

export async function filterDirectDexRouteCandidatesByAvailability(params: {
  routes: DirectDexRouteCandidate[];
  pool: Pick<FungiblePool, 'name' | 'collateralAddress' | 'quoteAddress'>;
  signer: Signer;
  config: DirectDexQuoteConfig;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  routeProbeLimiter?: AsyncOperationLimiter;
  routeProbeAbortSignal?: AbortSignal;
}): Promise<{
  availableRoutes: DirectDexRouteCandidate[];
  unavailableRoutes: DirectDexRouteAvailabilitySkip[];
}> {
  throwIfRouteProbeAborted(
    params.routeProbeAbortSignal,
    'direct DEX route availability'
  );
  const availableRoutes: DirectDexRouteCandidate[] = [];
  const unavailableRoutes: DirectDexRouteAvailabilitySkip[] = [];
  const availabilityResults = await mapWithConcurrencyPreservingOrder(
    params.routes,
    DIRECT_DEX_ROUTE_AVAILABILITY_CONCURRENCY,
    async (route) => {
      const checkAvailability = async () => {
        throwIfRouteProbeAborted(
          params.routeProbeAbortSignal,
          `direct DEX availability ${formatDirectDexRouteCandidate(route)}`
        );
        return await checkDirectDexRouteCandidateAvailability({
          ...params,
          route,
        });
      };
      return params.routeProbeLimiter
        ? await params.routeProbeLimiter.run(
            `direct DEX availability ${formatDirectDexRouteCandidate(route)}`,
            checkAvailability,
            { signal: params.routeProbeAbortSignal }
          )
        : await checkAvailability();
    }
  );

  for (const availability of availabilityResults) {
    if (availability.available) {
      availableRoutes.push(availability.route);
    } else {
      unavailableRoutes.push({
        route: availability.route,
        reason: availability.reason,
      });
    }
  }

  return { availableRoutes, unavailableRoutes };
}

export async function prewarmDirectDexRouteAvailability(params: {
  pool: Pick<
    FungiblePool,
    'name' | 'collateralAddress' | 'quoteAddress' | 'poolAddress'
  >;
  signer: Signer;
  poolConfig: TakeActionConfig;
  quoteConfig: DirectDexQuoteConfig;
  routeSelection?: DirectDexRouteSelectionOptions;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  timeoutMs?: number;
}): Promise<void> {
  const defaultLiquiditySource = params.poolConfig.take.liquiditySource;
  if (
    defaultLiquiditySource === undefined ||
    !isDynamicDirectDexSource(defaultLiquiditySource)
  ) {
    return;
  }

  const routes = orderDirectDexRouteCandidates({
    routes: getDirectDexRouteCandidates({
      defaultLiquiditySource,
      config: params.quoteConfig,
      selection: params.routeSelection,
    }),
    defaultLiquiditySource,
    config: params.quoteConfig,
    pool: params.pool,
    runtimeCache: params.runtimeCache,
  });
  if (routes.length === 0) {
    return;
  }

  incrementDirectDexRuntimeStat(
    params.runtimeCache?.stats,
    'routeAvailabilityPrewarmCount'
  );

  try {
    if (params.timeoutMs !== undefined) {
      await withTimeoutAbort(
        async (signal) =>
          await filterDirectDexRouteCandidatesByAvailability({
            routes,
            pool: params.pool,
            signer: params.signer,
            config: params.quoteConfig,
            runtimeCache: params.runtimeCache,
            routeProbeLimiter: params.routeSelection?.routeProbeLimiter,
            routeProbeAbortSignal: signal,
          }),
        params.timeoutMs,
        'direct DEX route availability prewarm'
      );
    } else {
      await filterDirectDexRouteCandidatesByAvailability({
        routes,
        pool: params.pool,
        signer: params.signer,
        config: params.quoteConfig,
        runtimeCache: params.runtimeCache,
        routeProbeLimiter: params.routeSelection?.routeProbeLimiter,
      });
    }
  } catch (error) {
    incrementDirectDexRuntimeStat(
      params.runtimeCache?.stats,
      'routeAvailabilityPrewarmFailureCount'
    );
    logger.debug(
      `Direct DEX: route availability prewarm skipped for ${params.pool.name}: ${getErrorMessage(error)}`
    );
  }
}
