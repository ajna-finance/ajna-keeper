import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { quoteTokenScale } from '@ajna-finance/sdk/dist/contracts/pool';
import { BigNumber, ethers } from 'ethers';
import {
  DEFAULT_FEE_TIER_BY_SOURCE,
  KeeperConfig,
  LiquiditySource,
  LiquiditySourceMap,
  PoolConfig,
  STANDARD_V3_FEE_TIERS,
  formatLiquiditySource,
} from '../../config';
import { convertWadToTokenDecimals, getDecimalsErc20 } from '../../erc20';
import { logger } from '../../logging';
import { SubgraphConfigInput, WithSubgraph } from '../../read-transports';
import {
  getErrorMessage,
  RequireFields,
  mapWithConcurrencyPreservingOrder,
  withTimeout,
} from '../../utils';
import { CurveQuoteProvider } from '../../dex/providers/curve-quote-provider';
import { SushiSwapQuoteProvider } from '../../dex/providers/sushiswap-quote-provider';
import { UniswapV3QuoteProvider } from '../../dex/providers/uniswap-quote-provider';
import { ExternalTakeQuoteEvaluation, TakeLiquidationPlan } from '../types';
import { TakeWriteTransport } from '../write-transport';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
  compareExternalTakeBySubsidyThenRank,
} from '../external-take-policy';
import {
  BASIS_POINTS_DENOMINATOR,
  MARKET_FACTOR_SCALE,
  MAX_UINT24_FEE_TIER,
  WAD,
  ZERO_BN,
} from '../../constants';
export {
  BASIS_POINTS_DENOMINATOR,
  MARKET_FACTOR_SCALE,
  WAD,
} from '../../constants';

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
  routeProfitabilityContextFactory?: (
    sources: LiquiditySource[]
  ) => Promise<FactoryRouteProfitabilityContext | undefined>;
}

export interface FactoryRouteProfitabilityContext {
  routeExecutionCostQuoteRawBySource?: LiquiditySourceMap<BigNumber>;
  routeGasLimitBySource?: LiquiditySourceMap<BigNumber>;
  nativeProfitFloorQuoteRawBySource?: LiquiditySourceMap<BigNumber>;
  configuredProfitFloorQuoteRaw?: BigNumber;
  slippageRiskBufferQuoteRaw?: BigNumber;
  allowSubsidy?: boolean;
  routeRejectionReasonsBySource?: LiquiditySourceMap<string>;
  gasPriceWei?: BigNumber;
  gasPriceGwei?: number;
  gasPriceAgeMs?: number;
  gasPriceFreshnessTtlMs?: number;
  l2GasCostBufferBasisPoints?: number;
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
  chainId?: number;
  chainIdInflight?: Promise<number | undefined>;
  uniswapV3?: UniswapV3QuoteProvider | null;
  sushiswap?: SushiSwapQuoteProvider | null;
  sushiswapUnavailableUntilMs?: number;
  curve?: CurveQuoteProvider | null;
  curveUnavailableUntilMs?: number;
  tokenDecimals?: Map<string, number>;
  quoteTokenScales?: Map<string, BigNumber>;
  recentRouteSuccesses?: Map<string, number>;
}

export function createFactoryQuoteProviderRuntimeCache(): FactoryQuoteProviderRuntimeCache {
  return {};
}

const ZERO = ZERO_BN;
const MAX_RECENT_ROUTE_SUCCESSES = 512;
const MAX_TOKEN_DECIMAL_CACHE_ENTRIES = 512;
const MAX_QUOTE_TOKEN_SCALE_CACHE_ENTRIES = 512;
const FACTORY_ROUTE_AVAILABILITY_CONCURRENCY = 3;
const PROVIDER_INIT_FAILURE_RETRY_MS = 30_000;
const PROVIDER_INIT_FAILURE_RETRY_JITTER_BPS = 2_000;
export const DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS = 2_000;

function getProviderInitFailureRetryMs(): number {
  const jitterRangeMs = Math.floor(
    (PROVIDER_INIT_FAILURE_RETRY_MS * PROVIDER_INIT_FAILURE_RETRY_JITTER_BPS) /
      BASIS_POINTS_DENOMINATOR
  );
  return (
    PROVIDER_INIT_FAILURE_RETRY_MS -
    jitterRangeMs +
    Math.floor(Math.random() * (jitterRangeMs * 2 + 1))
  );
}

