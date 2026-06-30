import { logger } from '../logging';

export interface BondBudgetLimits {
  /** Per-pool cap on bond at risk, in that pool's quote token (decimaled). */
  maxBondExposurePerPool: number;
  /**
   * Optional global cap on total bond at risk across all pools, in a single
   * caller-normalized unit (e.g. USD). When set, callers pass a normalized
   * amount per reservation; when unset only the per-pool cap applies. The
   * normalization lives in the caller (it owns the per-pool price), keeping this
   * object unit-agnostic and coherent.
   */
  maxTotalBondExposure?: number;
}

/**
 * Tracks bond-at-risk against a per-pool native-quote cap and an optional global
 * cap, so the kick cycle never posts more bond than configured. The bond is the
 * keeper's capital-at-risk (returned at settle unless penalized); it is NOT a
 * yield, and the illiquid arbTake LP reward is valued at zero — only returnable
 * face bond is tracked here (the 1% LIQUIDATION_BOND_MARGIN is allowance slack,
 * excluded). Worst case a kicked auction loses its full bond, so the caps bound
 * total downside.
 *
 * Assumes a single keeper process owns the kick signer: the per-pool locked
 * baseline (kickerInfo.locked) is only process-exclusive under that assumption.
 *
 * Pure/stateful and I/O-free — the caller reads kickerInfo.locked per pool and
 * seeds the budget; this object only does arithmetic.
 */
export class BondBudget {
  private readonly limits: BondBudgetLimits;
  private readonly lockedByPool: Map<string, number>;
  private readonly lockedNormalized: number;
  private readonly perPoolReserved = new Map<string, number>();
  private normalizedReserved = 0;

  constructor(params: {
    limits: BondBudgetLimits;
    /** Already-locked bond per pool (kickerInfo.locked), native quote, decimaled. */
    lockedByPool?: Map<string, number>;
    /** Already-locked bond total in the global normalized unit (when a global cap is used). */
    lockedNormalized?: number;
  }) {
    this.limits = params.limits;
    this.lockedByPool = normalizeKeys(params.lockedByPool);
    this.lockedNormalized = params.lockedNormalized ?? 0;
  }

  /**
   * Reserve a bond for a pool against both caps. Returns true and records the
   * reservation iff it fits under the per-pool cap AND (if set) the global cap;
   * returns false and records nothing otherwise.
   *
   * `bondQuote` is the bond in the pool's quote token (vs the per-pool cap).
   * `bondNormalized` is the bond in the global unit (vs the global cap); when a
   * global cap is set and it is omitted, `bondQuote` is used (only coherent for
   * single-quote-token setups).
   */
  tryReserve(params: {
    poolAddress: string;
    bondQuote: number;
    bondNormalized?: number;
  }): boolean {
    const key = params.poolAddress.toLowerCase();
    const perPoolUsed =
      (this.lockedByPool.get(key) ?? 0) + (this.perPoolReserved.get(key) ?? 0);
    if (perPoolUsed + params.bondQuote > this.limits.maxBondExposurePerPool) {
      logger.debug(
        `Bond budget: per-pool cap reached for ${key} (${perPoolUsed} + ${params.bondQuote} > ${this.limits.maxBondExposurePerPool})`
      );
      return false;
    }

    const hasGlobalCap = this.limits.maxTotalBondExposure !== undefined;
    const normalized = hasGlobalCap
      ? (params.bondNormalized ?? params.bondQuote)
      : 0;
    if (hasGlobalCap) {
      const globalUsed = this.lockedNormalized + this.normalizedReserved;
      if (globalUsed + normalized > this.limits.maxTotalBondExposure!) {
        logger.debug(
          `Bond budget: global cap reached (${globalUsed} + ${normalized} > ${this.limits.maxTotalBondExposure})`
        );
        return false;
      }
    }

    this.perPoolReserved.set(
      key,
      (this.perPoolReserved.get(key) ?? 0) + params.bondQuote
    );
    if (hasGlobalCap) {
      this.normalizedReserved += normalized;
    }
    return true;
  }
}

function normalizeKeys(map?: Map<string, number>): Map<string, number> {
  const result = new Map<string, number>();
  if (map) {
    for (const [key, value] of map) {
      result.set(key.toLowerCase(), value);
    }
  }
  return result;
}
