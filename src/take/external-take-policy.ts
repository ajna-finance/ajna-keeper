import { BigNumber } from 'ethers';
import { MARKET_FACTOR_SCALE, ZERO_BN } from '../constants';
import { maxBigNumber } from '../utils';
import type {
  ExternalTakeQuoteEvaluation,
  RouteProfitabilityBreakdown,
} from './types';

export const EXTERNAL_TAKE_REJECTION_REASONS = {
  auctionPriceAboveThreshold: 'auction price above external take threshold',
  routeQuoteBelowRepaymentFloor: 'route quote below repayment floor',
  routeQuoteBelowRequiredOutputFloor: 'route quote below required output floor',
} as const;

function ratioToNumber(numerator: BigNumber, denominator: BigNumber): number {
  if (denominator.isZero()) {
    return 0;
  }
  return (
    numerator.mul(MARKET_FACTOR_SCALE).div(denominator).toNumber() /
    MARKET_FACTOR_SCALE
  );
}

/**
 * Inputs required to apply route-derived external-take profitability policy.
 *
 * The market factor inputs are route-implied quote floors. They do not come from
 * a separate oracle; callers compare the current route quote against the floor
 * implied by the configured market price factor.
 */
export interface ExternalTakeRoutePolicyInput {
  configuredMarketPriceFactor: number;
  allowSubsidy: boolean;
  quoteAmountRaw: BigNumber;
  quoteDueRaw: BigNumber;
  marketFactorFloorQuoteRaw: BigNumber;
  routeMinOutRaw?: BigNumber;
  routeExecutionCostQuoteRaw?: BigNumber;
  configuredProfitFloorQuoteRaw?: BigNumber;
  nativeProfitFloorQuoteRaw?: BigNumber;
  slippageRiskBufferQuoteRaw?: BigNumber;
}

/** Result of applying route-derived repayment, profit, subsidy, and min-out floors. */
export interface ExternalTakeRoutePolicyResult {
  isEconomicallyExecutable: boolean;
  routeMinOutRaw?: BigNumber;
  profitMinOutRaw: BigNumber;
  approvedMinOutRaw: BigNumber;
  routeExecutionCostQuoteRaw: BigNumber;
  configuredProfitFloorQuoteRaw: BigNumber;
  nativeProfitFloorQuoteRaw: BigNumber;
  slippageRiskBufferQuoteRaw: BigNumber;
  requiredProfitFloorQuoteRaw: BigNumber;
  breakEvenQuoteAmountRaw: BigNumber;
  /** Non-subsidized floor before route slippage min-out is applied. */
  requiredNonSubsidizedOutputRaw: BigNumber;
  /** Alias for requiredNonSubsidizedOutputRaw used by route telemetry. */
  requiredOutputFloorQuoteRaw: BigNumber;
  expectedNetProfitQuoteRaw: BigNumber;
  expectedShortfallQuoteRaw: BigNumber;
  surplusOverFloorQuoteRaw: BigNumber;
  routeBreakEvenMarketPriceFactor: number;
  effectiveMarketPriceFactor: number;
  subsidyAllowed: boolean;
  expectedSubsidyQuoteRaw: BigNumber;
  rejectionReason?: string;
}

export type RoutePolicyProfitabilityExtras = Partial<
  Pick<
    RouteProfitabilityBreakdown,
    | 'routeGasLimit'
    | 'gasPriceWei'
    | 'gasPriceGwei'
    | 'gasPriceAgeMs'
    | 'gasPriceFreshnessTtlMs'
    | 'l2GasCostBufferBasisPoints'
    | 'gasPolicyEvaluatedAt'
  >
>;

/**
 * Central external-take policy gate.
 *
 * The caller supplies a route quote and raw quote-token floors; this function
 * returns the approved min-out plus profitability telemetry used for ranking
 * and final execution checks.
 */
