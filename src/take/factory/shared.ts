import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { quoteTokenScale } from '@ajna-finance/sdk/dist/contracts/pool';
import { BigNumber, ethers } from 'ethers';
import { KeeperConfig, LiquiditySource, PoolConfig } from '../../config';
import {
  SubgraphConfigInput,
  WithSubgraph,
} from '../../read-transports';
import { RequireFields } from '../../utils';
import { SushiSwapQuoteProvider } from '../../dex/providers/sushiswap-quote-provider';
import { UniswapV3QuoteProvider } from '../../dex/providers/uniswap-quote-provider';
import { ExternalTakeQuoteEvaluation, TakeLiquidationPlan } from '../types';
import { TakeWriteTransport } from '../write-transport';

export interface FactoryRouteCandidate {
  liquiditySource: LiquiditySource;
  feeTier?: number;
}

export interface FactoryRouteSelectionOptions {
  allowedLiquiditySources?: LiquiditySource[];
  routeQuoteBudgetPerCandidate?: number;
  routeProfitabilityContext?: FactoryRouteProfitabilityContext;
}

export interface FactoryRouteProfitabilityContext {
  routeExecutionCostQuoteRawBySource?: Partial<Record<LiquiditySource, BigNumber>>;
  nativeProfitFloorQuoteRawBySource?: Partial<Record<LiquiditySource, BigNumber>>;
  configuredProfitFloorQuoteRaw?: BigNumber;
  slippageRiskBufferQuoteRaw?: BigNumber;
  routeRejectionReasonsBySource?: Partial<Record<LiquiditySource, string>>;
}

type FactoryTakeConfigBase = Pick<
  KeeperConfig,
  | 'dryRun'
  | 'delayBetweenActions'
  | 'keeperTakerFactory'
  | 'takerContracts'
  | 'universalRouterOverrides'
  | 'sushiswapRouterOverrides'
  | 'curveRouterOverrides'
  | 'tokenAddresses'
>;

export type FactoryTakeConfig = WithSubgraph<FactoryTakeConfigBase>;
export type FactoryTakeConfigInput = SubgraphConfigInput<FactoryTakeConfigBase>;

export interface FactoryTakeParams {
  signer: Signer;
  takeWriteTransport?: TakeWriteTransport;
  pool: FungiblePool;
  poolConfig: RequireFields<PoolConfig, 'take'>;
  config: FactoryTakeConfigInput;
}

export type FactoryExecutionConfig = Pick<
  FactoryTakeConfig,
  | 'dryRun'
  | 'keeperTakerFactory'
  | 'universalRouterOverrides'
  | 'sushiswapRouterOverrides'
  | 'curveRouterOverrides'
  | 'tokenAddresses'
> & {
  takeWriteTransport?: TakeWriteTransport;
};

export type FactoryQuoteConfig = Pick<
  FactoryTakeConfig,
  | 'universalRouterOverrides'
  | 'sushiswapRouterOverrides'
  | 'curveRouterOverrides'
  | 'tokenAddresses'
>;

export interface FactoryQuoteProviderRuntimeCache {
  uniswapV3?: UniswapV3QuoteProvider | null;
  sushiswap?: SushiSwapQuoteProvider | null;
  curve?: any | null;
}

export function createFactoryQuoteProviderRuntimeCache(): FactoryQuoteProviderRuntimeCache {
  return {};
}

export const WAD = ethers.constants.WeiPerEther;
export const BASIS_POINTS_DENOMINATOR = 10_000;
export const MARKET_FACTOR_SCALE = 1_000_000;
const V1_FACTORY_FEE_TIERS = [500, 3000, 10000];
const ZERO = BigNumber.from(0);

export function ceilWmul(x: BigNumber, y: BigNumber): BigNumber {
  return x.mul(y).add(WAD.sub(1)).div(WAD);
}

export function ceilDiv(x: BigNumber, y: BigNumber): BigNumber {
  return x.add(y).sub(1).div(y);
}

export function maxBigNumber(...values: BigNumber[]): BigNumber {
  return values.reduce((max, value) => (value.gt(max) ? value : max), values[0]);
}

