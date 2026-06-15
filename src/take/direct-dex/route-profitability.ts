import { LiquiditySource } from '../../config';
import { ZERO_BN } from '../../constants';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
  mergeRoutePolicyIntoEvaluation,
} from '../external-take/policy';
import { getMarketFactorFloorQuoteRaw } from '../external-take/quote-economics';
import { ExternalTakeQuoteEvaluation } from '../types';
import { DirectDexRouteProfitabilityContext } from './route-types';

const ZERO = ZERO_BN;

export function applyDirectDexRouteProfitabilityPolicy(params: {
  evaluation: ExternalTakeQuoteEvaluation;
  liquiditySource: LiquiditySource;
  context?: DirectDexRouteProfitabilityContext;
}): ExternalTakeQuoteEvaluation {
  const rejectionReason =
    params.context?.routeRejectionReasonsBySource?.[params.liquiditySource];
  if (rejectionReason) {
    return {
      ...params.evaluation,
      isTakeable: false,
      reason: rejectionReason,
      routeProfitability: {
        ...params.evaluation.routeProfitability,
        gasPolicyRejectCode:
          params.context?.gasPolicyRejectCodeBySource?.[params.liquiditySource],
        gasQuoteAttempts:
          params.context?.gasQuoteAttemptsBySource?.[params.liquiditySource],
      },
    };
  }

  if (!params.context || !params.evaluation.quoteAmountRaw) {
    return params.evaluation;
  }

  const routeProfitability = params.evaluation.routeProfitability;
  const auctionRepayRequirementQuoteRaw =
    routeProfitability?.auctionRepayRequirementQuoteRaw;
  if (!auctionRepayRequirementQuoteRaw) {
    return {
      ...params.evaluation,
      isTakeable: false,
      reason: 'route profitability context missing auction repay requirement',
    };
  }

  const routeExecutionCostQuoteRaw =
    params.context.routeExecutionCostQuoteRawBySource?.[
      params.liquiditySource
    ] ?? ZERO;
  const routeGasLimit =
    params.context.routeGasLimitBySource?.[params.liquiditySource];
  const nativeProfitFloorQuoteRaw =
    params.context.nativeProfitFloorQuoteRawBySource?.[
      params.liquiditySource
    ] ?? ZERO;
  const configuredProfitFloorQuoteRaw =
    params.context.configuredProfitFloorQuoteRaw ?? ZERO;
  const slippageRiskBufferQuoteRaw =
    params.context.slippageRiskBufferQuoteRaw ?? ZERO;
  const configuredMarketPriceFactor =
    routeProfitability.configuredMarketPriceFactor;
  if (!configuredMarketPriceFactor || configuredMarketPriceFactor <= 0) {
    return {
      ...params.evaluation,
      isTakeable: false,
      reason: 'route profitability context missing market price factor',
    };
  }
  const marketFactorFloorQuoteRaw =
    routeProfitability.marketFactorFloorQuoteRaw ??
    getMarketFactorFloorQuoteRaw({
      quoteAmountDueRaw: auctionRepayRequirementQuoteRaw,
      marketPriceFactor: configuredMarketPriceFactor,
    });
  const quoteAmountRaw = params.evaluation.quoteAmountRaw;
  const routeMinOutRaw =
    params.evaluation.routeMinOutRaw ??
    (params.evaluation.profitMinOutRaw
      ? undefined
      : params.evaluation.approvedMinOutRaw);
  const policy = applyExternalTakeRoutePolicy({
    configuredMarketPriceFactor,
    allowSubsidy: params.context.allowSubsidy === true,
    quoteAmountRaw,
    quoteDueRaw: auctionRepayRequirementQuoteRaw,
    marketFactorFloorQuoteRaw,
    routeMinOutRaw,
    routeExecutionCostQuoteRaw,
    configuredProfitFloorQuoteRaw,
    nativeProfitFloorQuoteRaw,
    slippageRiskBufferQuoteRaw,
  });
  const isTakeable =
    params.evaluation.isTakeable && policy.isEconomicallyExecutable;

  return mergeRoutePolicyIntoEvaluation({
    evaluation: {
      ...params.evaluation,
      isTakeable,
      reason: isTakeable
        ? params.evaluation.reason
        : (policy.rejectionReason ??
          EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor),
    },
    policy,
    auctionRepayRequirementQuoteRaw,
    configuredMarketPriceFactor,
    marketFactorFloorQuoteRaw,
    routeProfitabilityExtras: {
      routeGasLimit,
      gasPriceWei: params.context.gasPriceWei,
      gasPriceGwei: params.context.gasPriceGwei,
      gasPriceAgeMs: params.context.gasPriceAgeMs,
      gasPriceFreshnessTtlMs: params.context.gasPriceFreshnessTtlMs,
      l2GasCostBufferBasisPoints: params.context.l2GasCostBufferBasisPoints,
      gasPolicyEvaluatedAt: params.context.gasPolicyEvaluatedAt,
      gasPolicyRejectCode:
        params.context.gasPolicyRejectCodeBySource?.[params.liquiditySource],
      gasQuoteAttempts:
        params.context.gasQuoteAttemptsBySource?.[params.liquiditySource],
    },
  });
}
