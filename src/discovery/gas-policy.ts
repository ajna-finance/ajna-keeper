import { Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  AutoDiscoverActionPolicy,
  AutoDiscoverTakePolicy,
  DEFAULT_FEE_TIER_BY_SOURCE,
  LiquiditySource,
  STANDARD_V3_FEE_TIERS,
  formatLiquiditySource,
  getEffectiveV3FeeTiers,
  hasConfiguredGasQuoteLiquiditySource,
  resolveUniswapV3FactoryQuoteConfig,
  resolveConfiguredGasQuoteLiquiditySource,
  resolveConfiguredWrappedNativeAddress,
} from '../config';
import {
  createDiscoveryReadTransports,
  DiscoveryReadTransportConfig,
  DiscoveryReadTransports,
} from '../read-transports';
import { logger } from '../logging';
import { DexRouter } from '../dex/router';
import { convertWadToTokenDecimalsCeil, getDecimalsErc20 } from '../erc20';
import {
  DiscoveryExecutionConfig,
  DiscoveryExecutionTransportConfig,
  DiscoveryRpcCache,
} from './types';
import {
  DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
  getCurveQuoteProvider,
  getSushiSwapQuoteProvider,
  getUniswapV3QuoteProvider,
} from '../take/factory/shared';
import { GasPolicyRejectCode, GasQuoteAttempt } from '../take/types';
import {
  DEFAULT_ONEINCH_QUOTE_TIMEOUT_MS,
  getOneInchCircuitOpenReason,
  recordOneInchQuoteFailure,
  recordOneInchQuoteSuccess,
} from './one-inch-circuit';
import { ceilDivBigNumber, getErrorMessage, withTimeout } from '../utils';
import { BASIS_POINTS_DENOMINATOR_BN } from '../constants';

export interface GasPolicyResult {
  approved: boolean;
  gasCostNative: number;
  gasCostQuote: number;
  gasCostQuoteRaw?: BigNumber;
  minProfitNativeQuoteRaw?: BigNumber;
  gasPriceRaw?: BigNumber;
  gasPriceGwei: number;
  gasLimit?: BigNumber;
  l2GasCostBufferBasisPoints?: number;
  quoteTokenDecimals?: number;
  rejectCode?: GasPolicyRejectCode;
  gasQuoteAttempts?: GasQuoteAttempt[];
  reason?: string;
}

export const DEFAULT_L2_GAS_COST_BUFFER_BASIS_POINTS = 13_000;
export const DEFAULT_L1_DISCOVERY_GAS_PRICE_TTL_MS = 5 * 1000;
export const DEFAULT_L2_DISCOVERY_GAS_PRICE_TTL_MS = 15 * 1000;
const GAS_QUOTE_CONVERSION_CACHE_TTL_MS = 30 * 1000;
const FALLBACK_GAS_QUOTE_CONVERSION_CACHE_TTL_MS = 5 * 1000;
const MAX_GAS_QUOTE_CONVERSION_CACHE_ENTRIES = 256;

interface L2ChainProfile {
  stableGas: boolean;
  dataFeeBuffer: boolean;
}

const L2_CHAIN_PROFILES: Record<number, L2ChainProfile> = {
  10: { stableGas: true, dataFeeBuffer: true },
  8453: { stableGas: true, dataFeeBuffer: true },
  42161: { stableGas: true, dataFeeBuffer: true },
  11155420: { stableGas: true, dataFeeBuffer: true },
  84532: { stableGas: true, dataFeeBuffer: true },
  421614: { stableGas: true, dataFeeBuffer: true },
};

function hasL2ChainProfileFlag(
  chainId: number | undefined,
  flag: keyof L2ChainProfile
): boolean {
  return chainId !== undefined && L2_CHAIN_PROFILES[chainId]?.[flag] === true;
}

export function getDiscoveryGasPriceFreshnessTtlMs(
  policy?: Pick<
    AutoDiscoverTakePolicy,
    'l1GasPriceFreshnessTtlMs' | 'l2GasPriceFreshnessTtlMs'
  >,
  chainId?: number
): number {
  if (hasL2ChainProfileFlag(chainId, 'stableGas')) {
    return (
      policy?.l2GasPriceFreshnessTtlMs ?? DEFAULT_L2_DISCOVERY_GAS_PRICE_TTL_MS
    );
  }
  return (
    policy?.l1GasPriceFreshnessTtlMs ?? DEFAULT_L1_DISCOVERY_GAS_PRICE_TTL_MS
  );
}

function applyL2GasCostBuffer(
  gasCostNativeRaw: BigNumber,
  chainId?: number,
  bufferBasisPoints: number = DEFAULT_L2_GAS_COST_BUFFER_BASIS_POINTS
): BigNumber {
  if (!hasL2ChainProfileFlag(chainId, 'dataFeeBuffer')) {
    return gasCostNativeRaw;
  }
  return gasCostNativeRaw
    .mul(BigNumber.from(bufferBasisPoints))
    .add(BASIS_POINTS_DENOMINATOR_BN.sub(1))
    .div(BASIS_POINTS_DENOMINATOR_BN);
}

function convertNativeWadToQuoteRaw(
  nativeWadAmount: BigNumber,
  quoteDecimals: number
): BigNumber {
  return convertWadToTokenDecimalsCeil(nativeWadAmount, quoteDecimals);
}

