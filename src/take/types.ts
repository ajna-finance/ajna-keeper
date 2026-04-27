import { BigNumber } from 'ethers';
import {
  CurvePoolType,
  ExternalTakePathKind,
  LiquiditySource,
  TakeSettings,
} from '../config';

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
  externalTakePath?: 'oneinch';
}

export interface ApprovedUniswapV3FactoryQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.UNISWAPV3> {
  externalTakePath?: 'factory';
  selectedFeeTier: number;
}

export interface ApprovedSushiSwapFactoryQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.SUSHISWAP> {
  externalTakePath?: 'factory';
  selectedFeeTier: number;
}

export interface ApprovedCurveFactoryQuoteEvaluation
  extends ApprovedExternalTakeQuoteBase<LiquiditySource.CURVE> {
  externalTakePath?: 'factory';
  curvePool: CurvePoolSelection;
}

export type ApprovedFactoryQuoteEvaluation =
  | ApprovedUniswapV3FactoryQuoteEvaluation
  | ApprovedSushiSwapFactoryQuoteEvaluation
  | ApprovedCurveFactoryQuoteEvaluation;

export type ApprovedExternalTakeQuoteEvaluation =
  | ApprovedOneInchQuoteEvaluation
  | ApprovedFactoryQuoteEvaluation;

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
