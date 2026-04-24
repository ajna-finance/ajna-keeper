const DEFAULT_MAX_POOL_EXISTENCE_CACHE_ENTRIES = 1024;
export const POOL_EXISTS_CACHE_TTL_MS = 5 * 60 * 1000;
export const UNINITIALIZED_POOL_CACHE_TTL_MS = 30 * 1000;

interface PoolExistenceCacheEntry {
  exists: boolean;
  expiresAt: number;
}

export class PoolExistenceCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, PoolExistenceCacheEntry>();

  constructor(maxEntries: number = DEFAULT_MAX_POOL_EXISTENCE_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(tokenA: string, tokenB: string, feeTier: number): boolean | undefined {
    const key = this.getKey(tokenA, tokenB, feeTier);
    const cached = this.entries.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return cached.exists;
  }

  set(
    tokenA: string,
    tokenB: string,
    feeTier: number,
    exists: boolean,
    ttlMs: number
  ): void {
    const key = this.getKey(tokenA, tokenB, feeTier);
    this.entries.delete(key);
    this.entries.set(key, {
      exists,
      expiresAt: Date.now() + ttlMs,
    });
    this.prune();
  }

  private getKey(tokenA: string, tokenB: string, feeTier: number): string {
    const [token0, token1] = [
      tokenA.toLowerCase(),
      tokenB.toLowerCase(),
    ].sort();
    return [token0, token1, feeTier].join(':');
  }

  private prune(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}