function apportionCombinedNativeQuote(params: {
  gasCostNativeRaw: BigNumber;
  combinedNativeRaw: BigNumber;
  combinedQuoteRaw: BigNumber;
}): {
  gasCostQuoteRaw: BigNumber;
  minProfitNativeQuoteRaw: BigNumber;
} {
  if (params.combinedNativeRaw.isZero()) {
    return {
      gasCostQuoteRaw: BigNumber.from(0),
      minProfitNativeQuoteRaw: BigNumber.from(0),
    };
  }

  const rawGasCostQuote = ceilDivBigNumber(
    params.combinedQuoteRaw.mul(params.gasCostNativeRaw),
    params.combinedNativeRaw
  );
  const gasCostQuoteRaw = rawGasCostQuote.gt(params.combinedQuoteRaw)
    ? params.combinedQuoteRaw
    : rawGasCostQuote;
  return {
    gasCostQuoteRaw,
    minProfitNativeQuoteRaw: params.combinedQuoteRaw.sub(gasCostQuoteRaw),
  };
}

export function getEffectiveL2GasCostBufferBasisPoints(
  policy?: Pick<AutoDiscoverTakePolicy, 'l2GasCostBufferBasisPoints'>,
  chainId?: number
): number | undefined {
  if (!hasL2ChainProfileFlag(chainId, 'dataFeeBuffer')) {
    return undefined;
  }
  return (
    policy?.l2GasCostBufferBasisPoints ??
    DEFAULT_L2_GAS_COST_BUFFER_BASIS_POINTS
  );
}

export function createDiscoveryTransportsForConfig(
  config: DiscoveryExecutionTransportConfig,
  signer: Signer
): DiscoveryReadTransports {
  return createDiscoveryReadTransports(
    config as unknown as DiscoveryReadTransportConfig,
    signer.provider,
    async () => await signer.getChainId()
  );
}

export function logDiscoveryDecision(
  config: DiscoveryExecutionConfig,
  message: string
): void {
  if (config.autoDiscover?.logSkips) {
    logger.info(message);
  } else {
    logger.debug(message);
  }
}

export function resolveWrappedNativeAddress(
  config: DiscoveryExecutionConfig,
  liquiditySource?: LiquiditySource
): string | undefined {
  return resolveConfiguredWrappedNativeAddress(config, liquiditySource);
}

function resolveGasQuoteSource(
  config: DiscoveryExecutionConfig,
  chainId?: number
): LiquiditySource | undefined {
  return resolveConfiguredGasQuoteLiquiditySource(config, chainId);
}

async function tryResolveSignerChainId(
  signer: Signer
): Promise<number | undefined> {
  const maybeSigner = signer as Signer & { getChainId?: () => Promise<number> };
  return typeof maybeSigner.getChainId === 'function'
    ? await maybeSigner.getChainId()
    : undefined;
}

function getGasQuoteSourceCandidates(params: {
  config: DiscoveryExecutionConfig;
  chainId?: number;
  preferredLiquiditySource?: LiquiditySource;
  resolvedLiquiditySource?: LiquiditySource;
}): LiquiditySource[] {
  const candidates: LiquiditySource[] = [];
  const pushIfConfigured = (source: LiquiditySource | undefined) => {
    if (
      source !== undefined &&
      !candidates.includes(source) &&
      hasConfiguredGasQuoteLiquiditySource(
        params.config,
        source,
        params.chainId
      )
    ) {
      candidates.push(source);
    }
  };

  pushIfConfigured(params.preferredLiquiditySource);
  pushIfConfigured(params.resolvedLiquiditySource);
  for (const source of [
    LiquiditySource.ONEINCH,
    LiquiditySource.UNISWAPV3,
    LiquiditySource.SUSHISWAP,
    LiquiditySource.CURVE,
  ]) {
    pushIfConfigured(source);
  }

  return candidates;
}

function getGasQuoteFeeTiers(
  defaultFeeTier: number | undefined,
  candidateFeeTiers: number[] | undefined,
  fallbackFeeTier: number,
  automaticCandidateFeeTiers?: readonly number[]
): number[] {
  return getEffectiveV3FeeTiers({
    defaultFeeTier,
    fallbackFeeTier,
    candidateFeeTiers,
    automaticCandidateFeeTiers,
  });
}

interface FactoryV3GasQuoteProvider {
  poolExists(
    tokenA: string,
    tokenB: string,
    feeTier?: number
  ): Promise<boolean>;
  getQuote(
    amountIn: BigNumber,
    tokenIn: string,
    tokenOut: string,
    feeTier?: number
  ): Promise<{ success: boolean; dstAmount?: BigNumber | string }>;
}

interface GasQuoteSourceResult {
  amountOut?: BigNumber;
  reason?: string;
  feeTiers?: number[];
}

