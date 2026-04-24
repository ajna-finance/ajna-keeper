import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { quoteTokenScale } from '@ajna-finance/sdk/dist/contracts/pool';
import { BigNumber, ethers } from 'ethers';
import { KeeperConfig, LiquiditySource, PoolConfig } from '../../config';
import { convertWadToTokenDecimals, getDecimalsErc20 } from '../../erc20';
import {
  SubgraphConfigInput,
  WithSubgraph,
} from '../../read-transports';
import { RequireFields } from '../../utils';
import { CurveQuoteProvider } from '../../dex/providers/curve-quote-provider';
import { SushiSwapQuoteProvider } from '../../dex/providers/sushiswap-quote-provider';
import { UniswapV3QuoteProvider } from '../../dex/providers/uniswap-quote-provider';
import { ExternalTakeQuoteEvaluation, TakeLiquidationPlan } from '../types';
import { TakeWriteTransport } from '../write-transport';

export interface FactoryRouteCandidate {
  liquiditySource: LiquiditySource;
  feeTier?: number;
}

export interface FactoryRouteEvaluationContext {
  quoteTokenAddress: string;
  collateralTokenAddress: string;
  quoteTokenDecimals: number;
  collateralTokenDecimals: number;
  collateralInTokenDecimals: BigNumber;
  collateralAmount: number;
  auctionPriceWad: BigNumber;
  collateralWad: BigNumber;
  auctionRepayRequirementQuoteRaw: BigNumber;
  marketPriceFactor: number;
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
  curve?: CurveQuoteProvider | null;
  tokenDecimals?: Map<string, number>;
  quoteTokenScales?: Map<string, BigNumber>;
  recentRouteSuccesses?: Map<string, number>;
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
    source === LiquiditySource.SUSHISWAP ||
    source === LiquiditySource.CURVE
  );
}

export function getDefaultFactoryFeeTierForSource(
  source: LiquiditySource,
  config: Pick<
    FactoryQuoteConfig,
    'universalRouterOverrides' | 'sushiswapRouterOverrides'
  >
): number | undefined {
  if (source === LiquiditySource.UNISWAPV3) {
    return config.universalRouterOverrides?.defaultFeeTier ?? 3000;
  }
  if (source === LiquiditySource.SUSHISWAP) {
    return config.sushiswapRouterOverrides?.defaultFeeTier ?? 500;
  }
  return undefined;
}

export function formatFactoryRouteCandidate(route: FactoryRouteCandidate): string {
  const source = LiquiditySource[route.liquiditySource] ?? route.liquiditySource;
  return route.feeTier !== undefined
    ? `${source}:${route.feeTier}`
    : `${source}:configured`;
}

export function getFactoryRouteKey(params: {
  route: FactoryRouteCandidate;
  collateralTokenAddress: string;
  quoteTokenAddress: string;
}): string {
  return [
    params.route.liquiditySource,
    params.route.feeTier ?? 'configured',
    params.collateralTokenAddress.toLowerCase(),
    params.quoteTokenAddress.toLowerCase(),
  ].join(':');
}

function isDefaultFactoryRoute(params: {
  route: FactoryRouteCandidate;
  defaultLiquiditySource: LiquiditySource;
  config: Pick<
    FactoryQuoteConfig,
    'universalRouterOverrides' | 'sushiswapRouterOverrides'
  >;
}): boolean {
  if (params.route.liquiditySource !== params.defaultLiquiditySource) {
    return false;
  }
  const defaultFeeTier = getDefaultFactoryFeeTierForSource(
    params.route.liquiditySource,
    params.config
  );
  return defaultFeeTier === undefined || params.route.feeTier === defaultFeeTier;
}

const RECENT_ROUTE_SUCCESS_TTL_MS = 10 * 60 * 1000;

