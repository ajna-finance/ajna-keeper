const DEFAULT_PRICE_TTL_MS = 30_000;

/**
 * A small per-key TTL memo for resolved token prices, shared across pools and
 * cycles so an identical token price resolves at most once per TTL window
 * instead of once per pool per cycle.
 *
 * Bounded staleness only: a ~30s-old USD price is far inside a Dutch auction's
 * multi-hour decay window, the price is already reused across a whole pass today
 * (staticLimitPrice / per-pool market price), and on-chain `_kick` re-validates,
 * so kick/take decisions tolerate it. Entries expire lazily on read.
 */
export class TtlPriceCache {
  private readonly store = new Map<
    string,
    { price: number; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = DEFAULT_PRICE_TTL_MS) {}

  get(key: string): number | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.price;
  }

  set(key: string, price: number): void {
    this.store.set(key, { price, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

// Shared across all pools and the kick / take / discovery loops. CoinGecko is
// keyed by id (USD implied); Alchemy by `${chainId}:${lowercased-address}`.
export const coinGeckoPriceCache = new TtlPriceCache();
export const alchemyPriceCache = new TtlPriceCache();

/** Test helper: drop all cached prices (module-level state). */
export function resetPriceCaches(): void {
  coinGeckoPriceCache.clear();
  alchemyPriceCache.clear();
}
