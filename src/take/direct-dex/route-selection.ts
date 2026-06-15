import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  DEFAULT_FEE_TIER_BY_SOURCE,
  LiquiditySource,
  ResolvedUniswapV3DirectDexQuoteConfig,
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
import { CurveQuoteProvider } from '../../dex/providers/curve-quote-provider';
import { UniswapV3QuoteProvider } from '../../dex/providers/uniswap-quote-provider';
import { TakeActionConfig } from '../types';
import { BASIS_POINTS_DENOMINATOR } from '../../constants';
import {
  DirectDexQuoteProviderRuntimeCache,
  DirectDexQuoteProviderRuntimeStats,
  incrementDirectDexRuntimeStat,
} from './runtime-cache';
import {
  DirectDexQuoteConfig,
  DirectDexRouteCandidate,
  DirectDexRouteSelectionOptions,
  DirectDexTakeConfig,
  DirectDexTakeConfigBase,
  DirectDexTakeConfigInput,
  DirectDexTakeParams,
  DirectDexExecutionConfig,
} from './route-types';
import { DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS } from './route-amounts';
import {
  formatDirectDexRouteCandidate,
  getDirectDexRouteCandidates,
  isDynamicDirectDexSource,
  orderDirectDexRouteCandidates,
} from './route-candidates';
export {
  BASIS_POINTS_DENOMINATOR,
  MARKET_FACTOR_SCALE,
  WAD,
} from '../../constants';
export { maxBigNumber } from '../../utils';
export {
  createDirectDexQuoteProviderRuntimeCache,
  incrementDirectDexRuntimeStat,
  withDirectDexRuntimeStats,
} from './runtime-cache';
export type {
  DirectDexQuoteProviderRuntimeCache,
  DirectDexQuoteProviderRuntimeStats,
} from './runtime-cache';
export {
  formatDirectDexExecutionLog,
  formatDirectDexPriceCheckLog,
  formatDirectDexQuoteRequestLog,
  formatDirectDexTakeSubmissionLog,
} from './logs';
export type {
  DirectDexQuoteConfig,
  DirectDexRouteCandidate,
  DirectDexRouteEvaluationContext,
  DirectDexRouteProfitabilityContext,
  DirectDexRouteSelectionOptions,
  DirectDexTakeConfig,
  DirectDexTakeConfigBase,
  DirectDexTakeConfigInput,
  DirectDexTakeParams,
  DirectDexExecutionConfig,
} from './route-types';
export {
  DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
  buildDirectDexQuoteEvaluation,
  buildDirectDexRouteEvaluationContext,
  ceilDiv,
  ceilWmul,
  computeDirectDexAmountOutMinimum,
  deriveApprovedMinOutRaw,
  getCachedDirectDexTokenDecimals,
  getMarketPriceFactorUnits,
  getQuoteAmountDueRaw,
  getSlippageBasisPoints,
  getSlippageFloorQuoteRaw,
  getSwapDeadline,
  getSwapDeadlineCached,
} from './route-amounts';
export { applyDirectDexRouteProfitabilityPolicy } from './route-profitability';
export {
  formatDirectDexRouteCandidate,
  getDefaultDirectDexFeeTierForSource,
  getDirectDexRouteCandidates,
  getDirectDexRouteKey,
  getEffectiveDirectDexFeeTiers,
  orderDirectDexRouteCandidates,
  recordDirectDexRouteSuccess,
} from './route-candidates';
export {
  selectBestDirectDexRouteEvaluation,
} from './route-ranking';
export type { DirectDexRouteEvaluationResult } from './route-ranking';

const DIRECT_DEX_ROUTE_AVAILABILITY_CONCURRENCY = 3;
const PROVIDER_INIT_FAILURE_RETRY_MS = 30_000;
const PROVIDER_INIT_FAILURE_RETRY_JITTER_BPS = 2_000;

function getProviderInitFailureRetryMs(): number {
  const jitterRangeMs = Math.floor(
    (PROVIDER_INIT_FAILURE_RETRY_MS * PROVIDER_INIT_FAILURE_RETRY_JITTER_BPS) /
      BASIS_POINTS_DENOMINATOR
  );
  return (
    PROVIDER_INIT_FAILURE_RETRY_MS -
    jitterRangeMs +
    Math.floor(Math.random() * (jitterRangeMs * 2 + 1))
  );
}

interface InitializableQuoteProvider {
  initialize(): Promise<boolean>;
}

