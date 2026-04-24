import { Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  AutoDiscoverActionPolicy,
  AutoDiscoverTakePolicy,
  DEFAULT_FEE_TIER_BY_SOURCE,
  LiquiditySource,
  hasConfiguredGasQuoteLiquiditySource,
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
import { getDecimalsErc20 } from '../erc20';
import {
  DiscoveryExecutionConfig,
  DiscoveryExecutionTransportConfig,
  DiscoveryRpcCache,
} from './types';
import {
  getCurveQuoteProvider,
  getSushiSwapQuoteProvider,
  getUniswapV3QuoteProvider,
} from '../take/factory/shared';

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
  reason?: string;
}

const BASIS_POINTS_DENOMINATOR = BigNumber.from(10_000);
export const DEFAULT_L2_GAS_COST_BUFFER_BASIS_POINTS = 13_000;
export const DEFAULT_L1_DISCOVERY_GAS_PRICE_TTL_MS = 5 * 1000;
export const DEFAULT_L2_DISCOVERY_GAS_PRICE_TTL_MS = 15 * 1000;
const L2_CHAIN_IDS_WITH_DATA_FEE_BUFFER = new Set([
  10, 8453, 42161, 11155420, 84532, 421614,
]);
const L2_CHAIN_IDS_WITH_STABLE_GAS = new Set([
  10, 8453, 42161, 11155420, 84532, 421614,
]);

