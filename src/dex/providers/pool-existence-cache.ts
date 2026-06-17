import { pruneMapToMaxSize } from '../../utils';

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
  private readonly inflight = new Map<string, Promise<boolean>>();

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

  async getOrCreate(
    tokenA: string,
    tokenB: string,
    feeTier: number,
    loader: () => Promise<{ exists: boolean; ttlMs: number }>
  ): Promise<boolean> {
    const cached = this.get(tokenA, tokenB, feeTier);
    if (cached !== undefined) {
      return cached;
    }

    const key = this.getKey(tokenA, tokenB, feeTier);
    const pending = this.inflight.get(key);
    if (pending) {
      return await pending;
    }

    const load = (async () => {
      const result = await loader();
      this.set(tokenA, tokenB, feeTier, result.exists, result.ttlMs);
      return result.exists;
    })();
    this.inflight.set(key, load);
    try {
      return await load;
    } finally {
      if (this.inflight.get(key) === load) {
        this.inflight.delete(key);
      }
    }
  }

  private getKey(tokenA: string, tokenB: string, feeTier: number): string {
    const [token0, token1] = [
      tokenA.toLowerCase(),
      tokenB.toLowerCase(),
    ].sort();
    return [token0, token1, feeTier].join(':');
  }

  private prune(): void {
    pruneMapToMaxSize(this.entries, this.maxEntries);
  }
}