async function quoteFactoryV3GasConversion(params: {
  quoteProvider: FactoryV3GasQuoteProvider;
  amountIn: BigNumber;
  tokenIn: string;
  tokenOut: string;
  defaultFeeTier?: number;
  candidateFeeTiers?: number[];
  fallbackFeeTier: number;
  automaticCandidateFeeTiers?: readonly number[];
}): Promise<GasQuoteSourceResult> {
  let bestQuote: BigNumber | undefined;
  let sawPool = false;
  let sawQuoteFailure = false;
  const feeTiers = getGasQuoteFeeTiers(
    params.defaultFeeTier,
    params.candidateFeeTiers,
    params.fallbackFeeTier,
    params.automaticCandidateFeeTiers
  );
  for (const feeTier of feeTiers) {
    try {
      const poolExists = await withTimeout(
        params.quoteProvider.poolExists(
          params.tokenIn,
          params.tokenOut,
          feeTier
        ),
        DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
        'factory gas quote pool existence check'
      );
      if (!poolExists) {
        continue;
      }
      sawPool = true;
      const quoteResult = await withTimeout(
        params.quoteProvider.getQuote(
          params.amountIn,
          params.tokenIn,
          params.tokenOut,
          feeTier
        ),
        DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
        'factory gas quote'
      );
      if (quoteResult.success && quoteResult.dstAmount) {
        const quote = BigNumber.from(quoteResult.dstAmount);
        if (quote.isZero()) {
          sawQuoteFailure = true;
          logger.debug(
            `Gas quote conversion returned zero output for ${params.tokenIn}/${params.tokenOut} fee=${feeTier}`
          );
          continue;
        }
        // Use the highest output to conservatively price gas in quote-token terms.
        bestQuote = bestQuote && bestQuote.gt(quote) ? bestQuote : quote;
      } else {
        sawQuoteFailure = true;
      }
    } catch (error) {
      sawQuoteFailure = true;
      logger.debug(
        `Factory gas quote conversion skipped fee=${feeTier} for ${params.tokenIn}/${params.tokenOut}: ${getErrorMessage(error)}`
      );
    }
  }
  if (bestQuote) {
    return { amountOut: bestQuote, feeTiers };
  }
  return {
    feeTiers,
    reason: sawPool
      ? sawQuoteFailure
        ? 'factory pool exists but returned no usable gas quote'
        : 'factory pool exists but no usable gas quote was returned'
      : 'no factory pool at configured fee tiers',
  };
}

function getGasQuoteCacheKey(params: {
  chainId?: number;
  tokenIn: string;
  tokenOut: string;
}): string | undefined {
  if (params.chainId === undefined) {
    return undefined;
  }
  return `${params.chainId}:${params.tokenIn.toLowerCase()}:${params.tokenOut.toLowerCase()}`;
}

function incrementDiscoveryStat(
  rpcCache: DiscoveryRpcCache | undefined,
  key: keyof NonNullable<DiscoveryRpcCache['stats']>
): void {
  if (!rpcCache?.stats) {
    return;
  }
  const stats = rpcCache.stats as Record<string, number | undefined>;
  stats[key] = (stats[key] ?? 0) + 1;
}

function normalizeIdentityAddress(value?: string): string | undefined {
  return value?.toLowerCase();
}

function normalizeIdentityAddresses(values?: string[]): string[] | undefined {
  return values?.map((value) => value.toLowerCase());
}

function stableJsonIdentity(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonIdentity(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonIdentity(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function getCurvePoolConfigIdentity(
  poolConfigs?: NonNullable<
    DiscoveryExecutionConfig['curveRouterOverrides']
  >['poolConfigs']
): unknown {
  if (!poolConfigs) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(poolConfigs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tokenPair, poolConfig]) => [
        tokenPair.toLowerCase(),
        {
          address: normalizeIdentityAddress(poolConfig.address),
          poolType: poolConfig.poolType,
        },
      ])
  );
}

function getTokenAddressIdentity(
  tokenAddresses?: DiscoveryExecutionConfig['tokenAddresses']
): unknown {
  if (!tokenAddresses) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(tokenAddresses)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([symbol, address]) => [
        symbol.toLowerCase(),
        normalizeIdentityAddress(address),
      ])
  );
}

function getGasQuoteSourceConfigIdentity(params: {
  config: DiscoveryExecutionConfig;
  chainId?: number;
  liquiditySources: LiquiditySource[];
}): string {
  return stableJsonIdentity(
    params.liquiditySources.map((source) => {
      if (source === LiquiditySource.ONEINCH) {
        return {
          source,
          router:
            params.chainId !== undefined
              ? normalizeIdentityAddress(
                  params.config.oneInchRouters?.[params.chainId]
                )
              : undefined,
          connectorTokens: normalizeIdentityAddresses(
            params.config.connectorTokens
          ),
        };
      }
      if (source === LiquiditySource.UNISWAPV3) {
        const quoteConfig = resolveUniswapV3FactoryQuoteConfig(
          params.config.uniswapV3RouterOverrides
        );
        return {
          source,
          poolFactoryAddress: normalizeIdentityAddress(
            quoteConfig?.poolFactoryAddress
          ),
          quoterV2Address: normalizeIdentityAddress(
            quoteConfig?.quoterV2Address
          ),
          wethAddress: normalizeIdentityAddress(quoteConfig?.wethAddress),
          feeTiers: getGasQuoteFeeTiers(
            quoteConfig?.defaultFeeTier,
            quoteConfig?.candidateFeeTiers,
            DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3],
            STANDARD_V3_FEE_TIERS
          ),
        };
      }
      if (source === LiquiditySource.SUSHISWAP) {
        const sushiConfig = params.config.sushiswapRouterOverrides;
        return {
          source,
          swapRouterAddress: normalizeIdentityAddress(
            sushiConfig?.swapRouterAddress
          ),
          factoryAddress: normalizeIdentityAddress(sushiConfig?.factoryAddress),
          quoterV2Address: normalizeIdentityAddress(
            sushiConfig?.quoterV2Address
          ),
          wethAddress: normalizeIdentityAddress(sushiConfig?.wethAddress),
          feeTiers: getGasQuoteFeeTiers(
            sushiConfig?.defaultFeeTier,
            sushiConfig?.candidateFeeTiers,
            DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP],
            STANDARD_V3_FEE_TIERS
          ),
        };
      }
      if (source === LiquiditySource.CURVE) {
        const curveConfig = params.config.curveRouterOverrides;
        return {
          source,
          wethAddress: normalizeIdentityAddress(curveConfig?.wethAddress),
          poolConfigs: getCurvePoolConfigIdentity(curveConfig?.poolConfigs),
          tokenAddresses: getTokenAddressIdentity(params.config.tokenAddresses),
        };
      }
      return { source };
    })
  );
}

