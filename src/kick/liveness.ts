import { isArbProfitable } from '../take/arb';
import { KickSkipReason } from './skip-reason';

export interface KickLivenessInput {
  /** resolved market price (collateral in quote units), decimaled. */
  marketPrice: number;
  /**
   * Price of the pool's highest-meaningful bucket (deposit >= minDeposit) — the
   * bucket the keeper's arbTake would deposit into. Undefined / <= 0 when the
   * pool has no meaningful bucket to take into. Resolved once per pool by the
   * caller (P7 batches getHighestMeaningfulBucket per pool).
   */
  hmbPrice: number | undefined;
  /** the pool's arb hpbPriceFactor (in (0,1)). */
  hpbPriceFactor: number;
  /** loan neutralPrice, decimaled. */
  neutralPrice: number;
}

export type KickLiveness =
  | { live: true }
  | { live: false; reason: KickSkipReason };

/**
 * Pure kick LIVENESS gate (arb-only). Under Option 1 the keeper only kicks where
 * it can profitably take the auction it creates, so the bond is fed to its own
 * arbTake rather than orphaning. This asks exactly that, reusing the take path's
 * `isArbProfitable` core so kick and take agree on takeability:
 *
 *   - there is a highest-meaningful bucket to arbTake into, AND
 *   - the keeper's arbTake into that bucket clears below NP (rewarded, not
 *     penalized — npCeiling = NP), AND
 *   - the market is below the arb threshold (hmbPrice * factor), i.e. there is
 *     arb room; the auction price decays past this, so a take will materialize.
 *
 * External-aggregator-only takeability is intentionally NOT considered (v1
 * arb-only): pools takeable solely via an external route are not auto-kicked;
 * their auctions are still taken if someone else kicks them.
 */
export function evaluateKickLiveness(input: KickLivenessInput): KickLiveness {
  if (!input.hmbPrice || input.hmbPrice <= 0) {
    return { live: false, reason: 'no-meaningful-bucket' };
  }

  // The keeper's own bucketTake clears into the HMB bucket; if that bucket is
  // priced above NP the take would penalize the bond. Decide this here — we hold
  // both values — rather than recovering it from isArbProfitable's log string.
  if (input.hmbPrice > input.neutralPrice) {
    return { live: false, reason: 'liveness-hmb-above-np' };
  }

  // With the HMB bucket at/below NP, the only remaining question is arb room:
  // the market must sit below the arb threshold so the auction decays into a
  // take. npCeiling is redundant after the check above but kept so kick and take
  // share the exact same isArbProfitable verdict.
  const arb = isArbProfitable({
    price: input.marketPrice,
    hmbPrice: input.hmbPrice,
    hpbPriceFactor: input.hpbPriceFactor,
    npCeiling: input.neutralPrice,
  });
  return arb.takeable
    ? { live: true }
    : { live: false, reason: 'liveness-no-arb-room' };
}
