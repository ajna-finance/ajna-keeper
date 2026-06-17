import { FungiblePool } from '@ajna-finance/sdk';
import {
  DEFAULT_FEE_TIER_BY_SOURCE,
  LiquiditySource,
  STANDARD_V3_FEE_TIERS,
  formatLiquiditySource,
  getEffectiveV3FeeTiers,
} from '../../config';
import { pruneMapToMaxSize } from '../../utils';
import { DirectDexQuoteProviderRuntimeCache } from './runtime-cache';
import {
  DirectDexQuoteConfig,
  DirectDexRouteCandidate,
  DirectDexRouteSelectionOptions,
} from './route-types';

const MAX_RECENT_ROUTE_SUCCESSES = 512;
const RECENT_ROUTE_SUCCESS_TTL_MS = 10 * 60 * 1000;

export function getEffectiveDirectDexFeeTiers(
  defaultFeeTier: number,
  candidateFeeTiers?: number[],
  automaticCandidateFeeTiers?: readonly number[]
): number[] {
  return getEffectiveV3FeeTiers({
    defaultFeeTier,
    candidateFeeTiers,
    automaticCandidateFeeTiers,
    filterInvalid: true,
  });
}

export function isDynamicDirectDexSource(source: LiquiditySource): boolean {
  return (
    source === LiquiditySource.UNISWAPV3 || source === LiquiditySource.CURVE
  );
}

export function getDefaultDirectDexFeeTierForSource(
  source: LiquiditySource,
  config: Pick<DirectDexQuoteConfig, 'uniswapV3RouterOverrides'>
): number | undefined {
  if (source === LiquiditySource.UNISWAPV3) {
    return (
      config.uniswapV3RouterOverrides?.defaultFeeTier ??
      DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3]
    );
  }
  return undefined;
}

export function formatDirectDexRouteCandidate(
  route: DirectDexRouteCandidate
): string {
  const source = formatLiquiditySource(route.liquiditySource);
  return route.feeTier !== undefined
    ? `${source}:${route.feeTier}`
    : `${source}:configured`;
}

function getDirectDexRouteCandidateKey(route: DirectDexRouteCandidate): string {
  return `${route.liquiditySource}:${route.feeTier ?? 'configured'}`;
}

export function getDirectDexRouteKey(params: {
  route: DirectDexRouteCandidate;
  collateralTokenAddress: string;
  quoteTokenAddress: string;
}): string {
  return [
    getDirectDexRouteCandidateKey(params.route),
    params.collateralTokenAddress.toLowerCase(),
    params.quoteTokenAddress.toLowerCase(),
  ].join(':');
}

function isDefaultDirectDexRoute(params: {
  route: DirectDexRouteCandidate;
  defaultLiquiditySource: LiquiditySource;
  config: Pick<DirectDexQuoteConfig, 'uniswapV3RouterOverrides'>;
}): boolean {
  if (params.route.liquiditySource !== params.defaultLiquiditySource) {
    return false;
  }
  const defaultFeeTier = getDefaultDirectDexFeeTierForSource(
    params.route.liquiditySource,
    params.config
  );
  return (
    defaultFeeTier === undefined || params.route.feeTier === defaultFeeTier
  );
}

function pruneExpiredRouteSuccesses(
  successTimestamps: Map<string, number>,
  now: number
): void {
  for (const [key, timestamp] of Array.from(successTimestamps.entries())) {
    if (now - timestamp > RECENT_ROUTE_SUCCESS_TTL_MS) {
      successTimestamps.delete(key);
    }
  }
  pruneMapToMaxSize(successTimestamps, MAX_RECENT_ROUTE_SUCCESSES);
}