function getGasQuoteConversionCacheKey(params: {
  config: DiscoveryExecutionConfig;
  chainId?: number;
  wrappedNativeAddress: string;
  quoteTokenAddress: string;
  liquiditySources: LiquiditySource[];
  preferredLiquiditySource?: LiquiditySource;
  amountInNative: BigNumber;
  gasPrice?: BigNumber;
  gasLimit?: BigNumber;
  minProfitNative?: string;
}): string | undefined {
  if (params.chainId === undefined || !params.gasPrice) {
    return undefined;
  }
  return stableJsonIdentity({
    v: 1,
    chainId: params.chainId,
    wrappedNativeAddress: params.wrappedNativeAddress.toLowerCase(),
    quoteTokenAddress: params.quoteTokenAddress.toLowerCase(),
    liquiditySources: params.liquiditySources,
    preferredLiquiditySource: params.preferredLiquiditySource,
    amountInNative: params.amountInNative.toString(),
    gasPrice: params.gasPrice.toString(),
    gasLimit: params.gasLimit?.toString(),
    minProfitNative: params.minProfitNative,
    sourceConfig: getGasQuoteSourceConfigIdentity({
      config: params.config,
      chainId: params.chainId,
      liquiditySources: params.liquiditySources,
    }),
  });
}

function pruneGasQuoteConversionCache(
  rpcCache: DiscoveryRpcCache | undefined,
  nowMs: number
): void {
  const cache = rpcCache?.gasQuoteConversions;
  if (!cache) {
    return;
  }
  for (const [key, entry] of Array.from(cache.entries())) {
    if (nowMs - entry.createdAtMs > GAS_QUOTE_CONVERSION_CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
  while (cache.size > MAX_GAS_QUOTE_CONVERSION_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    cache.delete(oldestKey);
  }
}

function getGasQuoteConversionCacheTtlMs(params: {
  cachedLiquiditySource: LiquiditySource;
  preferredLiquiditySource?: LiquiditySource;
}): number {
  if (
    params.preferredLiquiditySource !== undefined &&
    params.cachedLiquiditySource !== params.preferredLiquiditySource
  ) {
    return FALLBACK_GAS_QUOTE_CONVERSION_CACHE_TTL_MS;
  }
  return GAS_QUOTE_CONVERSION_CACHE_TTL_MS;
}

function logGasQuoteFallback(params: {
  usedLiquiditySource: LiquiditySource;
  preferredLiquiditySource?: LiquiditySource;
  rpcCache?: DiscoveryRpcCache;
  gasQuoteCacheKey?: string;
}): void {
  if (
    params.preferredLiquiditySource === undefined ||
    params.usedLiquiditySource === params.preferredLiquiditySource
  ) {
    return;
  }

  const message = `Gas quote conversion used ${formatLiquiditySource(
    params.usedLiquiditySource
  )} after preferred source ${formatLiquiditySource(
    params.preferredLiquiditySource
  )} was unavailable`;
  if (!params.rpcCache || params.gasQuoteCacheKey === undefined) {
    logger.warn(message);
    return;
  }

  if (!params.rpcCache.gasQuoteFallbackWarningKeys) {
    params.rpcCache.gasQuoteFallbackWarningKeys = new Set();
  }
  const warningKey = `${params.gasQuoteCacheKey}:${params.preferredLiquiditySource}:${params.usedLiquiditySource}`;
  if (params.rpcCache.gasQuoteFallbackWarningKeys.has(warningKey)) {
    logger.debug(message);
    return;
  }

  params.rpcCache.gasQuoteFallbackWarningKeys.add(warningKey);
  logger.warn(message);
}

async function quoteTokensByLiquiditySource(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  liquiditySource: LiquiditySource;
  amountIn: BigNumber;
  tokenIn: string;
  tokenOut: string;
  chainId?: number;
  rpcCache?: DiscoveryRpcCache;
  oneInchQuoteTimeoutMs?: number;
  takePolicy?: Pick<
    AutoDiscoverTakePolicy,
    'oneInchQuoteFailureCooldownMs' | 'oneInchQuoteFailureThreshold'
  >;
}): Promise<GasQuoteSourceResult> {
  if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) {
    return { amountOut: params.amountIn };
  }

  if (params.liquiditySource === LiquiditySource.ONEINCH) {
    const chainId =
      params.chainId ?? (await tryResolveSignerChainId(params.signer));
    if (chainId === undefined) {
      return { reason: 'chainId unavailable for 1inch gas quote' };
    }
    if (!params.config.oneInchRouters?.[chainId]) {
      return { reason: `1inch router not configured for chain ${chainId}` };
    }
    const circuitOpenReason = getOneInchCircuitOpenReason({
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      purpose: 'gas_conversion',
    });
    if (circuitOpenReason) {
      logger.debug(`Skipping 1inch gas quote conversion: ${circuitOpenReason}`);
      return { reason: circuitOpenReason };
    }

    const dexRouter = new DexRouter(params.signer, {
      oneInchRouters: params.config.oneInchRouters,
      connectorTokens: params.config.connectorTokens ?? [],
    });
    const quoteResult = await dexRouter.getQuoteFromOneInch(
      chainId,
      params.amountIn,
      params.tokenIn,
      params.tokenOut,
      { timeoutMs: params.oneInchQuoteTimeoutMs }
    );
    if (!quoteResult) {
      recordOneInchQuoteFailure({
        rpcCache: params.rpcCache,
        takePolicy: params.takePolicy,
        purpose: 'gas_conversion',
      });
      return { reason: '1inch returned empty gas quote response' };
    }
    if (!quoteResult.success || !quoteResult.dstAmount) {
      if (quoteResult.retryable) {
        recordOneInchQuoteFailure({
          rpcCache: params.rpcCache,
          takePolicy: params.takePolicy,
          purpose: 'gas_conversion',
        });
      }
      return {
        reason: quoteResult.error ?? '1inch returned no gas quote route',
      };
    }
    const dstAmount = BigNumber.from(quoteResult.dstAmount);
    if (dstAmount.isZero()) {
      logger.debug('1inch gas quote conversion returned zero output');
      return { reason: '1inch gas quote conversion returned zero output' };
    }
    recordOneInchQuoteSuccess(params.rpcCache, 'gas_conversion');
    return { amountOut: dstAmount };
  }

  if (params.liquiditySource === LiquiditySource.UNISWAPV3) {
    const quoteConfig = resolveUniswapV3FactoryQuoteConfig(
      params.config.uniswapV3RouterOverrides
    );
    if (!quoteConfig) {
      return { reason: 'Uniswap V3 gas quote configuration incomplete' };
    }

    const quoteProvider = getUniswapV3QuoteProvider({
      signer: params.signer,
      quoteConfig,
      runtimeCache: params.rpcCache?.factoryQuoteProviders,
    });
    if (!quoteProvider) {
      return { reason: 'Uniswap V3 quote provider unavailable' };
    }
    return await quoteFactoryV3GasConversion({
      quoteProvider,
      amountIn: params.amountIn,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      defaultFeeTier: quoteConfig.defaultFeeTier,
      candidateFeeTiers: quoteConfig.candidateFeeTiers,
      fallbackFeeTier: DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3],
      automaticCandidateFeeTiers: STANDARD_V3_FEE_TIERS,
    });
  }

  if (params.liquiditySource === LiquiditySource.SUSHISWAP) {
    const sushiConfig = params.config.sushiswapRouterOverrides;
    if (
      !sushiConfig?.swapRouterAddress ||
      !sushiConfig.factoryAddress ||
      !sushiConfig.wethAddress ||
      !sushiConfig.quoterV2Address
    ) {
      return { reason: 'SushiSwap gas quote configuration incomplete' };
    }
    const quoteProvider = await getSushiSwapQuoteProvider({
      signer: params.signer,
      routerConfig: sushiConfig,
      runtimeCache: params.rpcCache?.factoryQuoteProviders,
    });
    if (!quoteProvider) {
      return { reason: 'SushiSwap quote provider unavailable' };
    }
    return await quoteFactoryV3GasConversion({
      quoteProvider,
      amountIn: params.amountIn,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      defaultFeeTier: sushiConfig.defaultFeeTier,
      candidateFeeTiers: sushiConfig.candidateFeeTiers,
      fallbackFeeTier: DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP],
      automaticCandidateFeeTiers: STANDARD_V3_FEE_TIERS,
    });
  }

  if (params.liquiditySource === LiquiditySource.CURVE) {
    const curveConfig = params.config.curveRouterOverrides;
    if (!curveConfig?.poolConfigs || !curveConfig.wethAddress) {
      return { reason: 'Curve gas quote configuration incomplete' };
    }
    const quoteProvider = await getCurveQuoteProvider({
      signer: params.signer,
      routerConfig: curveConfig,
      tokenAddresses: params.config.tokenAddresses,
      runtimeCache: params.rpcCache?.factoryQuoteProviders,
    });
    if (!quoteProvider) {
      return { reason: 'Curve quote provider unavailable' };
    }
    const quoteResult = await withTimeout(
      quoteProvider.getQuote(params.amountIn, params.tokenIn, params.tokenOut),
      DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
      'Curve gas quote'
    );
    return quoteResult.success && quoteResult.dstAmount
      ? { amountOut: BigNumber.from(quoteResult.dstAmount) }
      : { reason: 'Curve returned no usable gas quote' };
  }

  return { reason: 'unsupported liquidity source for gas quote conversion' };
}