export function orderFactoryRouteCandidates(params: {
  routes: FactoryRouteCandidate[];
  defaultLiquiditySource: LiquiditySource;
  config: Pick<
    FactoryQuoteConfig,
    'universalRouterOverrides' | 'sushiswapRouterOverrides'
  >;
  pool: Pick<FungiblePool, 'collateralAddress' | 'quoteAddress'>;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): FactoryRouteCandidate[] {
  const now = Date.now();
  const successes = params.runtimeCache?.recentRouteSuccesses;
  if (successes) {
    for (const [key, timestamp] of Array.from(successes.entries())) {
      if (now - timestamp > RECENT_ROUTE_SUCCESS_TTL_MS) {
        successes.delete(key);
      }
    }
  }

  return params.routes
    .map((route, index) => {
      const key = getFactoryRouteKey({
        route,
        collateralTokenAddress: params.pool.collateralAddress,
        quoteTokenAddress: params.pool.quoteAddress,
      });
      return {
        route,
        index,
        isDefault: isDefaultFactoryRoute({
          route,
          defaultLiquiditySource: params.defaultLiquiditySource,
          config: params.config,
        }),
        recentSuccessAt: successes?.get(key) ?? 0,
      };
    })
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      if (left.recentSuccessAt !== right.recentSuccessAt) {
        return right.recentSuccessAt - left.recentSuccessAt;
      }
      return left.index - right.index;
    })
    .map(({ route }) => route);
}

