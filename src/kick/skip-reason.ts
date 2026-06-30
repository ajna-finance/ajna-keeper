/**
 * Why a kickable-loan candidate was not kicked. A single typed union shared
 * across the kick gates (eligibility, liveness, and — later — budget) so the
 * kick cycle aggregates a typed skip histogram instead of matching free-form
 * strings.
 */
export type KickSkipReason =
  // Eligibility / reward gate (P1)
  | 'collateralized' // thresholdPrice <= LUP: loan is not yet liquidatable
  | 'debt-below-min' // debt < configured minDebt
  | 'neutral-below-market' // NP < market/priceFactor: reward margin not met
  | 'neutral-below-hpb' // NP < HPB: a bucketTake could penalize the bond
  | 'price-unavailable' // the resolved market price failed the price guard
  // Liveness gate (P3) — would this keeper's own arbTake clear profitably below NP?
  | 'no-meaningful-bucket' // no highest-meaningful bucket to arbTake into
  | 'liveness-hmb-above-np' // the HMB bucket price exceeds NP (self-take would penalize)
  | 'liveness-no-arb-room' // market is not below the HMB arb threshold (no arb profit)
  // Bond budget gate (P5)
  | 'bond-budget-exceeded'; // the bond would exceed a per-pool or global exposure cap
