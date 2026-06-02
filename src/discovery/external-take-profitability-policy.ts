import { BigNumber } from 'ethers';
import { LiquiditySource } from '../config';
import { WAD, ZERO_BN } from '../constants';
import { convertWadToTokenDecimalsCeil } from '../erc20';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
  mergeRoutePolicyIntoEvaluation,
} from '../take/external-take-policy';
import {
  applyFactoryRouteProfitabilityPolicy,
  ceilDiv,
  getMarketPriceFactorUnits,
  MARKET_FACTOR_SCALE,
} from '../take/factory/shared';
import {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeQuoteEvaluation,
  RouteProfitabilityBreakdown,
} from '../take/types';
import {
  DiscoveryExternalTakeApprovalMode,
  ExternalTakeApprovalResult,
} from './external-take-approval';
import { GasPolicyResult } from './gas-policy';
import { DiscoveryRpcCache } from './types';
import { ResolvedTakeTarget } from './targets';
import type { AutoDiscoverTakePolicyRuntime } from './external-take-quotes';
import type { DiscoveredTakeTargetStats } from './external-take-stats';
import { getApprovalGasTelemetryFields } from './external-take-gas-policy';

const ZERO = ZERO_BN;

export function getAuctionCostQuoteRaw(params: {
  price: BigNumber;
  collateral: BigNumber;
  quoteTokenDecimals: number;
}): BigNumber {
  const quoteDueWad = params.collateral
    .mul(params.price)
    .add(WAD.sub(1))
    .div(WAD);
  return convertWadToTokenDecimalsCeil(quoteDueWad, params.quoteTokenDecimals);
}

export function buildSimpleQuoteProfitability(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  auctionCostQuoteRaw: BigNumber;
  routeGasLimit: BigNumber;
  gasCostQuoteRaw?: BigNumber;
  gasPriceRaw?: BigNumber;
  gasPriceGwei?: number;
  gasPriceAgeMs?: number;
  gasPriceFreshnessTtlMs?: number;
  l2GasCostBufferBasisPoints?: number;
}): RouteProfitabilityBreakdown | undefined {
  const quoteAmountRaw = params.quoteEvaluation.quoteAmountRaw;
  if (!quoteAmountRaw) {
    return undefined;
  }

  const routeExecutionCostQuoteRaw = params.gasCostQuoteRaw ?? ZERO;
  const breakEvenQuoteAmountRaw = params.auctionCostQuoteRaw.add(
    routeExecutionCostQuoteRaw
  );
  return {
    ...params.quoteEvaluation.routeProfitability,
    auctionRepayRequirementQuoteRaw:
      params.quoteEvaluation.routeProfitability
        ?.auctionRepayRequirementQuoteRaw ?? params.auctionCostQuoteRaw,
    routeExecutionCostQuoteRaw,
    expectedNetProfitQuoteRaw: quoteAmountRaw.gte(breakEvenQuoteAmountRaw)
      ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
      : ZERO,
    expectedShortfallQuoteRaw: quoteAmountRaw.lt(breakEvenQuoteAmountRaw)
      ? breakEvenQuoteAmountRaw.sub(quoteAmountRaw)
      : ZERO,
    routeGasLimit: params.routeGasLimit,
    gasPriceWei: params.gasPriceRaw,
    gasPriceGwei: params.gasPriceGwei,
    gasPriceAgeMs: params.gasPriceAgeMs,
    gasPriceFreshnessTtlMs: params.gasPriceFreshnessTtlMs,
    l2GasCostBufferBasisPoints: params.l2GasCostBufferBasisPoints,
    gasPolicyEvaluatedAt: Date.now(),
  };
}

function rejectDiscoveryProfitFloor(params: {
  reason: string;
  countStats: boolean;
  stats: Pick<DiscoveredTakeTargetStats, 'profitFloorRejects'>;
}): ExternalTakeApprovalResult {
  if (params.countStats) {
    params.stats.profitFloorRejects += 1;
  }
  return {
    approved: false,
    reason: params.reason,
    rejectCategory: 'profitFloor',
  };
}