export async function getSwapDeadline(
  signer: Signer,
  ttlSeconds: number = 1800
): Promise<number> {
  const latestBlock = await signer.provider?.getBlock('latest');
  const baseTimestamp = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  return baseTimestamp + ttlSeconds;
}

export function getMarketPriceFactorUnits(marketPriceFactor: number): number {
  const scaled = Math.floor(marketPriceFactor * MARKET_FACTOR_SCALE);
  if (scaled <= 0) {
    throw new Error(`Factory: invalid marketPriceFactor ${marketPriceFactor}`);
  }
  return scaled;
}

export function getSlippageBasisPoints(defaultSlippage: number | undefined): number {
  const slippagePercentage = defaultSlippage ?? 1.0;
  const basisPoints = Math.floor(slippagePercentage * 100);
  return Math.max(0, Math.min(BASIS_POINTS_DENOMINATOR, basisPoints));
}

export function getEffectiveFactoryFeeTiers(
  defaultFeeTier: number,
  candidateFeeTiers?: number[]
): number[] {
  const tiers = candidateFeeTiers?.length
    ? candidateFeeTiers
    : [defaultFeeTier];
  const effective = [defaultFeeTier, ...tiers].filter((tier) =>
    V1_FACTORY_FEE_TIERS.includes(tier)
  );
  return Array.from(new Set(effective));
}

function isDynamicFactorySource(source: LiquiditySource): boolean {
  return (
    source === LiquiditySource.UNISWAPV3 ||
    source === LiquiditySource.SUSHISWAP
  );
}

export function getFactoryRouteCandidates(params: {
  defaultLiquiditySource: LiquiditySource;
  config: Pick<
    FactoryQuoteConfig,
    'universalRouterOverrides' | 'sushiswapRouterOverrides'
  >;
  selection?: FactoryRouteSelectionOptions;
}): FactoryRouteCandidate[] {
  const sources =
    params.selection?.allowedLiquiditySources?.length &&
    isDynamicFactorySource(params.defaultLiquiditySource)
      ? [
          params.defaultLiquiditySource,
          ...params.selection.allowedLiquiditySources,
        ]
      : [params.defaultLiquiditySource];

  const uniqueSources = Array.from(new Set(sources)).filter(isDynamicFactorySource);
  const routes: FactoryRouteCandidate[] = [];
  for (const source of uniqueSources) {
    if (source === LiquiditySource.UNISWAPV3) {
      const defaultFeeTier =
        params.config.universalRouterOverrides?.defaultFeeTier ?? 3000;
      for (const feeTier of getEffectiveFactoryFeeTiers(
        defaultFeeTier,
        params.config.universalRouterOverrides?.candidateFeeTiers
      )) {
        routes.push({ liquiditySource: source, feeTier });
      }
    }
    if (source === LiquiditySource.SUSHISWAP) {
      const defaultFeeTier =
        params.config.sushiswapRouterOverrides?.defaultFeeTier ?? 500;
      for (const feeTier of getEffectiveFactoryFeeTiers(
        defaultFeeTier,
        params.config.sushiswapRouterOverrides?.candidateFeeTiers
      )) {
        routes.push({ liquiditySource: source, feeTier });
      }
    }
  }

  const budget = params.selection?.routeQuoteBudgetPerCandidate;
  return budget !== undefined ? routes.slice(0, budget) : routes;
}

export async function getQuoteAmountDueRaw(
  pool: FungiblePool,
  auctionPrice: BigNumber,
  collateral: BigNumber
): Promise<BigNumber> {
  const scale = await quoteTokenScale(pool.contract);
  return ceilDiv(ceilWmul(collateral, auctionPrice), scale);
}

