import { BigNumber } from 'ethers';
import { weiToDecimaled } from './utils';
import { evaluateKickEligibility } from './kick-eligibility';
import { evaluateKickLiveness } from './kick-liveness';
import { BondBudget } from './kick-bond-budget';
import { KickSkipReason } from './kick-skip-reason';

export interface KickCandidateInput {
  poolAddress: string;
  // Eligibility / reward gate (P1)
  thresholdPrice: BigNumber;
  lup: BigNumber;
  /** pool HPB == _priceAt(depositIndex(1)), the true highest-deposit bucket. */
  hpb: BigNumber;
  debt: BigNumber;
  neutralPrice: BigNumber;
  /** resolved market price (collateral in quote units), decimaled & price-guarded. */
  marketPrice: number;
  minDebt: number;
  priceFactor: number;
  // Liveness gate (P3)
  /** highest-meaningful bucket price (deposit >= minDeposit); undefined if none. */
  hmbPrice: number | undefined;
  hpbPriceFactor: number;
  // Budget gate (P5)
  /** liquidationBond, the pool's quote token, decimaled. */
  bondQuote: number;
  /** the bond in the global normalized unit, for the global cap (optional). */
  bondNormalized?: number;
}

export type KickDecision =
  | {
      kick: true;
      /** margin-adjusted price the executor converts to the on-chain limitIndex. */
      marginPrice: number;
    }
  | { kick: false; reason: KickSkipReason };

/**
 * Composes the three pure kick gates into one decision: the reward gate (P1),
 * the arb-only liveness gate (P3), then the bond budget (P5). The budget is
 * charged LAST so a loan that fails an earlier gate never consumes budget. This
 * is the heart of the kick executor; the orchestration (hydration, sourcing,
 * submit) lives in the kick cycle and feeds this a fully-hydrated candidate.
 */
export function evaluateKickCandidate(
  input: KickCandidateInput,
  budget: BondBudget
): KickDecision {
  const eligibility = evaluateKickEligibility({
    thresholdPrice: input.thresholdPrice,
    lup: input.lup,
    hpb: input.hpb,
    debt: input.debt,
    neutralPrice: input.neutralPrice,
    marketPrice: input.marketPrice,
    minDebt: input.minDebt,
    priceFactor: input.priceFactor,
  });
  if (!eligibility.eligible) {
    return { kick: false, reason: eligibility.reason };
  }

  const liveness = evaluateKickLiveness({
    marketPrice: input.marketPrice,
    hmbPrice: input.hmbPrice,
    hpbPriceFactor: input.hpbPriceFactor,
    neutralPrice: weiToDecimaled(input.neutralPrice),
  });
  if (!liveness.live) {
    return { kick: false, reason: liveness.reason };
  }

  const reserved = budget.tryReserve({
    poolAddress: input.poolAddress,
    bondQuote: input.bondQuote,
    bondNormalized: input.bondNormalized,
  });
  if (!reserved) {
    return { kick: false, reason: 'bond-budget-exceeded' };
  }

  return { kick: true, marginPrice: eligibility.marginPrice };
}