export function applyExternalTakeRoutePolicy(
  params: ExternalTakeRoutePolicyInput
): ExternalTakeRoutePolicyResult {
  const routeExecutionCostQuoteRaw =
    params.routeExecutionCostQuoteRaw ?? ZERO_BN;
  const configuredProfitFloorQuoteRaw =
    params.configuredProfitFloorQuoteRaw ?? ZERO_BN;
  const nativeProfitFloorQuoteRaw = params.nativeProfitFloorQuoteRaw ?? ZERO_BN;
  const slippageRiskBufferQuoteRaw =
    params.slippageRiskBufferQuoteRaw ?? ZERO_BN;
  const requiredProfitFloorQuoteRaw = maxBigNumber(
    configuredProfitFloorQuoteRaw,
    nativeProfitFloorQuoteRaw
  );
  const breakEvenQuoteAmountRaw = params.quoteDueRaw
    .add(routeExecutionCostQuoteRaw)
    .add(slippageRiskBufferQuoteRaw);
  const gasAndProfitFloorQuoteRaw = breakEvenQuoteAmountRaw.add(
    requiredProfitFloorQuoteRaw
  );
  const requiredNonSubsidizedOutputRaw = maxBigNumber(
    params.marketFactorFloorQuoteRaw,
    gasAndProfitFloorQuoteRaw
  );
  const routeBreakEvenMarketPriceFactor = ratioToNumber(
    params.quoteDueRaw,
    requiredNonSubsidizedOutputRaw
  );
  const effectiveMarketPriceFactor = params.allowSubsidy
    ? params.configuredMarketPriceFactor
    : Math.min(
        params.configuredMarketPriceFactor,
        routeBreakEvenMarketPriceFactor
      );

  const passesMarketThreshold = params.quoteAmountRaw.gte(
    params.marketFactorFloorQuoteRaw
  );
  const isRepayable = params.quoteAmountRaw.gte(params.quoteDueRaw);
  const isNonSubsidizedProfitable = params.quoteAmountRaw.gte(
    requiredNonSubsidizedOutputRaw
  );
  const policyMinOutRaw = params.allowSubsidy
    ? params.quoteDueRaw
    : requiredNonSubsidizedOutputRaw;
  const approvedMinOutRaw = params.routeMinOutRaw
    ? maxBigNumber(params.routeMinOutRaw, policyMinOutRaw)
    : policyMinOutRaw;
  const expectedNetProfitQuoteRaw = params.quoteAmountRaw.gte(
    breakEvenQuoteAmountRaw
  )
    ? params.quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
    : ZERO_BN;
  const expectedShortfallQuoteRaw = params.quoteAmountRaw.lt(
    breakEvenQuoteAmountRaw
  )
    ? breakEvenQuoteAmountRaw.sub(params.quoteAmountRaw)
    : ZERO_BN;
  const surplusOverFloorQuoteRaw = params.quoteAmountRaw.gte(
    requiredNonSubsidizedOutputRaw
  )
    ? params.quoteAmountRaw.sub(requiredNonSubsidizedOutputRaw)
    : ZERO_BN;
  const expectedSubsidyQuoteRaw =
    params.allowSubsidy &&
    params.quoteAmountRaw.lt(requiredNonSubsidizedOutputRaw)
      ? requiredNonSubsidizedOutputRaw.sub(params.quoteAmountRaw)
      : ZERO_BN;

  let rejectionReason: string | undefined;
  if (!isRepayable) {
    rejectionReason =
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRepaymentFloor;
  } else if (!passesMarketThreshold) {
    rejectionReason =
      EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold;
  } else if (!params.allowSubsidy && !isNonSubsidizedProfitable) {
    rejectionReason =
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor;
  }

  return {
    isEconomicallyExecutable: rejectionReason === undefined,
    routeMinOutRaw: params.routeMinOutRaw,
    profitMinOutRaw: policyMinOutRaw,
    approvedMinOutRaw,
    routeExecutionCostQuoteRaw,
    configuredProfitFloorQuoteRaw,
    nativeProfitFloorQuoteRaw,
    slippageRiskBufferQuoteRaw,
    requiredProfitFloorQuoteRaw,
    breakEvenQuoteAmountRaw,
    requiredNonSubsidizedOutputRaw,
    requiredOutputFloorQuoteRaw: requiredNonSubsidizedOutputRaw,
    expectedNetProfitQuoteRaw,
    expectedShortfallQuoteRaw,
    surplusOverFloorQuoteRaw,
    routeBreakEvenMarketPriceFactor,
    effectiveMarketPriceFactor,
    subsidyAllowed: params.allowSubsidy,
    expectedSubsidyQuoteRaw,
    rejectionReason,
  };
}

