import { BigNumber } from 'ethers';
import { weiToDecimaled } from '../utils';
import { KickSkipReason } from './skip-reason';

export interface KickEligibilityInput {
  /** loan thresholdPrice, WAD (quote per collateral). */
  thresholdPrice: BigNumber;
  /** pool LUP, WAD. */
  lup: BigNumber;
  /** pool HPB == `_priceAt(depositIndex(1))`, WAD — the true highest-deposit bucket price. */
  hpb: BigNumber;
  /** loan debt, WAD (quote). */
  debt: BigNumber;
  /** loan neutralPrice, WAD. */
  neutralPrice: BigNumber;
  /** resolved market price (collateral in quote units), decimaled and already price-guarded. */
  marketPrice: number;
  /** minimum debt worth kicking, decimaled quote. */
  minDebt: number;
  /** reward-margin factor in (0,1); the kick needs `NP * priceFactor >= market`. */
  priceFactor: number;
}

export type KickEligibility =
  | {
      eligible: true;
      /**
       * Margin-adjusted price (`market / priceFactor`). The executor converts
       * this to the on-chain `limitIndex` so `_kick`'s `NP >= _priceAt(limitIndex)`
       * guard enforces the reward margin, not merely `NP >= market`.
       */
      marginPrice: number;
    }
  | { eligible: false; reason: KickSkipReason };

/**
 * Pure kick-eligibility predicate — the single source of truth for both the
 * manual and discovered kick paths. This is the REWARD gate: it decides whether
 * a loan is liquidatable AND whether kicking can be done without the bond being
 * penalized (an NP margin over market, plus an NP floor over HPB). It does NOT
 * decide liveness (whether a profitable take exists); that is the separate arb
 * predicate (P3).
 *
 * Gates are ordered cheapest-and-most-fundamental first, so the returned reason
 * is the most specific explanation for the skip.
 */
export function evaluateKickEligibility(
  input: KickEligibilityInput
): KickEligibility {
  const {
    thresholdPrice,
    lup,
    hpb,
    debt,
    neutralPrice,
    marketPrice,
    minDebt,
    priceFactor,
  } = input;

  // Strict TP > LUP. At TP == LUP the loan is borderline-collateralized and the
  // on-chain `_kick` would revert `BorrowerOk` (gas-only), so require strictly
  // greater rather than the old inclusive `>=`.
  if (thresholdPrice.lte(lup)) {
    return { eligible: false, reason: 'collateralized' };
  }

  if (weiToDecimaled(debt) < minDebt) {
    return { eligible: false, reason: 'debt-below-min' };
  }

  // Reward margin: a take below market must still clear below NP so the kicker
  // is rewarded, not penalized. `NP * priceFactor >= market` <=> `NP >= market / priceFactor`.
  const marginPrice = marketPrice / priceFactor;
  const np = weiToDecimaled(neutralPrice);
  if (np < marginPrice) {
    return { eligible: false, reason: 'neutral-below-market' };
  }

  // Bucket-take floor: a (bucket) take at any funded bucket priced above NP
  // penalizes the kicker. Require NP >= HPB (the true highest-deposit bucket
  // price) so no funded bucket sits above NP at kick time.
  if (np < weiToDecimaled(hpb)) {
    return { eligible: false, reason: 'neutral-below-hpb' };
  }

  return { eligible: true, marginPrice };
}