export function applyDiscoveryApprovalProfitabilityPolicy(params: {
  quoteEvaluation: BoundExternalTakeRouteEvaluation;
  selectedLiquiditySource: LiquiditySource;
  selectedFactoryLiquiditySource?: LiquiditySource;
  target: ResolvedTakeTarget;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  gasPolicy: GasPolicyResult;
  auctionCostQuoteRaw?: BigNumber;
  routeGasLimit: BigNumber;
  minExpectedProfitQuoteRaw: BigNumber;
  gasCostQuoteRaw?: BigNumber;
  quoteAmountRaw?: BigNumber;
  price: number;
  rpcCache?: DiscoveryRpcCache;
  approvalMode: DiscoveryExternalTakeApprovalMode;
  countStats: boolean;
  stats: Pick<DiscoveredTakeTargetStats, 'profitFloorRejects'>;
  bindExecutionRoute: (
    quoteEvaluation: ExternalTakeQuoteEvaluation
  ) => ExternalTakeApprovalResult;
}): ExternalTakeApprovalResult {
  const configuredMarketPriceFactor = params.target.take.marketPriceFactor;
  const canApplyRawRoutePolicy =
    params.quoteAmountRaw !== undefined &&
    (params.gasCostQuoteRaw !== undefined ||
      params.approvalMode === 'factory_gas_quote_fallback') &&
    params.auctionCostQuoteRaw !== undefined &&
    configuredMarketPriceFactor !== undefined;
  const gasTelemetryFields = getApprovalGasTelemetryFields({
    routeGasLimit: params.routeGasLimit,
    gasPolicy: params.gasPolicy,
    rpcCache: params.rpcCache,
    takePolicy: params.takePolicy,
  });

  if (
    params.selectedFactoryLiquiditySource !== undefined &&
    canApplyRawRoutePolicy
  ) {
    const auctionRepayRequirementQuoteRaw = params.auctionCostQuoteRaw;
    const marketPriceFactor = configuredMarketPriceFactor;
    if (
      auctionRepayRequirementQuoteRaw === undefined ||
      marketPriceFactor === undefined
    ) {
      return rejectDiscoveryProfitFloor({
        reason: 'route profitability context missing raw policy inputs',
        countStats: params.countStats,
        stats: params.stats,
      });
    }
    const marketFactorFloorQuoteRaw = ceilDiv(
      auctionRepayRequirementQuoteRaw.mul(MARKET_FACTOR_SCALE),
      BigNumber.from(getMarketPriceFactorUnits(marketPriceFactor))
    );
    const refreshedEvaluation = applyFactoryRouteProfitabilityPolicy({
      evaluation: {
        ...params.quoteEvaluation,
        routeProfitability: {
          ...params.quoteEvaluation.routeProfitability,
          auctionRepayRequirementQuoteRaw,
          configuredMarketPriceFactor: marketPriceFactor,
          marketFactorFloorQuoteRaw,
        },
      },
      liquiditySource: params.selectedFactoryLiquiditySource,
      context: {
        routeExecutionCostQuoteRawBySource: {
          [params.selectedFactoryLiquiditySource]: params.gasCostQuoteRaw,
        },
        nativeProfitFloorQuoteRawBySource: {
          [params.selectedFactoryLiquiditySource]:
            params.gasPolicy.minProfitNativeQuoteRaw ?? ZERO,
        },
        configuredProfitFloorQuoteRaw: params.minExpectedProfitQuoteRaw,
        allowSubsidy: params.target.take.allowSubsidy === true,
        routeGasLimitBySource: {
          [params.selectedFactoryLiquiditySource]: params.routeGasLimit,
        },
        gasPriceWei: gasTelemetryFields.gasPriceWei,
        gasPriceGwei: gasTelemetryFields.gasPriceGwei,
        gasPriceAgeMs: gasTelemetryFields.gasPriceAgeMs,
        gasPriceFreshnessTtlMs: gasTelemetryFields.gasPriceFreshnessTtlMs,
        l2GasCostBufferBasisPoints:
          gasTelemetryFields.l2GasCostBufferBasisPoints,
        gasPolicyEvaluatedAt: gasTelemetryFields.gasPolicyEvaluatedAt,
      },
    });
    if (!refreshedEvaluation.isTakeable) {
      return rejectDiscoveryProfitFloor({
        reason:
          refreshedEvaluation.reason ??
          EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor,
        countStats: params.countStats,
        stats: params.stats,
      });
    }
    return params.bindExecutionRoute(refreshedEvaluation);
  }

  if (canApplyRawRoutePolicy && configuredMarketPriceFactor !== undefined) {
    const quoteAmountRaw = params.quoteAmountRaw;
    const gasCostQuoteRaw = params.gasCostQuoteRaw;
    const auctionCostQuoteRaw = params.auctionCostQuoteRaw;
    if (
      quoteAmountRaw === undefined ||
      gasCostQuoteRaw === undefined ||
      auctionCostQuoteRaw === undefined
    ) {
      return rejectDiscoveryProfitFloor({
        reason: 'route profitability context missing raw policy inputs',
        countStats: params.countStats,
        stats: params.stats,
      });
    }
    const routeMinOutRaw =
      params.quoteEvaluation.routeMinOutRaw ??
      (params.quoteEvaluation.profitMinOutRaw
        ? undefined
        : params.quoteEvaluation.routeExecutionFloorRaw);
    const marketFactorFloorQuoteRaw =
      params.quoteEvaluation.routeProfitability?.marketFactorFloorQuoteRaw ??
      ceilDiv(
        auctionCostQuoteRaw.mul(MARKET_FACTOR_SCALE),
        BigNumber.from(getMarketPriceFactorUnits(configuredMarketPriceFactor))
      );
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor,
      allowSubsidy: params.target.take.allowSubsidy === true,
      quoteAmountRaw,
      quoteDueRaw: auctionCostQuoteRaw,
      marketFactorFloorQuoteRaw,
      routeMinOutRaw,
      routeExecutionCostQuoteRaw: gasCostQuoteRaw,
      configuredProfitFloorQuoteRaw: params.minExpectedProfitQuoteRaw,
      nativeProfitFloorQuoteRaw:
        params.gasPolicy.minProfitNativeQuoteRaw ?? ZERO,
    });
    if (!policy.isEconomicallyExecutable) {
      return rejectDiscoveryProfitFloor({
        reason:
          policy.rejectionReason ??
          EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor,
        countStats: params.countStats,
        stats: params.stats,
      });
    }
    const approvedQuoteEvaluation = mergeRoutePolicyIntoEvaluation({
      evaluation: params.quoteEvaluation,
      policy,
      auctionRepayRequirementQuoteRaw: auctionCostQuoteRaw,
      configuredMarketPriceFactor,
      marketFactorFloorQuoteRaw,
      routeProfitabilityExtras: gasTelemetryFields,
    });
    return params.bindExecutionRoute(approvedQuoteEvaluation);
  }

  const hasQuoteProfitFloor =
    params.takePolicy?.minExpectedProfitQuote !== undefined ||
    params.takePolicy?.minProfitNative !== undefined;
  if (!hasQuoteProfitFloor) {
    return { approved: true, quoteEvaluation: params.quoteEvaluation };
  }

  if (params.takePolicy?.minProfitNative !== undefined) {
    return rejectDiscoveryProfitFloor({
      reason: 'quote-normalized minProfitNative floor is not available',
      countStats: params.countStats,
      stats: params.stats,
    });
  }

  const auctionCostQuote =
    params.price * (params.quoteEvaluation.collateralAmount ?? 0);
  const expectedProfit =
    (params.quoteEvaluation.quoteAmount ?? 0) -
    auctionCostQuote -
    params.gasPolicy.gasCostQuote;
  if (
    params.takePolicy?.minExpectedProfitQuote !== undefined &&
    expectedProfit < params.takePolicy.minExpectedProfitQuote
  ) {
    return rejectDiscoveryProfitFloor({
      reason: `expected take profit ${expectedProfit.toFixed(6)} below minExpectedProfitQuote ${params.takePolicy.minExpectedProfitQuote}`,
      countStats: params.countStats,
      stats: params.stats,
    });
  }

  return { approved: true, quoteEvaluation: params.quoteEvaluation };
}
