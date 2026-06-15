import { BigNumber } from 'ethers';
import { CurveQuoteProvider } from '../../dex/providers/curve-quote-provider';
import { UniswapV3QuoteProvider } from '../../dex/providers/uniswap-quote-provider';

export interface DirectDexQuoteProviderRuntimeStats {
  swapDeadlineCacheHits?: number;
  swapDeadlineCacheMisses?: number;
  routeAvailabilityPrewarmCount?: number;
  routeAvailabilityPrewarmFailureCount?: number;
}

export interface DirectDexSwapDeadlineCacheEntry {
  fetchedAtMs: number;
  blockTimestamp: number;
  deadline: number;
  ttlSeconds: number;
}

export interface DirectDexQuoteProviderRuntimeCache {
  chainId?: number;
  chainIdInflight?: Promise<number | undefined>;
  uniswapV3?: UniswapV3QuoteProvider | null;
  curve?: CurveQuoteProvider | null;
  curveInitInflight?: Promise<CurveQuoteProvider | null>;
  curveUnavailableUntilMs?: number;
  tokenDecimals?: Map<string, number>;
  quoteTokenScales?: Map<string, BigNumber>;
  /** Success timestamps keyed by route; refreshed only after successful execution. */
  recentRouteSuccesses?: Map<string, number>;
  stats?: DirectDexQuoteProviderRuntimeStats;
  swapDeadline?: DirectDexSwapDeadlineCacheEntry;
}

export function createDirectDexQuoteProviderRuntimeCache(): DirectDexQuoteProviderRuntimeCache {
  return {};
}

export function incrementDirectDexRuntimeStat(
  stats: DirectDexQuoteProviderRuntimeStats | undefined,
  key: keyof DirectDexQuoteProviderRuntimeStats,
  amount: number = 1
): void {
  if (!stats) {
    return;
  }
  stats[key] = (stats[key] ?? 0) + amount;
}

export async function withDirectDexRuntimeStats<T>(
  runtimeCache: DirectDexQuoteProviderRuntimeCache | undefined,
  stats: DirectDexQuoteProviderRuntimeStats | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!runtimeCache || !stats) {
    return await fn();
  }
  const previousStats = runtimeCache.stats;
  runtimeCache.stats = stats;
  try {
    return await fn();
  } finally {
    runtimeCache.stats = previousStats;
  }
}