export function getDiscoveryGasPriceFreshnessTtlMs(
  policy?: Pick<
    AutoDiscoverTakePolicy,
    'l1GasPriceFreshnessTtlMs' | 'l2GasPriceFreshnessTtlMs'
  >,
  chainId?: number
): number {
  if (chainId !== undefined && L2_CHAIN_IDS_WITH_STABLE_GAS.has(chainId)) {
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
  if (
    chainId === undefined ||
    !L2_CHAIN_IDS_WITH_DATA_FEE_BUFFER.has(chainId)
  ) {
    return gasCostNativeRaw;
  }
  return gasCostNativeRaw
    .mul(BigNumber.from(bufferBasisPoints))
    .add(BASIS_POINTS_DENOMINATOR.sub(1))
    .div(BASIS_POINTS_DENOMINATOR);
}

export function getEffectiveL2GasCostBufferBasisPoints(
  policy?: Pick<AutoDiscoverTakePolicy, 'l2GasCostBufferBasisPoints'>,
  chainId?: number
): number | undefined {
  if (
    chainId === undefined ||
    !L2_CHAIN_IDS_WITH_DATA_FEE_BUFFER.has(chainId)
  ) {
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
  fallbackFeeTier: number
): number[] {
  return Array.from(
    new Set([defaultFeeTier ?? fallbackFeeTier, ...(candidateFeeTiers ?? [])])
  );
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

async function quoteFactoryV3GasConversion(params: {
  quoteProvider: FactoryV3GasQuoteProvider;
  amountIn: BigNumber;
  tokenIn: string;
  tokenOut: string;
  defaultFeeTier?: number;
  candidateFeeTiers?: number[];
  fallbackFeeTier: number;
}): Promise<BigNumber | undefined> {
  let bestQuote: BigNumber | undefined;
  for (const feeTier of getGasQuoteFeeTiers(
    params.defaultFeeTier,
    params.candidateFeeTiers,
    params.fallbackFeeTier
  )) {
    const poolExists = await params.quoteProvider.poolExists(
      params.tokenIn,
      params.tokenOut,
      feeTier
    );
    if (!poolExists) {
      continue;
    }
    const quoteResult = await params.quoteProvider.getQuote(
      params.amountIn,
      params.tokenIn,
      params.tokenOut,
      feeTier
    );
    if (quoteResult.success && quoteResult.dstAmount) {
      const quote = BigNumber.from(quoteResult.dstAmount);
      // Use the highest output to conservatively price gas in quote-token terms.
      bestQuote = bestQuote && bestQuote.gt(quote) ? bestQuote : quote;
    }
  }
  return bestQuote;
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

  const message = `Gas quote conversion used ${
    LiquiditySource[params.usedLiquiditySource] ?? params.usedLiquiditySource
  } after preferred source ${
    LiquiditySource[params.preferredLiquiditySource] ??
    params.preferredLiquiditySource
  } was unavailable`;
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
}): Promise<BigNumber | undefined> {
  if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) {
    return params.amountIn;
  }

  if (params.liquiditySource === LiquiditySource.ONEINCH) {
    const chainId =
      params.chainId ?? (await tryResolveSignerChainId(params.signer));
    if (chainId === undefined) {
      return undefined;
    }
    if (!params.config.oneInchRouters?.[chainId]) {
      return undefined;
    }

    const dexRouter = new DexRouter(params.signer, {
      oneInchRouters: params.config.oneInchRouters,
      connectorTokens: params.config.connectorTokens ?? [],
    });
    const quoteResult = await dexRouter.getQuoteFromOneInch(
      chainId,
      params.amountIn,
      params.tokenIn,
      params.tokenOut
    );
    if (!quoteResult.success || !quoteResult.dstAmount) {
      return undefined;
    }
    return BigNumber.from(quoteResult.dstAmount);
  }

  if (params.liquiditySource === LiquiditySource.UNISWAPV3) {
    const routerConfig = params.config.universalRouterOverrides;
    if (
      !routerConfig?.universalRouterAddress ||
      !routerConfig.poolFactoryAddress ||
      !routerConfig.wethAddress ||
      !routerConfig.quoterV2Address
    ) {
      return undefined;
    }

    const quoteProvider = getUniswapV3QuoteProvider({
      signer: params.signer,
      routerConfig,
      runtimeCache: params.rpcCache?.factoryQuoteProviders,
    });
    if (!quoteProvider) {
      return undefined;
    }
    return await quoteFactoryV3GasConversion({
      quoteProvider,
      amountIn: params.amountIn,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      defaultFeeTier: routerConfig.defaultFeeTier,
      candidateFeeTiers: routerConfig.candidateFeeTiers,
      fallbackFeeTier: DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3],
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
      return undefined;
    }
    const quoteProvider = await getSushiSwapQuoteProvider({
      signer: params.signer,
      routerConfig: sushiConfig,
      runtimeCache: params.rpcCache?.factoryQuoteProviders,
    });
    if (!quoteProvider) {
      return undefined;
    }
    return await quoteFactoryV3GasConversion({
      quoteProvider,
      amountIn: params.amountIn,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      defaultFeeTier: sushiConfig.defaultFeeTier,
      candidateFeeTiers: sushiConfig.candidateFeeTiers,
      fallbackFeeTier: DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP],
    });
  }

  if (params.liquiditySource === LiquiditySource.CURVE) {
    const curveConfig = params.config.curveRouterOverrides;
    if (!curveConfig?.poolConfigs || !curveConfig.wethAddress) {
      return undefined;
    }
    const quoteProvider = await getCurveQuoteProvider({
      signer: params.signer,
      routerConfig: curveConfig,
      tokenAddresses: params.config.tokenAddresses,
      runtimeCache: params.rpcCache?.factoryQuoteProviders,
    });
    if (!quoteProvider) {
      return undefined;
    }
    const quoteResult = await quoteProvider.getQuote(
      params.amountIn,
      params.tokenIn,
      params.tokenOut
    );
    return quoteResult.success && quoteResult.dstAmount
      ? BigNumber.from(quoteResult.dstAmount)
      : undefined;
  }

  return undefined;
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
}): Promise<
  { amountOut: BigNumber; liquiditySource: LiquiditySource } | undefined
