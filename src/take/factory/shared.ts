import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { quoteTokenScale } from '@ajna-finance/sdk/dist/contracts/pool';
import { BigNumber, ethers } from 'ethers';
import {
  DEFAULT_FEE_TIER_BY_SOURCE,
  KeeperConfig,
  LiquiditySource,
  LiquiditySourceMap,
  PoolConfig,
} from '../../config';
import { convertWadToTokenDecimals, getDecimalsErc20 } from '../../erc20';
import { SubgraphConfigInput, WithSubgraph } from '../../read-transports';
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
  routeExecutionCostQuoteRawBySource?: LiquiditySourceMap<BigNumber>;
  nativeProfitFloorQuoteRawBySource?: LiquiditySourceMap<BigNumber>;
  configuredProfitFloorQuoteRaw?: BigNumber;
  slippageRiskBufferQuoteRaw?: BigNumber;
  routeRejectionReasonsBySource?: LiquiditySourceMap<string>;
  gasPolicyEvaluatedAt?: number;
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
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
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
const MAX_UINT24_FEE_TIER = 16_777_215;
const ZERO = BigNumber.from(0);
const MAX_RECENT_ROUTE_SUCCESSES = 512;
const MAX_TOKEN_DECIMAL_CACHE_ENTRIES = 512;
const MAX_QUOTE_TOKEN_SCALE_CACHE_ENTRIES = 512;
const FACTORY_ROUTE_AVAILABILITY_CONCURRENCY = 3;

function pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    map.delete(oldestKey);
  }
}

export function ceilWmul(x: BigNumber, y: BigNumber): BigNumber {
  return x.mul(y).add(WAD.sub(1)).div(WAD);
}

export function ceilDiv(x: BigNumber, y: BigNumber): BigNumber {
  return x.add(y).sub(1).div(y);
}

export function maxBigNumber(...values: BigNumber[]): BigNumber {
  return values.reduce(
    (max, value) => (value.gt(max) ? value : max),
    values[0]
  );
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

export function getSlippageBasisPoints(
  defaultSlippage: number | undefined
): number {
  const slippagePercentage = defaultSlippage ?? 1.0;
  const basisPoints = Math.floor(slippagePercentage * 100);
  return Math.max(0, Math.min(BASIS_POINTS_DENOMINATOR, basisPoints));
}

export function getSlippageFloorQuoteRaw(
  quoteAmountRaw: BigNumber,
  defaultSlippage: number | undefined
): BigNumber {
  const slippageBasisPoints = getSlippageBasisPoints(defaultSlippage);
  return quoteAmountRaw
    .mul(BASIS_POINTS_DENOMINATOR - slippageBasisPoints)
    .div(BASIS_POINTS_DENOMINATOR);
}

export function getEffectiveFactoryFeeTiers(
  defaultFeeTier: number,
  candidateFeeTiers?: number[]
): number[] {
  const tiers = candidateFeeTiers?.length
    ? candidateFeeTiers
    : [defaultFeeTier];
  const effective = [defaultFeeTier, ...tiers].filter(isValidFactoryFeeTier);
  return Array.from(new Set(effective));
}

function isValidFactoryFeeTier(tier: number): boolean {
  return Number.isInteger(tier) && tier > 0 && tier <= MAX_UINT24_FEE_TIER;
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
    return (
      config.universalRouterOverrides?.defaultFeeTier ??
      DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3]
    );
  }
  if (source === LiquiditySource.SUSHISWAP) {
    return (
      config.sushiswapRouterOverrides?.defaultFeeTier ??
      DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP]
    );
  }
  return undefined;
}

export function formatFactoryRouteCandidate(
  route: FactoryRouteCandidate
): string {
  const source =
    LiquiditySource[route.liquiditySource] ?? route.liquiditySource;
  return route.feeTier !== undefined
    ? `${source}:${route.feeTier}`
    : `${source}:configured`;
}

function getFactoryRouteSourceLabel(source: LiquiditySource): string {
  switch (source) {
    case LiquiditySource.ONEINCH:
      return '1inch';
    case LiquiditySource.UNISWAPV3:
      return 'Uniswap V3';
    case LiquiditySource.SUSHISWAP:
      return 'SushiSwap';
    case LiquiditySource.CURVE:
      return 'Curve';
    default:
      return LiquiditySource[source] ?? String(source);
  }
}