interface InitializableQuoteProvider {
  initialize(): Promise<boolean>;
}

async function initializeQuoteProviderWithCooldown<
  TProvider extends InitializableQuoteProvider,
>(params: {
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
  label: string;
  getCachedProvider: () => TProvider | null | undefined;
  setCachedProvider: (provider: TProvider | null) => void;
  getUnavailableUntilMs: () => number | undefined;
  setUnavailableUntilMs: (untilMs: number | undefined) => void;
  createProvider: () => TProvider;
}): Promise<TProvider | undefined> {
  let quoteProvider = params.getCachedProvider();
  const unavailableUntilMs = params.getUnavailableUntilMs();
  if (
    quoteProvider === undefined &&
    params.runtimeCache &&
    unavailableUntilMs !== undefined &&
    unavailableUntilMs > Date.now()
  ) {
    logger.debug(
      `${params.label} quote provider initialization cooldown active for ${Math.max(
        0,
        unavailableUntilMs - Date.now()
      )}ms`
    );
    return undefined;
  }

  if (quoteProvider === undefined) {
    const candidateProvider = params.createProvider();
    const initialized = await withTimeout(
      candidateProvider.initialize(),
      DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
      `${params.label} quote provider initialization`
    ).catch((error) => {
      logger.warn(
        `${params.label} quote provider initialization failed: ${getErrorMessage(error)}`
      );
      return false;
    });
    quoteProvider = initialized ? candidateProvider : null;
    if (params.runtimeCache) {
      if (quoteProvider) {
        if (unavailableUntilMs !== undefined) {
          logger.info(
            `${params.label} quote provider initialization recovered`
          );
        }
        params.setCachedProvider(quoteProvider);
        params.setUnavailableUntilMs(undefined);
      } else {
        const retryMs = getProviderInitFailureRetryMs();
        params.setUnavailableUntilMs(Date.now() + retryMs);
        logger.warn(
          `${params.label} quote provider unavailable; retrying initialization in ${retryMs}ms`
        );
      }
    }
  }

  return quoteProvider ?? undefined;
}

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

export function deriveApprovedMinOutRaw(params: {
  routeMinOutRaw?: BigNumber;
  profitMinOutRaw?: BigNumber;
  fallbackMinOutRaw?: BigNumber;
}): BigNumber | undefined {
  const splitFloors = [params.routeMinOutRaw, params.profitMinOutRaw].filter(
    (value): value is BigNumber => value !== undefined
  );
  if (splitFloors.length) {
    return maxBigNumber(...splitFloors);
  }
  return params.fallbackMinOutRaw;
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
  candidateFeeTiers?: number[],
  automaticCandidateFeeTiers?: readonly number[]
): number[] {
  const tiers =
    candidateFeeTiers !== undefined
      ? candidateFeeTiers
      : (automaticCandidateFeeTiers ?? [defaultFeeTier]);
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
  const source = formatLiquiditySource(route.liquiditySource);
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
      return formatLiquiditySource(source);
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
  const swapRouterAddress = routerConfig.swapRouterAddress;
  const factoryAddress = routerConfig.factoryAddress;
  const wethAddress = routerConfig.wethAddress;
  const quoterV2Address = routerConfig.quoterV2Address;

  return initializeQuoteProviderWithCooldown({
    runtimeCache: params.runtimeCache,
    label: 'SushiSwap',
    getCachedProvider: () => params.runtimeCache?.sushiswap,
    setCachedProvider: (provider) => {
      if (params.runtimeCache) {
        params.runtimeCache.sushiswap = provider;
      }
    },
    getUnavailableUntilMs: () =>
      params.runtimeCache?.sushiswapUnavailableUntilMs,
    setUnavailableUntilMs: (untilMs) => {
      if (params.runtimeCache) {
        params.runtimeCache.sushiswapUnavailableUntilMs = untilMs;
      }
    },
    createProvider: () =>
      new SushiSwapQuoteProvider(params.signer, {
        swapRouterAddress,
        quoterV2Address,
        factoryAddress,
        defaultFeeTier:
          routerConfig.defaultFeeTier ??
          DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP],
        wethAddress,
      }),
  });
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
  const poolConfigs = routerConfig.poolConfigs;
  const wethAddress = routerConfig.wethAddress;

  return initializeQuoteProviderWithCooldown({
    runtimeCache: params.runtimeCache,
    label: 'Curve',
    getCachedProvider: () => params.runtimeCache?.curve,
    setCachedProvider: (provider) => {
      if (params.runtimeCache) {
        params.runtimeCache.curve = provider;
      }
    },
    getUnavailableUntilMs: () => params.runtimeCache?.curveUnavailableUntilMs,
    setUnavailableUntilMs: (untilMs) => {
      if (params.runtimeCache) {
        params.runtimeCache.curveUnavailableUntilMs = untilMs;
      }
    },
    createProvider: () =>
      new CurveQuoteProvider(params.signer, {
        poolConfigs: poolConfigs as any,
        defaultSlippage: routerConfig.defaultSlippage ?? 1.0,
        wethAddress,
        tokenAddresses: params.tokenAddresses ?? {},
      }),
  });
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

