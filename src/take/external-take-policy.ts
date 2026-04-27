import { BigNumber } from 'ethers';
import { ZERO_BN } from '../constants';

const MARKET_FACTOR_SCALE = 1_000_000;

function maxBigNumber(...values: BigNumber[]): BigNumber {
  return values.reduce(
    (max, value) => (value.gt(max) ? value : max),
    values[0]
  );
}

function ratioToNumber(numerator: BigNumber, denominator: BigNumber): number {
  if (denominator.isZero()) {
    return 0;
  }
  return (
    numerator.mul(MARKET_FACTOR_SCALE).div(denominator).toNumber() /
    MARKET_FACTOR_SCALE
  );
}

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
  requiredNonSubsidizedOutputRaw: BigNumber;
  requiredOutputFloorQuoteRaw: BigNumber;
  expectedNetProfitQuoteRaw: BigNumber;
  surplusOverFloorQuoteRaw: BigNumber;
  routeBreakEvenMarketPriceFactor: number;
  effectiveMarketPriceFactor: number;
  subsidyAllowed: boolean;
  expectedSubsidyQuoteRaw: BigNumber;
  rejectionReason?: string;
}

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
  if (!passesMarketThreshold) {
    rejectionReason = 'auction price above external take threshold';
  } else if (!isRepayable) {
    rejectionReason = 'route quote below repayment floor';
  } else if (!params.allowSubsidy && !isNonSubsidizedProfitable) {
    rejectionReason = 'route quote below required output floor';
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
    surplusOverFloorQuoteRaw,
    routeBreakEvenMarketPriceFactor,
    effectiveMarketPriceFactor,
    subsidyAllowed: params.allowSubsidy,
    expectedSubsidyQuoteRaw,
    rejectionReason,
  };
}

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