async function quoteTokensByGasQuoteSources(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  liquiditySources: LiquiditySource[];
  amountIn: BigNumber;
  tokenIn: string;
  tokenOut: string;
  chainId?: number;
  preferredLiquiditySource?: LiquiditySource;
  rpcCache?: DiscoveryRpcCache;
  gasQuoteCacheKey?: string;
  oneInchQuoteTimeoutMs?: number;
  takePolicy?: Pick<
    AutoDiscoverTakePolicy,
    'oneInchQuoteFailureCooldownMs' | 'oneInchQuoteFailureThreshold'
  >;
  gasQuoteAttempts?: GasQuoteAttempt[];
}): Promise<
  { amountOut: BigNumber; liquiditySource: LiquiditySource } | undefined
> {
  for (const liquiditySource of params.liquiditySources) {
    try {
      const quoteResult = await quoteTokensByLiquiditySource({
        signer: params.signer,
        config: params.config,
        liquiditySource,
        amountIn: params.amountIn,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        chainId: params.chainId,
        rpcCache: params.rpcCache,
        oneInchQuoteTimeoutMs: params.oneInchQuoteTimeoutMs,
        takePolicy: params.takePolicy,
      });
      params.gasQuoteAttempts?.push({
        source: liquiditySource,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn.toString(),
        feeTiers: quoteResult.feeTiers,
        success: quoteResult.amountOut !== undefined,
        amountOut: quoteResult.amountOut?.toString(),
        reason: quoteResult.reason,
      });
      if (quoteResult.amountOut) {
        logGasQuoteFallback({
          usedLiquiditySource: liquiditySource,
          preferredLiquiditySource: params.preferredLiquiditySource,
          rpcCache: params.rpcCache,
          gasQuoteCacheKey: params.gasQuoteCacheKey,
        });
        return { amountOut: quoteResult.amountOut, liquiditySource };
      }
    } catch (error) {
      params.gasQuoteAttempts?.push({
        source: liquiditySource,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn.toString(),
        success: false,
        reason: getErrorMessage(error),
      });
      logger.debug(
        `Gas quote conversion failed with ${formatLiquiditySource(liquiditySource)}: ${getErrorMessage(error)}`
      );
    }
  }

  return undefined;
}