export function formatFactoryQuoteRequestLog(params: {
  source: LiquiditySource;
  poolName: string;
  collateralAmount: string;
  feeTier?: number;
}): string {
  const feeTier =
    params.feeTier !== undefined ? ` feeTier=${params.feeTier}` : '';
  return `Factory: Getting ${getFactoryRouteSourceLabel(params.source)} quote for ${params.collateralAmount} collateral in pool ${params.poolName}${feeTier}`;
}

export function formatFactoryPriceCheckLog(params: {
  source: LiquiditySource;
  poolName: string;
  auctionPrice: number;
  marketPrice?: number;
  takeablePrice?: number;
  feeTier?: number;
  profitable: boolean;
}): string {
  const feeTier =
    params.feeTier !== undefined ? ` feeTier=${params.feeTier}` : '';
  return (
    `Factory: price check source=${getFactoryRouteSourceLabel(params.source)} pool=${params.poolName}` +
    ` auction=${params.auctionPrice.toFixed(4)}` +
    ` market=${(params.marketPrice ?? 0).toFixed(4)}` +
    ` takeable=${(params.takeablePrice ?? 0).toFixed(4)}` +
    `${feeTier} profitable=${params.profitable}`
  );
}

export function formatFactoryExecutionLog(params: {
  source: LiquiditySource;
  poolName: string;
  collateralWad: BigNumber;
  auctionPriceWad: BigNumber;
  minimalAmountOut: BigNumber;
  extraLines?: string[];
}): string {
  const extraLines = params.extraLines?.length
    ? `${params.extraLines.map((line) => `\n  ${line}`).join('')}`
    : '';
  return (
    `Factory: Executing ${getFactoryRouteSourceLabel(params.source)} take for pool ${params.poolName}:` +
    `${extraLines}\n` +
    `  Collateral (WAD): ${params.collateralWad.toString()}\n` +
    `  Auction Price (WAD): ${params.auctionPriceWad.toString()}\n` +
    `  Minimal Amount Out: ${params.minimalAmountOut.toString()} (quoted bound)`
  );
}

export function formatFactoryTakeSubmissionLog(params: {
  source: LiquiditySource;
  poolAddress: string;
  borrower: string;
}): string {
  return `Factory: Sending ${getFactoryRouteSourceLabel(params.source)} Take Tx - poolAddress: ${params.poolAddress}, borrower: ${params.borrower}`;
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
  return (
    defaultFeeTier === undefined || params.route.feeTier === defaultFeeTier
  );
}

const RECENT_ROUTE_SUCCESS_TTL_MS = 10 * 60 * 1000;

function pruneExpiredRouteSuccesses(
  successes: Map<string, number>,
  now: number
): void {
  for (const [key, timestamp] of Array.from(successes.entries())) {
    if (now - timestamp > RECENT_ROUTE_SUCCESS_TTL_MS) {
      successes.delete(key);
    }
  }
  pruneMapToMaxSize(successes, MAX_RECENT_ROUTE_SUCCESSES);
}

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
    pruneExpiredRouteSuccesses(successes, now);
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
      const leftHasRecentSuccess = left.recentSuccessAt > 0;
      const rightHasRecentSuccess = right.recentSuccessAt > 0;
      if (leftHasRecentSuccess !== rightHasRecentSuccess) {
        return leftHasRecentSuccess ? -1 : 1;
      }
      if (left.recentSuccessAt !== right.recentSuccessAt) {
        return right.recentSuccessAt - left.recentSuccessAt;
      }
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
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
  const now = Date.now();
  pruneExpiredRouteSuccesses(params.runtimeCache.recentRouteSuccesses, now);
  const routeKey = getFactoryRouteKey({
    route: params.route,
    collateralTokenAddress: params.pool.collateralAddress,
    quoteTokenAddress: params.pool.quoteAddress,
  });
  params.runtimeCache.recentRouteSuccesses.delete(routeKey);
  params.runtimeCache.recentRouteSuccesses.set(routeKey, now);
  pruneMapToMaxSize(
    params.runtimeCache.recentRouteSuccesses,
    MAX_RECENT_ROUTE_SUCCESSES
  );
}