export function throwIfRouteProbeAborted(
  signal?: AbortSignal,
  label: string = 'direct DEX route probe'
): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} aborted`);
}

async function initializeQuoteProviderWithCooldown<
  TProvider extends InitializableQuoteProvider,
>(params: {
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  label: string;
  getCachedProvider: () => TProvider | null | undefined;
  setCachedProvider: (provider: TProvider | null) => void;
  getUnavailableUntilMs: () => number | undefined;
  setUnavailableUntilMs: (untilMs: number | undefined) => void;
  getInitializationInflight?: () => Promise<TProvider | null> | undefined;
  setInitializationInflight?: (
    pending: Promise<TProvider | null> | undefined
  ) => void;
  createProvider: () => TProvider;
}): Promise<TProvider | undefined> {
  let quoteProvider = params.getCachedProvider();
  const unavailableUntilMs = params.getUnavailableUntilMs();
  if (
    quoteProvider === undefined &&
    params.runtimeCache &&
    unavailableUntilMs !== undefined &&
    unavailableUntilMs > Date.now()
  ) {
    logger.debug(
      `${params.label} quote provider initialization cooldown active for ${Math.max(
        0,
        unavailableUntilMs - Date.now()
      )}ms`
    );
    return undefined;
  }

  if (quoteProvider === undefined) {
    const initializeProvider = async (): Promise<TProvider | null> => {
      const candidateProvider = params.createProvider();
      const initialized = await withTimeout(
        candidateProvider.initialize(),
        DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
        `${params.label} quote provider initialization`
      ).catch((error) => {
        logger.warn(
          `${params.label} quote provider initialization failed: ${getErrorMessage(error)}`
        );
        return false;
      });
      const initializedProvider = initialized ? candidateProvider : null;
      if (params.runtimeCache) {
        if (initializedProvider) {
          if (unavailableUntilMs !== undefined) {
            logger.info(
              `${params.label} quote provider initialization recovered`
            );
          }
          params.setCachedProvider(initializedProvider);
          params.setUnavailableUntilMs(undefined);
        } else {
          const retryMs = getProviderInitFailureRetryMs();
          params.setUnavailableUntilMs(Date.now() + retryMs);
          logger.warn(
            `${params.label} quote provider unavailable; retrying initialization in ${retryMs}ms`
          );
        }
      }
      return initializedProvider;
    };

    const cachedInitialization = params.getInitializationInflight?.();
    if (cachedInitialization) {
      quoteProvider = await cachedInitialization;
    } else {
      const pendingInitialization = initializeProvider();
      params.setInitializationInflight?.(pendingInitialization);
      try {
        quoteProvider = await pendingInitialization;
      } finally {
        if (params.getInitializationInflight?.() === pendingInitialization) {
          params.setInitializationInflight?.(undefined);
        }
      }
    }
  }

  return quoteProvider ?? undefined;
}

export function getUniswapV3QuoteProvider(params: {
  signer: Signer;
  quoteConfig?: ResolvedUniswapV3DirectDexQuoteConfig;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): UniswapV3QuoteProvider | undefined {
  const quoteConfig = params.quoteConfig;
  if (!quoteConfig) {
    return undefined;
  }

  let quoteProvider = params.runtimeCache?.uniswapV3;
  if (quoteProvider === undefined) {
    const candidateProvider = new UniswapV3QuoteProvider(params.signer, {
      poolFactoryAddress: quoteConfig.poolFactoryAddress,
      defaultFeeTier: quoteConfig.defaultFeeTier,
      wethAddress: quoteConfig.wethAddress,
      quoterV2Address: quoteConfig.quoterV2Address,
    });
    quoteProvider = candidateProvider.isAvailable() ? candidateProvider : null;
    if (params.runtimeCache) {
      params.runtimeCache.uniswapV3 = quoteProvider;
    }
  }

  return quoteProvider ?? undefined;
}
export async function getCurveQuoteProvider(params: {
  signer: Signer;
  routerConfig?: DirectDexQuoteConfig['curveRouterOverrides'];
  tokenAddresses?: DirectDexQuoteConfig['tokenAddresses'];
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): Promise<CurveQuoteProvider | undefined> {
  const routerConfig = params.routerConfig;
  if (!routerConfig?.poolConfigs || !routerConfig.wethAddress) {
    return undefined;
  }
  const poolConfigs = routerConfig.poolConfigs;
  const wethAddress = routerConfig.wethAddress;

  return initializeQuoteProviderWithCooldown({
    runtimeCache: params.runtimeCache,
    label: 'Curve',
    getCachedProvider: () => params.runtimeCache?.curve,
    setCachedProvider: (provider) => {
      if (params.runtimeCache) {
        params.runtimeCache.curve = provider;
      }
    },
    getUnavailableUntilMs: () => params.runtimeCache?.curveUnavailableUntilMs,
    setUnavailableUntilMs: (untilMs) => {
      if (params.runtimeCache) {
        params.runtimeCache.curveUnavailableUntilMs = untilMs;
      }
    },
    getInitializationInflight: () => params.runtimeCache?.curveInitInflight,
    setInitializationInflight: (pending) => {
      if (params.runtimeCache) {
        params.runtimeCache.curveInitInflight = pending;
      }
    },
    createProvider: () =>
      new CurveQuoteProvider(params.signer, {
        poolConfigs: poolConfigs as any,
        defaultSlippage: routerConfig.defaultSlippage ?? 1.0,
        wethAddress,
        tokenAddresses: params.tokenAddresses ?? {},
      }),
  });
}

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
