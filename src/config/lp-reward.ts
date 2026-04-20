import type {
  CollectLpRewardSettings,
  CollectLpRewardOverride,
  KeeperConfig,
  PoolConfig,
} from './schema';

/**
 * Shared type guard for `lpRewardLookbackSeconds`. Used by both the config
 * validator (which throws on invalid input) and the `LpIngester` constructor
 * (which falls back to the default on invalid input for defense-in-depth).
 */
export function isValidLookbackSeconds(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= 0
  );
}

/**
 * Merge `defaultLpReward` with a per-pool override (if any) and return a
 * fully-specified `CollectLpRewardSettings`.
 *
 * Semantics:
 * - If BOTH default and override are undefined: returns `undefined`, signalling
 *   "LP collection is not configured for this pool".
 * - If ONLY the default is set: returns the default unchanged.
 * - If ONLY the override is set (legacy per-pool-only mode): the override must
 *   be a fully-specified `CollectLpRewardSettings` — required fields
 *   (`minAmountQuote`, `minAmountCollateral`) MUST be present or this throws.
 * - If BOTH are set: shallow-merge, with the override winning for every field
 *   the override explicitly sets.
 */
export function resolveCollectLpRewardForPool(
  defaultSettings: CollectLpRewardSettings | undefined,
  perPoolOverride: CollectLpRewardOverride | undefined,
  poolAddressForErrors: string
): CollectLpRewardSettings | undefined {
  if (!defaultSettings && !perPoolOverride) {
    return undefined;
  }

  // Per-pool-only mode: override must be complete.
  if (!defaultSettings) {
    const override = perPoolOverride!;
    if (
      typeof override.minAmountQuote !== 'number' ||
      typeof override.minAmountCollateral !== 'number'
    ) {
      throw new Error(
        `pool ${poolAddressForErrors} sets collectLpReward without a ` +
          `KeeperConfig.defaultLpReward to inherit from; minAmountQuote and ` +
          `minAmountCollateral are required on the per-pool entry in this mode.`
      );
    }
    return {
      redeemFirst: override.redeemFirst,
      minAmountQuote: override.minAmountQuote,
      minAmountCollateral: override.minAmountCollateral,
      rewardActionQuote: override.rewardActionQuote,
      rewardActionCollateral: override.rewardActionCollateral,
    };
  }

  if (!perPoolOverride) {
    return { ...defaultSettings };
  }

  // Both set: shallow-merge. `undefined` override fields fall through to the
  // default; explicitly-set override fields win.
  return {
    redeemFirst:
      perPoolOverride.redeemFirst !== undefined
        ? perPoolOverride.redeemFirst
        : defaultSettings.redeemFirst,
    minAmountQuote:
      perPoolOverride.minAmountQuote !== undefined
        ? perPoolOverride.minAmountQuote
        : defaultSettings.minAmountQuote,
    minAmountCollateral:
      perPoolOverride.minAmountCollateral !== undefined
        ? perPoolOverride.minAmountCollateral
        : defaultSettings.minAmountCollateral,
    rewardActionQuote:
      perPoolOverride.rewardActionQuote !== undefined
        ? perPoolOverride.rewardActionQuote
        : defaultSettings.rewardActionQuote,
    rewardActionCollateral:
      perPoolOverride.rewardActionCollateral !== undefined
        ? perPoolOverride.rewardActionCollateral
        : defaultSettings.rewardActionCollateral,
  };
}

/**
 * True if any form of LP collection is active — either a chain-wide default
 * is set, or at least one pool has a per-pool override.
 */
export function isLpCollectionEnabled(config: KeeperConfig): boolean {
  if (config.defaultLpReward) return true;
  return config.pools.some(
    (pool: PoolConfig) => pool.collectLpReward !== undefined
  );
}