export function getUniswapV3QuoteProvider(params: {
  signer: Signer;
  routerConfig?: FactoryQuoteConfig['universalRouterOverrides'];
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): UniswapV3QuoteProvider | undefined {
  const routerConfig = params.routerConfig;
  if (
    !routerConfig?.universalRouterAddress ||
    !routerConfig.poolFactoryAddress ||
    !routerConfig.wethAddress ||
    !routerConfig.quoterV2Address
  ) {
    return undefined;
  }

  let quoteProvider = params.runtimeCache?.uniswapV3;
  if (quoteProvider === undefined) {
    const candidateProvider = new UniswapV3QuoteProvider(params.signer, {
      universalRouterAddress: routerConfig.universalRouterAddress,
      poolFactoryAddress: routerConfig.poolFactoryAddress,
      defaultFeeTier:
        routerConfig.defaultFeeTier ??
        DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3],
      wethAddress: routerConfig.wethAddress,
      quoterV2Address: routerConfig.quoterV2Address,
    });
    quoteProvider = candidateProvider.isAvailable() ? candidateProvider : null;
    if (params.runtimeCache) {
      params.runtimeCache.uniswapV3 = quoteProvider;
    }
  }

  return quoteProvider && quoteProvider.isAvailable()
    ? quoteProvider
    : undefined;
}

export async function getSushiSwapQuoteProvider(params: {
  signer: Signer;
  routerConfig?: FactoryQuoteConfig['sushiswapRouterOverrides'];
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): Promise<SushiSwapQuoteProvider | undefined> {
  const routerConfig = params.routerConfig;
  if (
    !routerConfig?.swapRouterAddress ||
    !routerConfig.factoryAddress ||
    !routerConfig.wethAddress ||
    !routerConfig.quoterV2Address
  ) {
    return undefined;
  }

  let quoteProvider = params.runtimeCache?.sushiswap;
  if (quoteProvider === undefined) {
    const candidateProvider = new SushiSwapQuoteProvider(params.signer, {
      swapRouterAddress: routerConfig.swapRouterAddress,
      quoterV2Address: routerConfig.quoterV2Address,
      factoryAddress: routerConfig.factoryAddress,
      defaultFeeTier:
        routerConfig.defaultFeeTier ??
        DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP],
      wethAddress: routerConfig.wethAddress,
    });
    const initialized = await candidateProvider.initialize();
    quoteProvider = initialized ? candidateProvider : null;
    if (params.runtimeCache) {
      params.runtimeCache.sushiswap = quoteProvider;
    }
  }

  return quoteProvider ?? undefined;
}

