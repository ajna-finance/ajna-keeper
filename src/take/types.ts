import { BigNumber } from 'ethers';
import {
  CalldataAggregatorProviderId,
  ExternalTakePathKind,
  LiquiditySource,
  TakeSettings,
} from '../config';
import type { CalldataAggregatorLiquiditySource } from '../config';
import type { CurvePoolSelection } from '../dex/curve-pool-selection';
import { ApprovedCalldataAggregatorQuote } from './aggregator-calldata/types';

export type { CurvePoolSelection } from '../dex/curve-pool-selection';

export type GasPolicyRejectCode =
  | 'gas_price_above_cap'
  | 'native_gas_cost_above_cap'
  | 'quote_gas_cost_above_cap'
  | 'native_to_quote_conversion_unavailable'
  | 'wrapped_native_unconfigured'
  | 'provider_unavailable'
  | 'unknown';

export interface GasQuoteAttempt {
  source: LiquiditySource;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  feeTiers?: number[];
  success: boolean;
  amountOut?: string;
  reason?: string;
}

export interface RouteProfitabilityBreakdown {
  auctionRepayRequirementQuoteRaw?: BigNumber;
  routeExecutionCostQuoteRaw?: BigNumber;
  nativeProfitFloorQuoteRaw?: BigNumber;
  configuredProfitFloorQuoteRaw?: BigNumber;
  slippageRiskBufferQuoteRaw?: BigNumber;
  configuredMarketPriceFactor?: number;
  marketFactorFloorQuoteRaw?: BigNumber;
  requiredProfitFloorQuoteRaw?: BigNumber;
  requiredNonSubsidizedOutputRaw?: BigNumber;
  requiredOutputFloorQuoteRaw?: BigNumber;
  expectedNetProfitQuoteRaw?: BigNumber;
  expectedShortfallQuoteRaw?: BigNumber;
  surplusOverFloorQuoteRaw?: BigNumber;
  routeBreakEvenMarketPriceFactor?: number;
  effectiveMarketPriceFactor?: number;
  subsidyAllowed?: boolean;
  expectedSubsidyQuoteRaw?: BigNumber;
  routeGasLimit?: BigNumber;
  gasPriceWei?: BigNumber;
  gasPriceGwei?: number;
  gasPriceAgeMs?: number;
  gasPriceFreshnessTtlMs?: number;
  l2GasCostBufferBasisPoints?: number;
  gasPolicyEvaluatedAt?: number;
  gasPolicyRejectCode?: GasPolicyRejectCode;
  gasQuoteAttempts?: GasQuoteAttempt[];
}

export interface TakeActionConfig {
  name?: string;
  take: TakeSettings;
}

export type ExternalTakeStrategyKind =
  | 'none'
  | 'calldata_aggregator'
  | 'direct_dex'
  | 'hybrid';

export interface TakeBorrowerCandidate {
  borrower: string;
}

export interface ExternalTakeQuoteEvaluation {
  isTakeable: boolean;
  externalTakePath?: ExternalTakePathKind;
  marketPrice?: number;
  takeablePrice?: number;
  quoteAmount?: number;
  quoteAmountRaw?: BigNumber;
  quoteCircuitOpen?: boolean;
  quoteFailureRetryable?: boolean;
  quoteFailureCode?: number | string;
  selectedLiquiditySource?: LiquiditySource;
  providerId?: CalldataAggregatorProviderId;
  selectedFeeTier?: number;
  routeMinOutRaw?: BigNumber;
  profitMinOutRaw?: BigNumber;
  routeExecutionFloorRaw?: BigNumber;
  approvedMinOutRaw?: BigNumber;
  routeProfitability?: RouteProfitabilityBreakdown;
  collateralAmount?: number;
  quotedAuctionPriceWad?: BigNumber;
  quotedCollateralWad?: BigNumber;
  auctionIdentity?: string;
  curvePool?: CurvePoolSelection;
  calldataQuote?: ApprovedCalldataAggregatorQuote;
  reason?: string;
}

interface BoundExternalTakeRouteBase<TSource extends LiquiditySource>
  extends ExternalTakeQuoteEvaluation {
  isTakeable: true;
  quoteAmountRaw: BigNumber;
  selectedLiquiditySource: TSource;
  routeExecutionFloorRaw: BigNumber;
}

interface ApprovedExternalTakeQuoteBase<TSource extends LiquiditySource>
  extends ExternalTakeQuoteEvaluation {
  isTakeable: true;
  quoteAmountRaw: BigNumber;
  selectedLiquiditySource: TSource;
  approvedMinOutRaw: BigNumber;
}