export function mergeRoutePolicyIntoProfitability(params: {
  existing?: RouteProfitabilityBreakdown;
  policy: ExternalTakeRoutePolicyResult;
  auctionRepayRequirementQuoteRaw: BigNumber;
  configuredMarketPriceFactor: number;
  marketFactorFloorQuoteRaw: BigNumber;
  extras?: RoutePolicyProfitabilityExtras;
}): RouteProfitabilityBreakdown {
  return {
    ...params.existing,
    auctionRepayRequirementQuoteRaw: params.auctionRepayRequirementQuoteRaw,
    routeExecutionCostQuoteRaw: params.policy.routeExecutionCostQuoteRaw,
    nativeProfitFloorQuoteRaw: params.policy.nativeProfitFloorQuoteRaw,
    configuredProfitFloorQuoteRaw:
      params.policy.configuredProfitFloorQuoteRaw,
    slippageRiskBufferQuoteRaw: params.policy.slippageRiskBufferQuoteRaw,
    configuredMarketPriceFactor: params.configuredMarketPriceFactor,
    marketFactorFloorQuoteRaw: params.marketFactorFloorQuoteRaw,
    requiredProfitFloorQuoteRaw: params.policy.requiredProfitFloorQuoteRaw,
    requiredNonSubsidizedOutputRaw:
      params.policy.requiredNonSubsidizedOutputRaw,
    requiredOutputFloorQuoteRaw: params.policy.requiredOutputFloorQuoteRaw,
    expectedNetProfitQuoteRaw: params.policy.expectedNetProfitQuoteRaw,
    expectedShortfallQuoteRaw: params.policy.expectedShortfallQuoteRaw,
    surplusOverFloorQuoteRaw: params.policy.surplusOverFloorQuoteRaw,
    routeBreakEvenMarketPriceFactor:
      params.policy.routeBreakEvenMarketPriceFactor,
    effectiveMarketPriceFactor: params.policy.effectiveMarketPriceFactor,
    subsidyAllowed: params.policy.subsidyAllowed,
    expectedSubsidyQuoteRaw: params.policy.expectedSubsidyQuoteRaw,
    ...params.extras,
  };
}

export function mergeRoutePolicyIntoEvaluation(params: {
  evaluation: ExternalTakeQuoteEvaluation;
  policy: ExternalTakeRoutePolicyResult;
  auctionRepayRequirementQuoteRaw: BigNumber;
  configuredMarketPriceFactor: number;
  marketFactorFloorQuoteRaw: BigNumber;
  routeProfitabilityExtras?: RoutePolicyProfitabilityExtras;
}): ExternalTakeQuoteEvaluation {
  return {
    ...params.evaluation,
    routeMinOutRaw: params.policy.routeMinOutRaw,
    profitMinOutRaw: params.policy.profitMinOutRaw,
    approvedMinOutRaw: params.policy.approvedMinOutRaw,
    takeablePrice:
      params.evaluation.marketPrice !== undefined
        ? params.evaluation.marketPrice *
          params.policy.effectiveMarketPriceFactor
        : params.evaluation.takeablePrice,
    routeProfitability: mergeRoutePolicyIntoProfitability({
      existing: params.evaluation.routeProfitability,
      policy: params.policy,
      auctionRepayRequirementQuoteRaw:
        params.auctionRepayRequirementQuoteRaw,
      configuredMarketPriceFactor: params.configuredMarketPriceFactor,
      marketFactorFloorQuoteRaw: params.marketFactorFloorQuoteRaw,
      extras: params.routeProfitabilityExtras,
    }),
  };
}

/** True when a route was explicitly allowed to spend keeper P&L to execute. */
export function isSubsidizedExternalTakeQuote(params: {
  routeProfitability?: {
    subsidyAllowed?: boolean;
    expectedSubsidyQuoteRaw?: BigNumber;
  };
}): boolean {
  return !!(
    params.routeProfitability?.subsidyAllowed &&
    params.routeProfitability.expectedSubsidyQuoteRaw?.gt(0)
  );
}

/**
 * Shared ordering prefix for external-take route selection.
 *
 * Non-subsidized profitable routes always rank before subsidized routes. When
 * both routes are subsidized, the smaller expected subsidy wins before the
 * caller applies source-specific ranking and tie-breakers.
 */
export function compareExternalTakeBySubsidyThenRank<T>(
  left: T,
  right: T,
  params: {
    getQuote: (value: T) => {
      routeProfitability?: {
        subsidyAllowed?: boolean;
        expectedSubsidyQuoteRaw?: BigNumber;
      };
    };
    compareRank: (left: T, right: T) => number;
  }
): number {
  const leftQuote = params.getQuote(left);
  const rightQuote = params.getQuote(right);
  const leftSubsidized = isSubsidizedExternalTakeQuote(leftQuote);
  const rightSubsidized = isSubsidizedExternalTakeQuote(rightQuote);
  if (leftSubsidized !== rightSubsidized) {
    return leftSubsidized ? 1 : -1;
  }
  if (leftSubsidized && rightSubsidized) {
    const leftSubsidy =
      leftQuote.routeProfitability?.expectedSubsidyQuoteRaw ?? ZERO_BN;
    const rightSubsidy =
      rightQuote.routeProfitability?.expectedSubsidyQuoteRaw ?? ZERO_BN;
    if (!leftSubsidy.eq(rightSubsidy)) {
      return leftSubsidy.lt(rightSubsidy) ? -1 : 1;
    }
  }

  return params.compareRank(left, right);
}