export async function evaluateGasPolicy(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  transports: Pick<DiscoveryReadTransports, 'readRpc'>;
  policy?: Pick<
    AutoDiscoverActionPolicy,
    'maxGasCostNative' | 'maxGasCostQuote' | 'maxGasPriceGwei'
  > &
    Pick<
      AutoDiscoverTakePolicy,
      | 'minExpectedProfitQuote'
      | 'minProfitNative'
      | 'l2GasCostBufferBasisPoints'
      | 'oneInchQuoteTimeoutMs'
      | 'oneInchQuoteFailureCooldownMs'
      | 'oneInchQuoteFailureThreshold'
    >;
  gasLimit: BigNumber;
  quoteTokenAddress: string;
  preferredLiquiditySource?: LiquiditySource;
  useProfitFloor?: boolean;
  requireGasCostQuote?: boolean;
  gasPrice?: BigNumber;
  rpcCache?: DiscoveryRpcCache;
  chainId?: number;
}): Promise<GasPolicyResult> {
  const gasQuoteAttempts: GasQuoteAttempt[] = [];
  const provider = params.signer.provider;
  if (!provider) {
    return {
      approved: false,
      gasCostNative: 0,
      gasCostQuote: 0,
      gasPriceGwei: 0,
      rejectCode: 'provider_unavailable',
      reason: 'signer has no provider',
    };
  }

  const gasPrice =
    params.gasPrice ?? (await params.transports.readRpc.getGasPrice());
  const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
  const gasResultMetadata = {
    gasPriceRaw: gasPrice,
    gasPriceGwei,
    gasLimit: params.gasLimit,
  };
  const maxGasPriceGwei = params.policy?.maxGasPriceGwei;
  if (maxGasPriceGwei !== undefined && gasPriceGwei > maxGasPriceGwei) {
    return {
      approved: false,
      gasCostNative: 0,
      gasCostQuote: 0,
      ...gasResultMetadata,
      rejectCode: 'gas_price_above_cap',
      reason: `gas price ${gasPriceGwei.toFixed(2)} gwei exceeds maxGasPriceGwei ${maxGasPriceGwei}`,
    };
  }

  const chainId =
    params.chainId ??
    params.rpcCache?.chainId ??
    (await tryResolveSignerChainId(params.signer));
  const l2GasCostBufferBasisPoints = getEffectiveL2GasCostBufferBasisPoints(
    params.policy,
    chainId
  );
  const unbufferedGasCostNativeRaw = gasPrice.mul(params.gasLimit);
  const gasCostNativeRaw = applyL2GasCostBuffer(
    unbufferedGasCostNativeRaw,
    chainId,
    params.policy?.l2GasCostBufferBasisPoints
  );
  if (!gasCostNativeRaw.eq(unbufferedGasCostNativeRaw)) {
    logger.debug(
      `Applied conservative L2 gas cost buffer for chainId ${chainId}: ${unbufferedGasCostNativeRaw.toString()} -> ${gasCostNativeRaw.toString()}`
    );
  }
  const gasCostNative = Number(ethers.utils.formatEther(gasCostNativeRaw));
  const maxGasCostNative = params.policy?.maxGasCostNative;
  if (maxGasCostNative !== undefined && gasCostNative > maxGasCostNative) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote: 0,
      ...gasResultMetadata,
      l2GasCostBufferBasisPoints,
      rejectCode: 'native_gas_cost_above_cap',
      reason: `estimated gas cost ${gasCostNative.toFixed(6)} exceeds maxGasCostNative ${maxGasCostNative}`,
    };
  }

  const requiresGasCostQuote =
    params.requireGasCostQuote ||
    params.policy?.maxGasCostQuote !== undefined ||
    (params.useProfitFloor &&
      (params.policy?.minExpectedProfitQuote !== undefined ||
        params.policy?.minProfitNative !== undefined));
  if (!requiresGasCostQuote) {
    return {
      approved: true,
      gasCostNative,
      gasCostQuote: 0,
      ...gasResultMetadata,
      l2GasCostBufferBasisPoints,
    };
  }

  const resolvedGasQuoteSource = resolveGasQuoteSource(params.config, chainId);
  const preferredLiquiditySource =
    params.preferredLiquiditySource !== undefined &&
    hasConfiguredGasQuoteLiquiditySource(
      params.config,
      params.preferredLiquiditySource,
      chainId
    )
      ? params.preferredLiquiditySource
      : resolvedGasQuoteSource;
  const gasQuoteSourceCandidates = getGasQuoteSourceCandidates({
    config: params.config,
    chainId,
    preferredLiquiditySource,
    resolvedLiquiditySource: resolvedGasQuoteSource,
  });
  const oneInchQuoteTimeoutMs =
    params.policy?.oneInchQuoteTimeoutMs ?? DEFAULT_ONEINCH_QUOTE_TIMEOUT_MS;

  const quoteDecimals = await getDecimalsErc20(
    params.signer,
    params.quoteTokenAddress,
    chainId
  );

  if (
    gasCostNativeRaw.isZero() &&
    params.policy?.minProfitNative === undefined
  ) {
    return {
      approved: true,
      gasCostNative,
      gasCostQuote: 0,
      gasCostQuoteRaw: BigNumber.from(0),
      ...gasResultMetadata,
      l2GasCostBufferBasisPoints,
      quoteTokenDecimals: quoteDecimals,
    };
  }

  const wrappedNativeAddress =
    resolveWrappedNativeAddress(params.config, preferredLiquiditySource) ??
    resolveWrappedNativeAddress(params.config, resolvedGasQuoteSource);
  if (!wrappedNativeAddress) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote: 0,
      ...gasResultMetadata,
      l2GasCostBufferBasisPoints,
      rejectCode: 'wrapped_native_unconfigured',
      reason: 'no wrapped native token configured for gas cost conversion',
    };
  }
  const gasQuoteCacheKey = getGasQuoteCacheKey({
    chainId,
    tokenIn: wrappedNativeAddress,
    tokenOut: params.quoteTokenAddress,
  });

  const maxGasCostQuote = params.policy?.maxGasCostQuote;
  const minProfitNativeRaw =
    params.policy?.minProfitNative !== undefined
      ? BigNumber.from(params.policy.minProfitNative)
      : undefined;
  let gasCostQuote: number;
  let gasCostQuoteRaw: BigNumber;
  let minProfitNativeQuoteRaw: BigNumber | undefined;
  if (
    wrappedNativeAddress.toLowerCase() ===
    params.quoteTokenAddress.toLowerCase()
  ) {
    gasCostQuoteRaw = convertNativeWadToQuoteRaw(
      gasCostNativeRaw,
      quoteDecimals
    );
    minProfitNativeQuoteRaw =
      minProfitNativeRaw !== undefined
        ? convertNativeWadToQuoteRaw(minProfitNativeRaw, quoteDecimals)
        : undefined;
    gasCostQuote = Number(
      ethers.utils.formatUnits(gasCostQuoteRaw, quoteDecimals)
    );
  } else {
    if (gasQuoteSourceCandidates.length === 0) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote: 0,
        ...gasResultMetadata,
        l2GasCostBufferBasisPoints,
        rejectCode: 'native_to_quote_conversion_unavailable',
        reason: 'no liquidity source available for gas cost conversion',
      };
    }

    const quoteNativeRequirement = async (
      amountInNative: BigNumber,
      failureReason: string
    ): Promise<BigNumber | GasPolicyResult> => {
      const quotedAmount = await quoteExactNativeAmountToQuote({
        signer: params.signer,
        config: params.config,
        liquiditySources: gasQuoteSourceCandidates,
        amountInNative,
        wrappedNativeAddress,
        quoteTokenAddress: params.quoteTokenAddress,
        chainId,
        preferredLiquiditySource,
        rpcCache: params.rpcCache,
        gasQuoteCacheKey,
        gasPrice,
        gasLimit: params.gasLimit,
        minProfitNative: params.policy?.minProfitNative,
        oneInchQuoteTimeoutMs,
        takePolicy: params.policy,
        gasQuoteAttempts,
      });
      if (quotedAmount !== undefined) {
        return quotedAmount;
      }
      return {
        approved: false,
        gasCostNative,
        gasCostQuote: 0,
        ...gasResultMetadata,
        l2GasCostBufferBasisPoints,
        quoteTokenDecimals: quoteDecimals,
        rejectCode: 'native_to_quote_conversion_unavailable',
        gasQuoteAttempts,
        reason: failureReason,
      };
    };

    if (minProfitNativeRaw !== undefined) {
      const combinedNativeRaw = gasCostNativeRaw.add(minProfitNativeRaw);
      const combinedQuoteRaw = await quoteNativeRequirement(
        combinedNativeRaw,
        'failed to quote gas cost and minProfitNative into quote token'
      );
      if (!BigNumber.isBigNumber(combinedQuoteRaw)) {
        return combinedQuoteRaw;
      }
      const apportionedQuote = apportionCombinedNativeQuote({
        gasCostNativeRaw,
        combinedNativeRaw,
        combinedQuoteRaw,
      });
      gasCostQuoteRaw = apportionedQuote.gasCostQuoteRaw;
      minProfitNativeQuoteRaw = apportionedQuote.minProfitNativeQuoteRaw;
    } else {
      const quotedGasCostRaw = await quoteNativeRequirement(
        gasCostNativeRaw,
        'failed to quote gas cost into quote token'
      );
      if (!BigNumber.isBigNumber(quotedGasCostRaw)) {
        return quotedGasCostRaw;
      }
      gasCostQuoteRaw = quotedGasCostRaw;
    }

    gasCostQuote = Number(
      ethers.utils.formatUnits(gasCostQuoteRaw, quoteDecimals)
    );
  }

  if (maxGasCostQuote !== undefined && gasCostQuote > maxGasCostQuote) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote,
      gasCostQuoteRaw,
      ...gasResultMetadata,
      l2GasCostBufferBasisPoints,
      quoteTokenDecimals: quoteDecimals,
      rejectCode: 'quote_gas_cost_above_cap',
      gasQuoteAttempts: gasQuoteAttempts.length ? gasQuoteAttempts : undefined,
      reason: `estimated gas cost ${gasCostQuote.toFixed(6)} exceeds maxGasCostQuote ${maxGasCostQuote}`,
    };
  }

  return {
    approved: true,
    gasCostNative,
    gasCostQuote,
    gasCostQuoteRaw,
    minProfitNativeQuoteRaw,
    ...gasResultMetadata,
    l2GasCostBufferBasisPoints,
    quoteTokenDecimals: quoteDecimals,
    gasQuoteAttempts: gasQuoteAttempts.length ? gasQuoteAttempts : undefined,
  };
}