> {
  for (const liquiditySource of params.liquiditySources) {
    try {
      const amountOut = await quoteTokensByLiquiditySource({
        signer: params.signer,
        config: params.config,
        liquiditySource,
        amountIn: params.amountIn,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        chainId: params.chainId,
        rpcCache: params.rpcCache,
      });
      if (amountOut) {
        logGasQuoteFallback({
          usedLiquiditySource: liquiditySource,
          preferredLiquiditySource: params.preferredLiquiditySource,
          rpcCache: params.rpcCache,
          gasQuoteCacheKey: params.gasQuoteCacheKey,
        });
        return { amountOut, liquiditySource };
      }
    } catch (error) {
      logger.debug(
        `Gas quote conversion failed with ${LiquiditySource[liquiditySource] ?? liquiditySource}: ${error instanceof Error ? error.message : String(error)}`
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
    >;
  gasLimit: BigNumber;
  quoteTokenAddress: string;
  preferredLiquiditySource?: LiquiditySource;
  useProfitFloor?: boolean;
  gasPrice?: BigNumber;
  rpcCache?: DiscoveryRpcCache;
  chainId?: number;
}): Promise<GasPolicyResult> {
  const provider = params.signer.provider;
  if (!provider) {
    return {
      approved: false,
      gasCostNative: 0,
      gasCostQuote: 0,
      gasPriceGwei: 0,
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
      reason: `estimated gas cost ${gasCostNative.toFixed(6)} exceeds maxGasCostNative ${maxGasCostNative}`,
    };
  }

  const requiresGasCostQuote =
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

  const quoteDecimals = await getDecimalsErc20(
    params.signer,
    params.quoteTokenAddress
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
      reason: 'no wrapped native token configured for gas cost conversion',
    };
  }
  const gasQuoteCacheKey = getGasQuoteCacheKey({
    chainId,
    tokenIn: wrappedNativeAddress,
    tokenOut: params.quoteTokenAddress,
  });

  let gasCostQuote: number;
  let gasCostQuoteRaw: BigNumber;
  if (
    wrappedNativeAddress.toLowerCase() ===
    params.quoteTokenAddress.toLowerCase()
  ) {
    gasCostQuoteRaw = gasCostNativeRaw;
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
        reason: 'no liquidity source available for gas cost conversion',
      };
    }

    const quotedAmount = await quoteTokensByGasQuoteSources({
      signer: params.signer,
      config: params.config,
      liquiditySources: gasQuoteSourceCandidates,
      amountIn: gasCostNativeRaw,
      tokenIn: wrappedNativeAddress,
      tokenOut: params.quoteTokenAddress,
      chainId,
      preferredLiquiditySource,
      rpcCache: params.rpcCache,
      gasQuoteCacheKey,
    });
    if (!quotedAmount) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote: 0,
        ...gasResultMetadata,
        l2GasCostBufferBasisPoints,
        reason: 'failed to quote gas cost into quote token',
      };
    }
    gasCostQuoteRaw = quotedAmount.amountOut;
    gasCostQuote = Number(
      ethers.utils.formatUnits(gasCostQuoteRaw, quoteDecimals)
    );
  }

  const maxGasCostQuote = params.policy?.maxGasCostQuote;
  if (maxGasCostQuote !== undefined && gasCostQuote > maxGasCostQuote) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote,
      gasCostQuoteRaw,
      ...gasResultMetadata,
      l2GasCostBufferBasisPoints,
      quoteTokenDecimals: quoteDecimals,
      reason: `estimated gas cost ${gasCostQuote.toFixed(6)} exceeds maxGasCostQuote ${maxGasCostQuote}`,
    };
  }

  let minProfitNativeQuoteRaw: BigNumber | undefined;
  if (params.policy?.minProfitNative !== undefined) {
    minProfitNativeQuoteRaw = await quoteExactNativeAmountToQuote({
      signer: params.signer,
      config: params.config,
      liquiditySources: gasQuoteSourceCandidates,
      amountInNative: BigNumber.from(params.policy.minProfitNative),
      wrappedNativeAddress,
      quoteTokenAddress: params.quoteTokenAddress,
      chainId,
      preferredLiquiditySource,
      rpcCache: params.rpcCache,
      gasQuoteCacheKey,
    });
    if (minProfitNativeQuoteRaw === undefined) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote,
        gasCostQuoteRaw,
        ...gasResultMetadata,
        l2GasCostBufferBasisPoints,
        quoteTokenDecimals: quoteDecimals,
        reason: 'failed to quote minProfitNative into quote token',
      };
    }
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
  });
  return quotedAmount?.amountOut;
}