export async function getCurveQuoteProvider(params: {
  signer: Signer;
  routerConfig?: FactoryQuoteConfig['curveRouterOverrides'];
  tokenAddresses?: FactoryQuoteConfig['tokenAddresses'];
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): Promise<CurveQuoteProvider | undefined> {
  const routerConfig = params.routerConfig;
  if (!routerConfig?.poolConfigs || !routerConfig.wethAddress) {
    return undefined;
  }

  let quoteProvider = params.runtimeCache?.curve;
  if (quoteProvider === undefined) {
    const candidateProvider = new CurveQuoteProvider(params.signer, {
      poolConfigs: routerConfig.poolConfigs as any,
      defaultSlippage: routerConfig.defaultSlippage ?? 1.0,
      wethAddress: routerConfig.wethAddress,
      tokenAddresses: params.tokenAddresses ?? {},
    });
    const initialized = await candidateProvider.initialize();
    quoteProvider = initialized ? candidateProvider : null;
    if (params.runtimeCache) {
      params.runtimeCache.curve = quoteProvider;
    }
  }

  return quoteProvider ?? undefined;
}

export interface FactoryRouteAvailabilitySkip {
  route: FactoryRouteCandidate;
  reason: string;
}

type FactoryRouteAvailabilityResult =
  | { route: FactoryRouteCandidate; available: true }
  | { route: FactoryRouteCandidate; available: false; reason: string };

interface FactoryRouteAvailabilityCheckParams {
  route: FactoryRouteCandidate;
  pool: Pick<FungiblePool, 'name' | 'collateralAddress' | 'quoteAddress'>;
  signer: Signer;
  config: FactoryQuoteConfig;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}

function availableFactoryRoute(
  route: FactoryRouteCandidate
): FactoryRouteAvailabilityResult {
  return { route, available: true };
}

function unavailableFactoryRoute(
  route: FactoryRouteCandidate,
  reason: string
): FactoryRouteAvailabilityResult {
  return { route, available: false, reason };
}

async function checkUniswapV3RouteAvailability(
  params: FactoryRouteAvailabilityCheckParams
): Promise<FactoryRouteAvailabilityResult> {
  const { route } = params;
  const quoteProvider = getUniswapV3QuoteProvider({
    signer: params.signer,
    routerConfig: params.config.universalRouterOverrides,
    runtimeCache: params.runtimeCache,
  });
  if (!quoteProvider) {
    return unavailableFactoryRoute(
      route,
      'Uniswap V3 quote provider unavailable'
    );
  }

  const feeTier =
    route.feeTier ??
    params.config.universalRouterOverrides?.defaultFeeTier ??
    DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3];
  let exists: boolean;
  try {
    exists = await quoteProvider.poolExists(
      params.pool.collateralAddress,
      params.pool.quoteAddress,
      feeTier
    );
  } catch (error) {
    return unavailableFactoryRoute(
      route,
      `Uniswap V3 pool existence check failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return exists
    ? availableFactoryRoute(route)
    : unavailableFactoryRoute(route, 'Uniswap V3 pool not found');
}

async function checkSushiSwapRouteAvailability(
  params: FactoryRouteAvailabilityCheckParams
): Promise<FactoryRouteAvailabilityResult> {
  const { route } = params;
  const quoteProvider = await getSushiSwapQuoteProvider({
    signer: params.signer,
    routerConfig: params.config.sushiswapRouterOverrides,
    runtimeCache: params.runtimeCache,
  });
  if (!quoteProvider) {
    return unavailableFactoryRoute(
      route,
      'SushiSwap quote provider unavailable'
    );
  }

  const feeTier =
    route.feeTier ??
    params.config.sushiswapRouterOverrides?.defaultFeeTier ??
    DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP];
  let exists: boolean;
  try {
    exists = await quoteProvider.poolExists(
      params.pool.collateralAddress,
      params.pool.quoteAddress,
      feeTier
    );
  } catch (error) {
    return unavailableFactoryRoute(
      route,
      `SushiSwap pool existence check failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return exists
    ? availableFactoryRoute(route)
    : unavailableFactoryRoute(route, 'SushiSwap pool not found');
}

async function checkCurveRouteAvailability(
  params: FactoryRouteAvailabilityCheckParams
): Promise<FactoryRouteAvailabilityResult> {
  const { route } = params;
  const quoteProvider = await getCurveQuoteProvider({
    signer: params.signer,
    routerConfig: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
    runtimeCache: params.runtimeCache,
  });
  if (!quoteProvider) {
    return unavailableFactoryRoute(route, 'Curve quote provider unavailable');
  }

  const exists = await quoteProvider.poolExists(
    params.pool.collateralAddress,
    params.pool.quoteAddress
  );
  return exists
    ? availableFactoryRoute(route)
    : unavailableFactoryRoute(
        route,
        'Curve pool not configured for token pair'
      );
}

async function checkFactoryRouteCandidateAvailability(
  params: FactoryRouteAvailabilityCheckParams
): Promise<FactoryRouteAvailabilityResult> {
  switch (params.route.liquiditySource) {
    case LiquiditySource.UNISWAPV3:
      return await checkUniswapV3RouteAvailability(params);
    case LiquiditySource.SUSHISWAP:
      return await checkSushiSwapRouteAvailability(params);
    case LiquiditySource.CURVE:
      return await checkCurveRouteAvailability(params);
    default:
      return unavailableFactoryRoute(
        params.route,
        `unsupported route source ${params.route.liquiditySource}`
      );
  }
}

export async function filterFactoryRouteCandidatesByAvailability(params: {
  routes: FactoryRouteCandidate[];
  pool: Pick<FungiblePool, 'name' | 'collateralAddress' | 'quoteAddress'>;
  signer: Signer;
  config: FactoryQuoteConfig;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): Promise<{
  availableRoutes: FactoryRouteCandidate[];
  unavailableRoutes: FactoryRouteAvailabilitySkip[];
}> {
  const availableRoutes: FactoryRouteCandidate[] = [];
  const unavailableRoutes: FactoryRouteAvailabilitySkip[] = [];
  const availabilityResults: FactoryRouteAvailabilityResult[] = new Array(
    params.routes.length
  );
  let nextRouteIndex = 0;
  const workerCount = Math.min(
    FACTORY_ROUTE_AVAILABILITY_CONCURRENCY,
    params.routes.length
  );

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextRouteIndex < params.routes.length) {
        const routeIndex = nextRouteIndex;
        nextRouteIndex += 1;
        availabilityResults[routeIndex] =
          await checkFactoryRouteCandidateAvailability({
            ...params,
            route: params.routes[routeIndex],
          });
      }
    })
  );

  for (const availability of availabilityResults) {
    if (availability.available) {
      availableRoutes.push(availability.route);
    } else {
      unavailableRoutes.push({
        route: availability.route,
        reason: availability.reason,
      });
    }
  }

  return { availableRoutes, unavailableRoutes };
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
    left.evaluation.routeProfitability?.expectedNetProfitQuoteRaw;
  const rightProfit =
    right.evaluation.routeProfitability?.expectedNetProfitQuoteRaw;
  if (!leftProfit || !rightProfit) {
    throw new Error(
      'Factory: takeable route missing expected net profit metadata'
    );
  }
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
  const takeableEvaluations = params.evaluations.filter(({ evaluation }) => {
    if (!evaluation.isTakeable || !evaluation.quoteAmountRaw) {
      return false;
    }
    if (!evaluation.routeProfitability?.expectedNetProfitQuoteRaw) {
      throw new Error(
        'Factory: takeable route missing expected net profit metadata'
      );
    }
    return true;
  });

  return takeableEvaluations.sort((left, right) =>
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
  const sources = params.selection?.allowedLiquiditySources?.length
    ? params.selection.allowedLiquiditySources
    : [params.defaultLiquiditySource];

  const uniqueSources = Array.from(new Set(sources)).filter(
    isDynamicFactorySource
  );
  const routesBySource = new Map<LiquiditySource, FactoryRouteCandidate[]>();
  for (const source of uniqueSources) {
    if (source === LiquiditySource.UNISWAPV3) {
      const defaultFeeTier =
        params.config.universalRouterOverrides?.defaultFeeTier ??
        DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3];
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
        params.config.sushiswapRouterOverrides?.defaultFeeTier ??
        DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP];
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
    pushFactoryRouteCandidate(
      orderedRoutes,
      seenRoutes,
      routesBySource.get(source)?.[0]
    );
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
    pruneMapToMaxSize(
      runtimeCache.tokenDecimals,
      MAX_TOKEN_DECIMAL_CACHE_ENTRIES
    );
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
  pruneMapToMaxSize(
    runtimeCache.quoteTokenScales,
    MAX_QUOTE_TOKEN_SCALE_CACHE_ENTRIES
  );
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
  const [
    collateralTokenDecimals,
    quoteTokenDecimals,
    auctionRepayRequirementQuoteRaw,
  ] = await Promise.all([
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
  marketPriceFactor,
}: {
  pool: FungiblePool;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  marketPriceFactor: number;
}): Promise<BigNumber> {
  if (!quoteEvaluation.quoteAmountRaw) {
    throw new Error('Factory: quoteAmountRaw missing from evaluation');
  }
  if (!quoteEvaluation.approvedMinOutRaw) {
    throw new Error('Factory: approvedMinOutRaw missing from evaluation');
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
  const minimumSanityFloor = maxBigNumber(
    quoteAmountDueRaw,
    profitabilityFloor
  );
  if (quoteEvaluation.approvedMinOutRaw.lt(minimumSanityFloor)) {
    throw new Error(
      'Factory: approvedMinOutRaw below auction repayment/market-factor floor'
    );
  }

  return quoteEvaluation.approvedMinOutRaw;
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
  existingSlippageFloorQuoteRaw?: BigNumber;
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
  const approvedMinOutRaw = params.existingSlippageFloorQuoteRaw
    ? maxBigNumber(
        marketFactorFloorQuoteRaw,
        params.existingSlippageFloorQuoteRaw
      )
    : marketFactorFloorQuoteRaw;

  return {
    isTakeable: isProfitable,
    externalTakePath: 'factory',
    marketPrice: params.quoteAmount / collateralAmount,
    takeablePrice: (params.quoteAmount / collateralAmount) * marketPriceFactor,
    quoteAmount: params.quoteAmount,
    quoteAmountRaw: params.quoteAmountRaw,
    selectedLiquiditySource: params.selectedLiquiditySource,
    selectedFeeTier: params.selectedFeeTier,
    approvedMinOutRaw,
    collateralAmount,
    quotedAuctionPriceWad: params.auctionPriceWad,
    quotedCollateralWad: params.collateral,
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
  const surplusOverFloorQuoteRaw = quoteAmountRaw.gte(
    requiredOutputFloorQuoteRaw
  )
    ? quoteAmountRaw.sub(requiredOutputFloorQuoteRaw)
    : ZERO;
  const approvedMinOutRaw = params.evaluation.approvedMinOutRaw
    ? maxBigNumber(
        params.evaluation.approvedMinOutRaw,
        requiredOutputFloorQuoteRaw
      )
    : requiredOutputFloorQuoteRaw;
  const isTakeable =
    params.evaluation.isTakeable &&
    quoteAmountRaw.gte(requiredOutputFloorQuoteRaw);

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
      gasPolicyEvaluatedAt: params.context.gasPolicyEvaluatedAt,
    },
  };
}