export async function computeFactoryAmountOutMinimum({
  pool,
  liquidation,
  quoteEvaluation,
  liquiditySource,
  config,
  marketPriceFactor,
}: {
  pool: FungiblePool;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  liquiditySource: LiquiditySource;
  config: Pick<
    FactoryExecutionConfig,
    'universalRouterOverrides' | 'sushiswapRouterOverrides' | 'curveRouterOverrides'
  >;
  marketPriceFactor: number;
}): Promise<BigNumber> {
  if (!quoteEvaluation.quoteAmountRaw) {
    throw new Error('Factory: quoteAmountRaw missing from evaluation');
  }

  const quoteAmountDueRaw = await getQuoteAmountDueRaw(
    pool,
    liquidation.auctionPrice,
    liquidation.collateral
  );
  const profitabilityFloor = ceilDiv(
    quoteAmountDueRaw.mul(MARKET_FACTOR_SCALE),
    BigNumber.from(getMarketPriceFactorUnits(marketPriceFactor))
  );

  let slippageBasisPoints = 100;
  if (liquiditySource === LiquiditySource.UNISWAPV3) {
    slippageBasisPoints = getSlippageBasisPoints(
      config.universalRouterOverrides?.defaultSlippage
    );
  } else if (liquiditySource === LiquiditySource.SUSHISWAP) {
    slippageBasisPoints = getSlippageBasisPoints(
      config.sushiswapRouterOverrides?.defaultSlippage
    );
  } else if (liquiditySource === LiquiditySource.CURVE) {
    slippageBasisPoints = getSlippageBasisPoints(
      config.curveRouterOverrides?.defaultSlippage
    );
  }

  const slippageFloor = quoteEvaluation.quoteAmountRaw
    .mul(BASIS_POINTS_DENOMINATOR - slippageBasisPoints)
    .div(BASIS_POINTS_DENOMINATOR);

  const floors = [quoteAmountDueRaw, profitabilityFloor, slippageFloor];
  if (quoteEvaluation.approvedMinOutRaw) {
    floors.push(quoteEvaluation.approvedMinOutRaw);
  }

  return maxBigNumber(...floors);
}

export async function buildFactoryQuoteEvaluation(params: {
  pool: FungiblePool;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  marketPriceFactor: number;
  quoteAmountRaw: BigNumber;
  quoteAmount: number;
  collateralAmount: number;
  selectedLiquiditySource: LiquiditySource;
  selectedFeeTier?: number;
  successReason?: string;
  failureReason: string;
}): Promise<ExternalTakeQuoteEvaluation> {
  const quoteAmountDueRaw = await getQuoteAmountDueRaw(
    params.pool,
    params.auctionPriceWad,
    params.collateral
  );
  const marketFactorFloorQuoteRaw = ceilDiv(
    quoteAmountDueRaw.mul(MARKET_FACTOR_SCALE),
    BigNumber.from(getMarketPriceFactorUnits(params.marketPriceFactor))
  );
  const isProfitable = params.quoteAmountRaw.gte(marketFactorFloorQuoteRaw);
  const grossProfitQuoteRaw = params.quoteAmountRaw.gte(quoteAmountDueRaw)
    ? params.quoteAmountRaw.sub(quoteAmountDueRaw)
    : ZERO;
  const surplusOverFloorQuoteRaw = params.quoteAmountRaw.gte(
    marketFactorFloorQuoteRaw
  )
    ? params.quoteAmountRaw.sub(marketFactorFloorQuoteRaw)
    : ZERO;

  return {
    isTakeable: isProfitable,
    marketPrice: params.quoteAmount / params.collateralAmount,
    takeablePrice:
      (params.quoteAmount / params.collateralAmount) *
      params.marketPriceFactor,
    quoteAmount: params.quoteAmount,
    quoteAmountRaw: params.quoteAmountRaw,
    selectedLiquiditySource: params.selectedLiquiditySource,
    selectedFeeTier: params.selectedFeeTier,
    approvedMinOutRaw: marketFactorFloorQuoteRaw,
    collateralAmount: params.collateralAmount,
    routeProfitability: {
      auctionRepayRequirementQuoteRaw: quoteAmountDueRaw,
      routeExecutionCostQuoteRaw: ZERO,
      nativeProfitFloorQuoteRaw: ZERO,
      configuredProfitFloorQuoteRaw: ZERO,
      slippageRiskBufferQuoteRaw: ZERO,
      marketFactorFloorQuoteRaw,
      requiredProfitFloorQuoteRaw: ZERO,
      requiredOutputFloorQuoteRaw: marketFactorFloorQuoteRaw,
      expectedNetProfitQuoteRaw: grossProfitQuoteRaw,
      surplusOverFloorQuoteRaw,
    },
    reason: isProfitable ? params.successReason : params.failureReason,
  };
}