export function recordFactoryRouteSuccess(params: {
  route: FactoryRouteCandidate;
  pool: Pick<FungiblePool, 'collateralAddress' | 'quoteAddress'>;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): void {
  if (!params.runtimeCache) {
    return;
  }
  if (!params.runtimeCache.recentRouteSuccesses) {
    params.runtimeCache.recentRouteSuccesses = new Map();
  }
  params.runtimeCache.recentRouteSuccesses.set(
    getFactoryRouteKey({
      route: params.route,
      collateralTokenAddress: params.pool.collateralAddress,
      quoteTokenAddress: params.pool.quoteAddress,
    }),
    Date.now()
  );
}

export interface FactoryRouteEvaluationResult {
  route: FactoryRouteCandidate;
  evaluation: ExternalTakeQuoteEvaluation;
}

function compareFactoryRouteEvaluations(
  left: FactoryRouteEvaluationResult,
  right: FactoryRouteEvaluationResult,
  params: {
    defaultLiquiditySource: LiquiditySource;
    config: Pick<
      FactoryQuoteConfig,
      'universalRouterOverrides' | 'sushiswapRouterOverrides'
    >;
  }
): number {
  const leftProfit =
    left.evaluation.routeProfitability?.expectedNetProfitQuoteRaw ??
    left.evaluation.quoteAmountRaw!;
  const rightProfit =
    right.evaluation.routeProfitability?.expectedNetProfitQuoteRaw ??
    right.evaluation.quoteAmountRaw!;
  if (!leftProfit.eq(rightProfit)) {
    return leftProfit.gt(rightProfit) ? -1 : 1;
  }

  if (
    left.route.liquiditySource === params.defaultLiquiditySource &&
    right.route.liquiditySource !== params.defaultLiquiditySource
  ) {
    return -1;
  }
  if (
    left.route.liquiditySource !== params.defaultLiquiditySource &&
    right.route.liquiditySource === params.defaultLiquiditySource
  ) {
    return 1;
  }

  const leftDefaultFeeTier = getDefaultFactoryFeeTierForSource(
    left.route.liquiditySource,
    params.config
  );
  const rightDefaultFeeTier = getDefaultFactoryFeeTierForSource(
    right.route.liquiditySource,
    params.config
  );
  const leftUsesDefaultFeeTier =
    leftDefaultFeeTier !== undefined &&
    left.route.feeTier === leftDefaultFeeTier;
  const rightUsesDefaultFeeTier =
    rightDefaultFeeTier !== undefined &&
    right.route.feeTier === rightDefaultFeeTier;
  if (leftUsesDefaultFeeTier !== rightUsesDefaultFeeTier) {
    return leftUsesDefaultFeeTier ? -1 : 1;
  }

  const leftQuote = left.evaluation.quoteAmountRaw!;
  const rightQuote = right.evaluation.quoteAmountRaw!;
  if (!leftQuote.eq(rightQuote)) {
    return leftQuote.gt(rightQuote) ? -1 : 1;
  }

  return 0;
}

export function selectBestFactoryRouteEvaluation(params: {
  evaluations: FactoryRouteEvaluationResult[];
  defaultLiquiditySource: LiquiditySource;
  config: Pick<
    FactoryQuoteConfig,
    'universalRouterOverrides' | 'sushiswapRouterOverrides'
  >;
}): FactoryRouteEvaluationResult | undefined {
  return params.evaluations
    .filter(
      ({ evaluation }) => evaluation.isTakeable && evaluation.quoteAmountRaw
    )
    .sort((left, right) =>
      compareFactoryRouteEvaluations(left, right, {
        defaultLiquiditySource: params.defaultLiquiditySource,
        config: params.config,
      })
    )[0];
}

function pushFactoryRouteCandidate(
  routes: FactoryRouteCandidate[],
  seen: Set<string>,
  route: FactoryRouteCandidate | undefined
): void {
  if (!route) {
    return;
  }

  const key = `${route.liquiditySource}:${route.feeTier ?? 'configured'}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  routes.push(route);
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
  const routesBySource = new Map<LiquiditySource, FactoryRouteCandidate[]>();
  for (const source of uniqueSources) {
    if (source === LiquiditySource.UNISWAPV3) {
      const defaultFeeTier =
        params.config.universalRouterOverrides?.defaultFeeTier ?? 3000;
      routesBySource.set(
        source,
        getEffectiveFactoryFeeTiers(
          defaultFeeTier,
          params.config.universalRouterOverrides?.candidateFeeTiers
        ).map((feeTier) => ({ liquiditySource: source, feeTier }))
      );
    }
    if (source === LiquiditySource.SUSHISWAP) {
      const defaultFeeTier =
        params.config.sushiswapRouterOverrides?.defaultFeeTier ?? 500;
      routesBySource.set(
        source,
        getEffectiveFactoryFeeTiers(
          defaultFeeTier,
          params.config.sushiswapRouterOverrides?.candidateFeeTiers
        ).map((feeTier) => ({ liquiditySource: source, feeTier }))
      );
    }
    if (source === LiquiditySource.CURVE) {
      routesBySource.set(source, [{ liquiditySource: source }]);
    }
  }

  const orderedRoutes: FactoryRouteCandidate[] = [];
  const seenRoutes = new Set<string>();

  for (const source of uniqueSources) {
    pushFactoryRouteCandidate(orderedRoutes, seenRoutes, routesBySource.get(source)?.[0]);
  }
  for (const source of uniqueSources) {
    for (const route of routesBySource.get(source)?.slice(1) ?? []) {
      pushFactoryRouteCandidate(orderedRoutes, seenRoutes, route);
    }
  }

  return orderedRoutes;
}

export async function getQuoteAmountDueRaw(
  pool: FungiblePool,
  auctionPrice: BigNumber,
  collateral: BigNumber,
  runtimeCache?: FactoryQuoteProviderRuntimeCache
): Promise<BigNumber> {
  const scale = await getCachedQuoteTokenScale(pool, runtimeCache);
  return ceilDiv(ceilWmul(collateral, auctionPrice), scale);
}

export async function getCachedFactoryTokenDecimals(
  signer: Signer,
  tokenAddress: string,
  runtimeCache?: FactoryQuoteProviderRuntimeCache
): Promise<number> {
  const cacheKey = tokenAddress.toLowerCase();
  const cached = runtimeCache?.tokenDecimals?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const decimals = await getDecimalsErc20(signer, tokenAddress);
  if (runtimeCache) {
    if (!runtimeCache.tokenDecimals) {
      runtimeCache.tokenDecimals = new Map();
    }
    runtimeCache.tokenDecimals.set(cacheKey, decimals);
  }
  return decimals;
}

async function getCachedQuoteTokenScale(
  pool: FungiblePool,
  runtimeCache?: FactoryQuoteProviderRuntimeCache
): Promise<BigNumber> {
  if (!runtimeCache) {
    return await quoteTokenScale(pool.contract);
  }

  const poolAddress =
    'poolAddress' in pool && typeof pool.poolAddress === 'string'
      ? pool.poolAddress
      : undefined;
  const poolKey = poolAddress
    ? poolAddress.toLowerCase()
    : pool.collateralAddress && pool.quoteAddress
      ? `${pool.collateralAddress.toLowerCase()}:${pool.quoteAddress.toLowerCase()}`
      : undefined;
  if (!poolKey) {
    return await quoteTokenScale(pool.contract);
  }

  const cached = runtimeCache?.quoteTokenScales?.get(poolKey);
  if (cached) {
    return cached;
  }

  const scale = await quoteTokenScale(pool.contract);
  if (!runtimeCache.quoteTokenScales) {
    runtimeCache.quoteTokenScales = new Map();
  }
  runtimeCache.quoteTokenScales.set(poolKey, scale);
  return scale;
}

export async function buildFactoryRouteEvaluationContext(params: {
  pool: FungiblePool;
  signer: Signer;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  marketPriceFactor: number;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): Promise<FactoryRouteEvaluationContext> {
  const [collateralTokenDecimals, quoteTokenDecimals, auctionRepayRequirementQuoteRaw] =
    await Promise.all([
      getCachedFactoryTokenDecimals(
        params.signer,
        params.pool.collateralAddress,
        params.runtimeCache
      ),
      getCachedFactoryTokenDecimals(
        params.signer,
        params.pool.quoteAddress,
        params.runtimeCache
      ),
      getQuoteAmountDueRaw(
        params.pool,
        params.auctionPriceWad,
        params.collateral,
        params.runtimeCache
      ),
    ]);
  const collateralInTokenDecimals = convertWadToTokenDecimals(
    params.collateral,
    collateralTokenDecimals
  );
  return {
    quoteTokenAddress: params.pool.quoteAddress,
    collateralTokenAddress: params.pool.collateralAddress,
    quoteTokenDecimals,
    collateralTokenDecimals,
    collateralInTokenDecimals,
    collateralAmount: Number(
      ethers.utils.formatUnits(
        collateralInTokenDecimals,
        collateralTokenDecimals
      )
    ),
    auctionPriceWad: params.auctionPriceWad,
    collateralWad: params.collateral,
    auctionRepayRequirementQuoteRaw,
    marketPriceFactor: params.marketPriceFactor,
  };
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
  routeContext?: FactoryRouteEvaluationContext;
  successReason?: string;
  failureReason: string;
}): Promise<ExternalTakeQuoteEvaluation> {
  const quoteAmountDueRaw =
    params.routeContext?.auctionRepayRequirementQuoteRaw ??
    (await getQuoteAmountDueRaw(
      params.pool,
      params.auctionPriceWad,
      params.collateral
    ));
  const marketPriceFactor =
    params.routeContext?.marketPriceFactor ?? params.marketPriceFactor;
  const collateralAmount =
    params.routeContext?.collateralAmount ?? params.collateralAmount;
  const marketFactorFloorQuoteRaw = ceilDiv(
    quoteAmountDueRaw.mul(MARKET_FACTOR_SCALE),
    BigNumber.from(getMarketPriceFactorUnits(marketPriceFactor))
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
    marketPrice: params.quoteAmount / collateralAmount,
    takeablePrice:
      (params.quoteAmount / collateralAmount) *
      marketPriceFactor,
    quoteAmount: params.quoteAmount,
    quoteAmountRaw: params.quoteAmountRaw,
    selectedLiquiditySource: params.selectedLiquiditySource,
    selectedFeeTier: params.selectedFeeTier,
    approvedMinOutRaw: marketFactorFloorQuoteRaw,
    collateralAmount,
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