export function orderDirectDexRouteCandidates(params: {
  routes: DirectDexRouteCandidate[];
  defaultLiquiditySource: LiquiditySource;
  config: Pick<DirectDexQuoteConfig, 'uniswapV3RouterOverrides'>;
  pool: Pick<FungiblePool, 'collateralAddress' | 'quoteAddress'>;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): DirectDexRouteCandidate[] {
  const now = Date.now();
  const successTimestamps = params.runtimeCache?.recentRouteSuccesses;
  if (successTimestamps) {
    pruneExpiredRouteSuccesses(successTimestamps, now);
  }

  return params.routes
    .map((route, index) => {
      const key = getDirectDexRouteKey({
        route,
        collateralTokenAddress: params.pool.collateralAddress,
        quoteTokenAddress: params.pool.quoteAddress,
      });
      return {
        route,
        index,
        isDefault: isDefaultDirectDexRoute({
          route,
          defaultLiquiditySource: params.defaultLiquiditySource,
          config: params.config,
        }),
        recentSuccessAt: successTimestamps?.get(key) ?? 0,
      };
    })
    .sort((left, right) => {
      const leftHasRecentSuccess = left.recentSuccessAt > 0;
      const rightHasRecentSuccess = right.recentSuccessAt > 0;
      if (leftHasRecentSuccess !== rightHasRecentSuccess) {
        return leftHasRecentSuccess ? -1 : 1;
      }
      if (left.recentSuccessAt !== right.recentSuccessAt) {
        return right.recentSuccessAt - left.recentSuccessAt;
      }
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ route }) => route);
}

export function recordDirectDexRouteSuccess(params: {
  route: DirectDexRouteCandidate;
  pool: Pick<FungiblePool, 'collateralAddress' | 'quoteAddress'>;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): void {
  if (!params.runtimeCache) {
    return;
  }
  if (!params.runtimeCache.recentRouteSuccesses) {
    params.runtimeCache.recentRouteSuccesses = new Map();
  }
  const now = Date.now();
  pruneExpiredRouteSuccesses(params.runtimeCache.recentRouteSuccesses, now);
  const routeKey = getDirectDexRouteKey({
    route: params.route,
    collateralTokenAddress: params.pool.collateralAddress,
    quoteTokenAddress: params.pool.quoteAddress,
  });
  params.runtimeCache.recentRouteSuccesses.delete(routeKey);
  params.runtimeCache.recentRouteSuccesses.set(routeKey, now);
  pruneMapToMaxSize(
    params.runtimeCache.recentRouteSuccesses,
    MAX_RECENT_ROUTE_SUCCESSES
  );
}

function pushDirectDexRouteCandidate(
  routes: DirectDexRouteCandidate[],
  seen: Set<string>,
  route: DirectDexRouteCandidate | undefined
): void {
  if (!route) {
    return;
  }

  const key = getDirectDexRouteCandidateKey(route);
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  routes.push(route);
}

export function getDirectDexRouteCandidates(params: {
  defaultLiquiditySource: LiquiditySource;
  config: Pick<DirectDexQuoteConfig, 'uniswapV3RouterOverrides'>;
  selection?: DirectDexRouteSelectionOptions;
}): DirectDexRouteCandidate[] {
  const sources = params.selection?.allowedLiquiditySources?.length
    ? params.selection.allowedLiquiditySources
    : [params.defaultLiquiditySource];

  const uniqueSources = Array.from(new Set(sources)).filter(
    isDynamicDirectDexSource
  );
  const routesBySource = new Map<LiquiditySource, DirectDexRouteCandidate[]>();
  for (const source of uniqueSources) {
    if (source === LiquiditySource.UNISWAPV3) {
      const defaultFeeTier =
        params.config.uniswapV3RouterOverrides?.defaultFeeTier ??
        DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3];
      routesBySource.set(
        source,
        getEffectiveDirectDexFeeTiers(
          defaultFeeTier,
          params.config.uniswapV3RouterOverrides?.candidateFeeTiers,
          STANDARD_V3_FEE_TIERS
        ).map((feeTier) => ({ liquiditySource: source, feeTier }))
      );
    }
    if (source === LiquiditySource.CURVE) {
      routesBySource.set(source, [{ liquiditySource: source }]);
    }
  }

  const orderedRoutes: DirectDexRouteCandidate[] = [];
  const seenRoutes = new Set<string>();

  for (const source of uniqueSources) {
    pushDirectDexRouteCandidate(
      orderedRoutes,
      seenRoutes,
      routesBySource.get(source)?.[0]
    );
  }
  for (const source of uniqueSources) {
    for (const route of routesBySource.get(source)?.slice(1) ?? []) {
      pushDirectDexRouteCandidate(orderedRoutes, seenRoutes, route);
    }
  }

  return orderedRoutes;
}