export function applyFactoryRouteProfitabilityPolicy(params: {
  evaluation: ExternalTakeQuoteEvaluation;
  liquiditySource: LiquiditySource;
  context?: FactoryRouteProfitabilityContext;
}): ExternalTakeQuoteEvaluation {
  const rejectionReason =
    params.context?.routeRejectionReasonsBySource?.[params.liquiditySource];
  if (rejectionReason) {
    return {
      ...params.evaluation,
      isTakeable: false,
      reason: rejectionReason,
    };
  }

  if (!params.context || !params.evaluation.quoteAmountRaw) {
    return params.evaluation;
  }

  const routeProfitability = params.evaluation.routeProfitability;
  const auctionRepayRequirementQuoteRaw =
    routeProfitability?.auctionRepayRequirementQuoteRaw;
  if (!auctionRepayRequirementQuoteRaw) {
    return params.evaluation;
  }

  const routeExecutionCostQuoteRaw =
    params.context.routeExecutionCostQuoteRawBySource?.[
      params.liquiditySource
    ] ?? ZERO;
  const nativeProfitFloorQuoteRaw =
    params.context.nativeProfitFloorQuoteRawBySource?.[
      params.liquiditySource
    ] ?? ZERO;
  const configuredProfitFloorQuoteRaw =
    params.context.configuredProfitFloorQuoteRaw ?? ZERO;
  const slippageRiskBufferQuoteRaw =
    params.context.slippageRiskBufferQuoteRaw ?? ZERO;
  const marketFactorFloorQuoteRaw =
    routeProfitability.marketFactorFloorQuoteRaw ??
    auctionRepayRequirementQuoteRaw;
  const requiredProfitFloorQuoteRaw = maxBigNumber(
    nativeProfitFloorQuoteRaw,
    configuredProfitFloorQuoteRaw
  );
  const breakEvenQuoteAmountRaw = auctionRepayRequirementQuoteRaw
    .add(routeExecutionCostQuoteRaw)
    .add(slippageRiskBufferQuoteRaw);
  const requiredOutputFloorQuoteRaw = maxBigNumber(
    marketFactorFloorQuoteRaw,
    auctionRepayRequirementQuoteRaw
      .add(routeExecutionCostQuoteRaw)
      .add(requiredProfitFloorQuoteRaw)
      .add(slippageRiskBufferQuoteRaw)
  );
  const quoteAmountRaw = params.evaluation.quoteAmountRaw;
  const expectedNetProfitQuoteRaw = quoteAmountRaw.gte(breakEvenQuoteAmountRaw)
    ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
    : ZERO;
  const surplusOverFloorQuoteRaw = quoteAmountRaw.gte(requiredOutputFloorQuoteRaw)
    ? quoteAmountRaw.sub(requiredOutputFloorQuoteRaw)
    : ZERO;
  const approvedMinOutRaw = params.evaluation.approvedMinOutRaw
    ? maxBigNumber(
        params.evaluation.approvedMinOutRaw,
        requiredOutputFloorQuoteRaw
      )
    : requiredOutputFloorQuoteRaw;
  const isTakeable =
    params.evaluation.isTakeable && quoteAmountRaw.gte(requiredOutputFloorQuoteRaw);

  return {
    ...params.evaluation,
    isTakeable,
    reason: isTakeable
      ? params.evaluation.reason
      : 'route quote below required output floor',
    approvedMinOutRaw,
    routeProfitability: {
      ...routeProfitability,
      auctionRepayRequirementQuoteRaw,
      routeExecutionCostQuoteRaw,
      nativeProfitFloorQuoteRaw,
      configuredProfitFloorQuoteRaw,
      slippageRiskBufferQuoteRaw,
      marketFactorFloorQuoteRaw,
      requiredProfitFloorQuoteRaw,
      requiredOutputFloorQuoteRaw,
      expectedNetProfitQuoteRaw,
      surplusOverFloorQuoteRaw,
    },
  };
}
