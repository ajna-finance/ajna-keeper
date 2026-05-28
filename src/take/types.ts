import { BigNumber } from 'ethers';
import { ApprovedLifiQuote } from '../dex/lifi';
import {
  CurvePoolType,
  ExternalTakePathKind,
  LiquiditySource,
  TakeSettings,
} from '../config';

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
  | 'oneinch'
  | 'factory'
  | 'hybrid';

export interface TakeBorrowerCandidate {
  borrower: string;
}

export interface ExternalTakeQuoteEvaluation {
  isTakeable: boolean;
  externalTakePath?: ExternalTakePathKind;
  approvalMode?: 'strict_hybrid' | 'factory_gas_quote_fallback';
  marketPrice?: number;
  takeablePrice?: number;
  quoteAmount?: number;
  quoteAmountRaw?: BigNumber;
  quoteFailureRetryable?: boolean;
  quoteFailureCode?: number | string;
  selectedLiquiditySource?: LiquiditySource;
  selectedFeeTier?: number;
  routeMinOutRaw?: BigNumber;
  profitMinOutRaw?: BigNumber;
  approvedMinOutRaw?: BigNumber;
  routeProfitability?: RouteProfitabilityBreakdown;
  collateralAmount?: number;
  quotedAuctionPriceWad?: BigNumber;
  quotedCollateralWad?: BigNumber;
  auctionIdentity?: string;
  fallbackExternalTakeQuoteEvaluations?: ExternalTakeQuoteEvaluation[];
  curvePool?: CurvePoolSelection;
  lifiQuote?: ApprovedLifiQuote;
  reason?: string;
}

export interface CurvePoolSelection {
  address: string;
  poolType: CurvePoolType;
  tokenInIndex: number;
  tokenOutIndex: number;
}

interface ApprovedExternalTakeQuoteBase<TSource extends LiquiditySource>
  extends ExternalTakeQuoteEvaluation {
  isTakeable: true;
  quoteAmountRaw: BigNumber;
  selectedLiquiditySource: TSource;
  approvedMinOutRaw: BigNumber;
}

export interface ApprovedOneInchQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.ONEINCH> {
  externalTakePath: 'oneinch';
}

export interface ApprovedUniswapV3FactoryQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.UNISWAPV3> {
  externalTakePath: 'factory';
  selectedFeeTier: number;
}

export interface ApprovedSushiSwapFactoryQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.SUSHISWAP> {
  externalTakePath: 'factory';
  selectedFeeTier: number;
}

export interface ApprovedCurveFactoryQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.CURVE> {
  externalTakePath: 'factory';
  curvePool: CurvePoolSelection;
}

export interface ApprovedLifiQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.LIFI> {
  externalTakePath: 'lifi';
  lifiQuote: ApprovedLifiQuote;
}

export type ApprovedFactoryQuoteEvaluation =
  | ApprovedUniswapV3FactoryQuoteEvaluation
  | ApprovedSushiSwapFactoryQuoteEvaluation
  | ApprovedCurveFactoryQuoteEvaluation;

export type ApprovedExternalTakeQuoteEvaluation =
  | ApprovedOneInchQuoteEvaluation
  | ApprovedFactoryQuoteEvaluation
  | ApprovedLifiQuoteEvaluation;

export interface ArbTakeEvaluation {
  isArbTakeable: boolean;
  hpbIndex: number;
  maxArbTakePrice?: number;
  reason?: string;
}

export interface TakeLiquidationPlan {
  borrower: string;
  hpbIndex: number;
  collateral: BigNumber; // WAD
  auctionPrice: BigNumber; // WAD
  isTakeable: boolean;
  isArbTakeable: boolean;
  externalTakeQuoteEvaluation?: ExternalTakeQuoteEvaluation;
}

export interface TakeDecision {
  approvedTake: boolean;
  approvedArbTake: boolean;
  borrower: string;
  hpbIndex: number;
  collateral: BigNumber;
  auctionPrice: BigNumber;
  takeablePrice?: number;
  maxArbTakePrice?: number;
  quoteEvaluation?: ExternalTakeQuoteEvaluation;
  reason?: string;
}

export interface TakeExecutionResult {
  executedTake: boolean;
  executedArbTake: boolean;
  submittedTransaction: boolean;
  poolStateMayHaveChanged: boolean;
}