interface V3StylePoolExistenceProvider {
  poolExists(tokenA: string, tokenB: string, feeTier: number): Promise<boolean>;
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

async function checkV3StyleRouteAvailability(
  params: FactoryRouteAvailabilityCheckParams & {
    label: string;
    quoteProvider: V3StylePoolExistenceProvider | undefined;
    configuredFeeTier?: number;
    defaultFeeTier: number;
  }
): Promise<FactoryRouteAvailabilityResult> {
  const { route } = params;
  if (!params.quoteProvider) {
    return unavailableFactoryRoute(
      route,
      `${params.label} quote provider unavailable`
    );
  }

  const feeTier =
    route.feeTier ?? params.configuredFeeTier ?? params.defaultFeeTier;
  let exists: boolean;
  try {
    exists = await withTimeout(
      params.quoteProvider.poolExists(
        params.pool.collateralAddress,
        params.pool.quoteAddress,
        feeTier
      ),
      DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
      `${params.label} pool existence check`
    );
  } catch (error) {
    return unavailableFactoryRoute(
      route,
      `${params.label} pool existence check failed: ${getErrorMessage(error)}`
    );
  }

  return exists
    ? availableFactoryRoute(route)
    : unavailableFactoryRoute(route, `${params.label} pool not found`);
}

async function checkUniswapV3RouteAvailability(
  params: FactoryRouteAvailabilityCheckParams
): Promise<FactoryRouteAvailabilityResult> {
  const quoteProvider = getUniswapV3QuoteProvider({
    signer: params.signer,
    routerConfig: params.config.universalRouterOverrides,
    runtimeCache: params.runtimeCache,
  });
  return await checkV3StyleRouteAvailability({
    ...params,
    label: 'Uniswap V3',
    quoteProvider,
    configuredFeeTier: params.config.universalRouterOverrides?.defaultFeeTier,
    defaultFeeTier: DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3],
  });
}