async function quoteExactNativeAmountToQuote(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  liquiditySources: LiquiditySource[];
  amountInNative: BigNumber;
  wrappedNativeAddress: string;
  quoteTokenAddress: string;
  chainId?: number;
  preferredLiquiditySource?: LiquiditySource;
  rpcCache?: DiscoveryRpcCache;
  gasQuoteCacheKey?: string;
  gasPrice?: BigNumber;
  gasLimit?: BigNumber;
  minProfitNative?: string;
  oneInchQuoteTimeoutMs?: number;
  takePolicy?: Pick<
    AutoDiscoverTakePolicy,
    'oneInchQuoteFailureCooldownMs' | 'oneInchQuoteFailureThreshold'
  >;
  gasQuoteAttempts?: GasQuoteAttempt[];
}): Promise<BigNumber | undefined> {
  if (params.amountInNative.isZero()) {
    return BigNumber.from(0);
  }
  if (
    params.wrappedNativeAddress.toLowerCase() ===
    params.quoteTokenAddress.toLowerCase()
  ) {
    return params.amountInNative;
  }
  if (params.liquiditySources.length === 0) {
    return undefined;
  }
  const conversionCacheKey = getGasQuoteConversionCacheKey({
    config: params.config,
    chainId: params.chainId,
    wrappedNativeAddress: params.wrappedNativeAddress,
    quoteTokenAddress: params.quoteTokenAddress,
    liquiditySources: params.liquiditySources,
    preferredLiquiditySource: params.preferredLiquiditySource,
    amountInNative: params.amountInNative,
    gasPrice: params.gasPrice,
    gasLimit: params.gasLimit,
    minProfitNative: params.minProfitNative,
  });
  const nowMs = Date.now();
  pruneGasQuoteConversionCache(params.rpcCache, nowMs);
  if (conversionCacheKey && params.rpcCache?.gasQuoteConversions) {
    const cached = params.rpcCache.gasQuoteConversions.get(conversionCacheKey);
    const cacheTtlMs = cached
      ? getGasQuoteConversionCacheTtlMs({
          cachedLiquiditySource: cached.liquiditySource,
          preferredLiquiditySource: params.preferredLiquiditySource,
        })
      : GAS_QUOTE_CONVERSION_CACHE_TTL_MS;
    if (
      cached &&
      params.gasPrice &&
      cached.gasPrice.eq(params.gasPrice) &&
      nowMs - cached.createdAtMs <= cacheTtlMs
    ) {
      params.rpcCache.gasQuoteConversions.delete(conversionCacheKey);
      params.rpcCache.gasQuoteConversions.set(conversionCacheKey, cached);
      incrementDiscoveryStat(params.rpcCache, 'gasQuoteConversionCacheHits');
      return cached.value;
    }
    if (cached && nowMs - cached.createdAtMs > cacheTtlMs) {
      params.rpcCache.gasQuoteConversions.delete(conversionCacheKey);
    }
  }
  incrementDiscoveryStat(params.rpcCache, 'gasQuoteConversionCacheMisses');

  const quotedAmount = await quoteTokensByGasQuoteSources({
    signer: params.signer,
    config: params.config,
    liquiditySources: params.liquiditySources,
    amountIn: params.amountInNative,
    tokenIn: params.wrappedNativeAddress,
    tokenOut: params.quoteTokenAddress,
    chainId: params.chainId,
    preferredLiquiditySource: params.preferredLiquiditySource,
    rpcCache: params.rpcCache,
    gasQuoteCacheKey: params.gasQuoteCacheKey,
    oneInchQuoteTimeoutMs: params.oneInchQuoteTimeoutMs,
    takePolicy: params.takePolicy,
    gasQuoteAttempts: params.gasQuoteAttempts,
  });
  if (quotedAmount && conversionCacheKey && params.rpcCache) {
    const createdAtMs = Date.now();
    params.rpcCache.gasQuoteConversions ??= new Map();
    params.rpcCache.gasQuoteConversions.set(conversionCacheKey, {
      value: quotedAmount.amountOut,
      createdAtMs,
      gasPrice: params.gasPrice ?? BigNumber.from(0),
      liquiditySource: quotedAmount.liquiditySource,
    });
    pruneGasQuoteConversionCache(params.rpcCache, createdAtMs);
  }
  return quotedAmount?.amountOut;
}