export interface BoundUniswapV3DirectDexRouteEvaluation
  extends BoundExternalTakeRouteBase<LiquiditySource.UNISWAPV3> {
  externalTakePath: 'direct_dex';
  selectedFeeTier: number;
}

export interface ApprovedUniswapV3DirectDexQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.UNISWAPV3> {
  externalTakePath: 'direct_dex';
  selectedFeeTier: number;
}

export interface BoundCurveDirectDexRouteEvaluation
  extends BoundExternalTakeRouteBase<LiquiditySource.CURVE> {
  externalTakePath: 'direct_dex';
  curvePool: CurvePoolSelection;
}

export interface ApprovedCurveDirectDexQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.CURVE> {
  externalTakePath: 'direct_dex';
  curvePool: CurvePoolSelection;
}

export interface ApprovedCalldataAggregatorQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<CalldataAggregatorLiquiditySource> {
  externalTakePath: 'calldata_aggregator';
  providerId: CalldataAggregatorProviderId;
  calldataQuote: ApprovedCalldataAggregatorQuote;
}

export interface BoundCalldataAggregatorRouteEvaluation
  extends BoundExternalTakeRouteBase<CalldataAggregatorLiquiditySource> {
  externalTakePath: 'calldata_aggregator';
  providerId: CalldataAggregatorProviderId;
  calldataQuote: ApprovedCalldataAggregatorQuote;
}

export type BoundDirectDexRouteEvaluation =
  | BoundUniswapV3DirectDexRouteEvaluation
  | BoundCurveDirectDexRouteEvaluation;

export type ApprovedDirectDexQuoteEvaluation =
  | ApprovedUniswapV3DirectDexQuoteEvaluation
  | ApprovedCurveDirectDexQuoteEvaluation;

export type BoundExternalTakeRouteEvaluation =
  | BoundDirectDexRouteEvaluation
  | BoundCalldataAggregatorRouteEvaluation;

export interface ExternalTakeExecutionCandidate<TApprovalContext = unknown> {
  readonly evaluation: BoundExternalTakeRouteEvaluation;
  readonly approvalContext?: TApprovalContext;
}

export interface ExternalTakeExecutionPlan<TApprovalContext = unknown> {
  readonly primary: ExternalTakeExecutionCandidate<TApprovalContext>;
  readonly fallbacks: readonly ExternalTakeExecutionCandidate<TApprovalContext>[];
}

export type ExternalTakeEvaluationResult<TApprovalContext = unknown> =
  | {
      takeable: false;
      quoteEvaluation: ExternalTakeQuoteEvaluation;
      reason?: string;
    }
  | {
      takeable: true;
      executionPlan: ExternalTakeExecutionPlan<TApprovalContext>;
    };

export type ApprovedExternalTakeQuoteEvaluation =
  | ApprovedDirectDexQuoteEvaluation
  | ApprovedCalldataAggregatorQuoteEvaluation;

export interface ArbTakeEvaluation {
  isArbTakeable: boolean;
  hpbIndex: number;
  maxArbTakePrice?: number;
  reason?: string;
}

/**
 * The auction facts a take is sized and validated against, all from one
 * on-chain auction status read (WAD precision). `debtToCover` is optional
 * because some readers cannot surface it; consumers then degrade to
 * un-clamped (full collateral) sizing. Aggregator paths clamp their
 * quote/take size to the debt via src/take/take-sizing.ts.
 */
export interface AuctionTakeFacts {
  collateral: BigNumber;
  auctionPrice: BigNumber;
  debtToCover?: BigNumber;
}

export interface TakeLiquidationPlan<TApprovalContext = unknown>
  extends AuctionTakeFacts {
  borrower: string;
  hpbIndex: number;
  isTakeable: boolean;
  isArbTakeable: boolean;
  externalTakeExecutionPlan?: ExternalTakeExecutionPlan<TApprovalContext>;
}

interface TakeDecisionBase extends AuctionTakeFacts {
  approvedArbTake: boolean;
  borrower: string;
  hpbIndex: number;
  maxArbTakePrice?: number;
  reason?: string;
}

export type TakeDecision<TApprovalContext = unknown> =
  | (TakeDecisionBase & {
      approvedTake: true;
      takeablePrice?: number;
      externalTakeExecutionPlan: ExternalTakeExecutionPlan<TApprovalContext>;
    })
  | (TakeDecisionBase & {
      approvedTake: false;
      takeablePrice?: undefined;
      externalTakeExecutionPlan?: undefined;
    });

export interface TakeExecutionResult {
  executedTake: boolean;
  executedArbTake: boolean;
  submittedTransaction: boolean;
  poolStateMayHaveChanged: boolean;
}