async function checkSushiSwapRouteAvailability(
  params: FactoryRouteAvailabilityCheckParams
): Promise<FactoryRouteAvailabilityResult> {
  const quoteProvider = await getSushiSwapQuoteProvider({
    signer: params.signer,
    routerConfig: params.config.sushiswapRouterOverrides,
    runtimeCache: params.runtimeCache,
  });
  return await checkV3StyleRouteAvailability({
    ...params,
    label: 'SushiSwap',
    quoteProvider,
    configuredFeeTier: params.config.sushiswapRouterOverrides?.defaultFeeTier,
    defaultFeeTier: DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP],
  });
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

  let exists: boolean;
  try {
    exists = await withTimeout(
      quoteProvider.poolExists(
        params.pool.collateralAddress,
        params.pool.quoteAddress
      ),
      DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
      'Curve pool existence check'
    );
  } catch (error) {
    return unavailableFactoryRoute(
      route,
      `Curve pool existence check failed: ${getErrorMessage(error)}`
    );
  }
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
  const availabilityResults = await mapWithConcurrencyPreservingOrder(
    params.routes,
    FACTORY_ROUTE_AVAILABILITY_CONCURRENCY,
    async (route) =>
      await checkFactoryRouteCandidateAvailability({
        ...params,
        route,
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

function compareFactoryRouteRank(
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
  return compareExternalTakeBySubsidyThenRank(left, right, {
    getQuote: (result) => result.evaluation,
    compareRank: (leftResult, rightResult) =>
      compareFactoryRouteRank(leftResult, rightResult, params),
  });
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
          params.config.universalRouterOverrides?.candidateFeeTiers,
          STANDARD_V3_FEE_TIERS
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
          params.config.sushiswapRouterOverrides?.candidateFeeTiers,
          STANDARD_V3_FEE_TIERS
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
  let chainId = runtimeCache?.chainId;
  if (
    runtimeCache &&
    chainId === undefined &&
    typeof signer.getChainId === 'function'
  ) {
    try {
      runtimeCache.chainIdInflight ??= signer.getChainId().catch((error) => {
        logger.debug(
          `Factory token decimals cache could not resolve chainId; using address-only fallback key: ${getErrorMessage(error)}`
        );
        return undefined;
      });
      const resolvedChainId = await runtimeCache.chainIdInflight;
      if (resolvedChainId !== undefined) {
        chainId = resolvedChainId;
        runtimeCache.chainId = resolvedChainId;
      }
    } finally {
      runtimeCache.chainIdInflight = undefined;
    }
  }
  const cacheKey = `${chainId ?? 'unknown'}:${tokenAddress.toLowerCase()}`;
  const cached = runtimeCache?.tokenDecimals?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const decimals = await getDecimalsErc20(signer, tokenAddress, chainId);
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
}: {
  pool: FungiblePool;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
}): Promise<BigNumber> {
  if (!quoteEvaluation.quoteAmountRaw) {
    throw new Error('Factory: quoteAmountRaw missing from evaluation');
  }
  const approvedMinOutRaw = deriveApprovedMinOutRaw({
    routeMinOutRaw: quoteEvaluation.routeMinOutRaw,
    profitMinOutRaw: quoteEvaluation.profitMinOutRaw,
    fallbackMinOutRaw: quoteEvaluation.approvedMinOutRaw,
  });
  if (!approvedMinOutRaw) {
    throw new Error('Factory: approvedMinOutRaw missing from evaluation');
  }

  const quoteAmountDueRaw = await getQuoteAmountDueRaw(
    pool,
    liquidation.auctionPrice,
    liquidation.collateral
  );
  if (approvedMinOutRaw.lt(quoteAmountDueRaw)) {
    throw new Error('Factory: approvedMinOutRaw below auction repayment floor');
  }

  return approvedMinOutRaw;
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
  allowSubsidy?: boolean;
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
  const routeMinOutRaw = params.existingSlippageFloorQuoteRaw;
  const policy = applyExternalTakeRoutePolicy({
    configuredMarketPriceFactor: marketPriceFactor,
    allowSubsidy: params.allowSubsidy === true,
    quoteAmountRaw: params.quoteAmountRaw,
    quoteDueRaw: quoteAmountDueRaw,
    marketFactorFloorQuoteRaw,
    routeMinOutRaw,
  });

  return {
    isTakeable: policy.isEconomicallyExecutable,
    externalTakePath: 'factory',
    marketPrice: params.quoteAmount / collateralAmount,
    takeablePrice:
      (params.quoteAmount / collateralAmount) *
      policy.effectiveMarketPriceFactor,
    quoteAmount: params.quoteAmount,
    quoteAmountRaw: params.quoteAmountRaw,
    selectedLiquiditySource: params.selectedLiquiditySource,
    selectedFeeTier: params.selectedFeeTier,
    routeMinOutRaw: policy.routeMinOutRaw,
    profitMinOutRaw: policy.profitMinOutRaw,
    approvedMinOutRaw: policy.approvedMinOutRaw,
    collateralAmount,
    quotedAuctionPriceWad: params.auctionPriceWad,
    quotedCollateralWad: params.collateral,
    routeProfitability: {
      auctionRepayRequirementQuoteRaw: quoteAmountDueRaw,
      routeExecutionCostQuoteRaw: policy.routeExecutionCostQuoteRaw,
      nativeProfitFloorQuoteRaw: policy.nativeProfitFloorQuoteRaw,
      configuredProfitFloorQuoteRaw: policy.configuredProfitFloorQuoteRaw,
      slippageRiskBufferQuoteRaw: policy.slippageRiskBufferQuoteRaw,
      configuredMarketPriceFactor: marketPriceFactor,
      marketFactorFloorQuoteRaw,
      requiredProfitFloorQuoteRaw: policy.requiredProfitFloorQuoteRaw,
      requiredNonSubsidizedOutputRaw: policy.requiredNonSubsidizedOutputRaw,
      requiredOutputFloorQuoteRaw: policy.requiredOutputFloorQuoteRaw,
      expectedNetProfitQuoteRaw: policy.expectedNetProfitQuoteRaw,
      surplusOverFloorQuoteRaw: policy.surplusOverFloorQuoteRaw,
      routeBreakEvenMarketPriceFactor: policy.routeBreakEvenMarketPriceFactor,
      effectiveMarketPriceFactor: policy.effectiveMarketPriceFactor,
      subsidyAllowed: policy.subsidyAllowed,
      expectedSubsidyQuoteRaw: policy.expectedSubsidyQuoteRaw,
      routeGasLimit: undefined,
    },
    reason: policy.isEconomicallyExecutable
      ? params.successReason
      : (policy.rejectionReason ?? params.failureReason),
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
    ceilDiv(
      auctionRepayRequirementQuoteRaw.mul(MARKET_FACTOR_SCALE),
      BigNumber.from(getMarketPriceFactorUnits(configuredMarketPriceFactor))
    );
  const requiredProfitFloorQuoteRaw = maxBigNumber(
    nativeProfitFloorQuoteRaw,
    configuredProfitFloorQuoteRaw
  );
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

  return {
    ...params.evaluation,
    isTakeable,
    reason: isTakeable
      ? params.evaluation.reason
      : (policy.rejectionReason ??
        EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor),
    routeMinOutRaw: policy.routeMinOutRaw,
    profitMinOutRaw: policy.profitMinOutRaw,
    approvedMinOutRaw: policy.approvedMinOutRaw,
    takeablePrice:
      params.evaluation.marketPrice !== undefined
        ? params.evaluation.marketPrice * policy.effectiveMarketPriceFactor
        : params.evaluation.takeablePrice,
    routeProfitability: {
      ...routeProfitability,
      auctionRepayRequirementQuoteRaw,
      routeExecutionCostQuoteRaw,
      nativeProfitFloorQuoteRaw,
      configuredProfitFloorQuoteRaw,
      slippageRiskBufferQuoteRaw,
      configuredMarketPriceFactor,
      marketFactorFloorQuoteRaw,
      requiredProfitFloorQuoteRaw,
      requiredNonSubsidizedOutputRaw: policy.requiredNonSubsidizedOutputRaw,
      requiredOutputFloorQuoteRaw: policy.requiredOutputFloorQuoteRaw,
      expectedNetProfitQuoteRaw: policy.expectedNetProfitQuoteRaw,
      surplusOverFloorQuoteRaw: policy.surplusOverFloorQuoteRaw,
      routeBreakEvenMarketPriceFactor: policy.routeBreakEvenMarketPriceFactor,
      effectiveMarketPriceFactor: policy.effectiveMarketPriceFactor,
      subsidyAllowed: policy.subsidyAllowed,
      expectedSubsidyQuoteRaw: policy.expectedSubsidyQuoteRaw,
      routeGasLimit,
      gasPriceWei: params.context.gasPriceWei,
      gasPriceGwei: params.context.gasPriceGwei,
      gasPriceAgeMs: params.context.gasPriceAgeMs,
      gasPriceFreshnessTtlMs: params.context.gasPriceFreshnessTtlMs,
      l2GasCostBufferBasisPoints: params.context.l2GasCostBufferBasisPoints,
      gasPolicyEvaluatedAt: params.context.gasPolicyEvaluatedAt,
    },
  };
}
