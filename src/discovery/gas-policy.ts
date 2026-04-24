import { Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  AutoDiscoverActionPolicy,
  AutoDiscoverTakePolicy,
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
import { UniswapV3QuoteProvider } from '../dex/providers/uniswap-quote-provider';
import { SushiSwapQuoteProvider } from '../dex/providers/sushiswap-quote-provider';
import { getDecimalsErc20 } from '../erc20';
import {
  DiscoveryExecutionConfig,
  DiscoveryExecutionTransportConfig,
  DiscoveryRpcCache,
} from './types';

export interface GasPolicyResult {
  approved: boolean;
  gasCostNative: number;
  gasCostQuote: number;
  gasCostQuoteRaw?: BigNumber;
  minProfitNativeQuoteRaw?: BigNumber;
  gasPriceGwei: number;
  quoteTokenDecimals?: number;
  reason?: string;
}

const BASIS_POINTS_DENOMINATOR = BigNumber.from(10_000);
const L2_GAS_COST_BUFFER_BASIS_POINTS = BigNumber.from(13_000);
const L2_CHAIN_IDS_WITH_DATA_FEE_BUFFER = new Set([
  10,
  8453,
  42161,
  11155420,
  84532,
  421614,
]);

function applyL2GasCostBuffer(
  gasCostNativeRaw: BigNumber,
  chainId?: number
): BigNumber {
  if (chainId === undefined || !L2_CHAIN_IDS_WITH_DATA_FEE_BUFFER.has(chainId)) {
    return gasCostNativeRaw;
  }
  return gasCostNativeRaw
    .mul(L2_GAS_COST_BUFFER_BASIS_POINTS)
    .add(BASIS_POINTS_DENOMINATOR.sub(1))
    .div(BASIS_POINTS_DENOMINATOR);
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

async function quoteTokensByLiquiditySource(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  liquiditySource: LiquiditySource;
  amountIn: BigNumber;
  tokenIn: string;
  tokenOut: string;
  chainId?: number;
}): Promise<BigNumber | undefined> {
  if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) {
    return params.amountIn;
  }

  if (params.liquiditySource === LiquiditySource.ONEINCH) {
    const chainId = params.chainId ?? (await params.signer.getChainId());
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

    const quoteProvider = new UniswapV3QuoteProvider(params.signer, {
      universalRouterAddress: routerConfig.universalRouterAddress,
      poolFactoryAddress: routerConfig.poolFactoryAddress,
      defaultFeeTier: routerConfig.defaultFeeTier || 3000,
      wethAddress: routerConfig.wethAddress,
      quoterV2Address: routerConfig.quoterV2Address,
    });
    if (!quoteProvider.isAvailable()) {
      return undefined;
    }
    const quoteResult = await quoteProvider.getQuote(
      params.amountIn,
      params.tokenIn,
      params.tokenOut,
      routerConfig.defaultFeeTier
    );
    return quoteResult.success && quoteResult.dstAmount
      ? BigNumber.from(quoteResult.dstAmount)
      : undefined;
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
    const quoteProvider = new SushiSwapQuoteProvider(params.signer, {
      swapRouterAddress: sushiConfig.swapRouterAddress,
      quoterV2Address: sushiConfig.quoterV2Address,
      factoryAddress: sushiConfig.factoryAddress,
      defaultFeeTier: sushiConfig.defaultFeeTier || 500,
      wethAddress: sushiConfig.wethAddress,
    });
    const initialized = await quoteProvider.initialize();
    if (!initialized) {
      return undefined;
    }
    const quoteResult = await quoteProvider.getQuote(
      params.amountIn,
      params.tokenIn,
      params.tokenOut,
      sushiConfig.defaultFeeTier
    );
    return quoteResult.success && quoteResult.dstAmount
      ? BigNumber.from(quoteResult.dstAmount)
      : undefined;
  }

  if (params.liquiditySource === LiquiditySource.CURVE) {
    const curveConfig = params.config.curveRouterOverrides;
    if (!curveConfig?.poolConfigs || !curveConfig.wethAddress) {
      return undefined;
    }
    const { CurveQuoteProvider } = await import(
      '../dex/providers/curve-quote-provider'
    );
    const quoteProvider = new CurveQuoteProvider(params.signer, {
      poolConfigs: curveConfig.poolConfigs as any,
      defaultSlippage: curveConfig.defaultSlippage || 1.0,
      wethAddress: curveConfig.wethAddress,
      tokenAddresses: params.config.tokenAddresses || {},
    });
    const initialized = await quoteProvider.initialize();
    if (!initialized) {
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

export async function evaluateGasPolicy(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  transports: Pick<DiscoveryReadTransports, 'readRpc'>;
  policy?: Pick<
    AutoDiscoverActionPolicy,
    'maxGasCostNative' | 'maxGasCostQuote' | 'maxGasPriceGwei'
  > &
    Pick<AutoDiscoverTakePolicy, 'minExpectedProfitQuote' | 'minProfitNative'>;
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
  const maxGasPriceGwei = params.policy?.maxGasPriceGwei;
  if (maxGasPriceGwei !== undefined && gasPriceGwei > maxGasPriceGwei) {
    return {
      approved: false,
      gasCostNative: 0,
      gasCostQuote: 0,
      gasPriceGwei,
      reason: `gas price ${gasPriceGwei.toFixed(2)} gwei exceeds maxGasPriceGwei ${maxGasPriceGwei}`,
    };
  }

  const cachedChainId = params.chainId ?? params.rpcCache?.chainId;
  const unbufferedGasCostNativeRaw = gasPrice.mul(params.gasLimit);
  const gasCostNativeRaw = applyL2GasCostBuffer(
    unbufferedGasCostNativeRaw,
    cachedChainId
  );
  if (!gasCostNativeRaw.eq(unbufferedGasCostNativeRaw)) {
    logger.debug(
      `Applied conservative L2 gas cost buffer for chainId ${cachedChainId}: ${unbufferedGasCostNativeRaw.toString()} -> ${gasCostNativeRaw.toString()}`
    );
  }
  const gasCostNative = Number(ethers.utils.formatEther(gasCostNativeRaw));
  const maxGasCostNative = params.policy?.maxGasCostNative;
  if (maxGasCostNative !== undefined && gasCostNative > maxGasCostNative) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote: 0,
      gasPriceGwei,
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
      gasPriceGwei,
    };
  }

  const chainId = cachedChainId ?? (await params.signer.getChainId());
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
      gasPriceGwei,
      quoteTokenDecimals: quoteDecimals,
    };
  }

  const wrappedNativeAddress =
    resolveWrappedNativeAddress(
      params.config,
      preferredLiquiditySource
    ) ?? resolveWrappedNativeAddress(params.config, resolvedGasQuoteSource);
  if (!wrappedNativeAddress) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote: 0,
      gasPriceGwei,
      reason: 'no wrapped native token configured for gas cost conversion',
    };
  }

  let gasCostQuote: number;
  let gasCostQuoteRaw: BigNumber;
  if (wrappedNativeAddress.toLowerCase() === params.quoteTokenAddress.toLowerCase()) {
    gasCostQuoteRaw = gasCostNativeRaw;
    gasCostQuote = Number(
      ethers.utils.formatUnits(gasCostQuoteRaw, quoteDecimals)
    );
  } else {
    const liquiditySource = preferredLiquiditySource;
    if (liquiditySource === undefined) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote: 0,
        gasPriceGwei,
        reason: 'no liquidity source available for gas cost conversion',
      };
    }

    const quotedAmount = await quoteTokensByLiquiditySource({
      signer: params.signer,
      config: params.config,
      liquiditySource,
      amountIn: gasCostNativeRaw,
      tokenIn: wrappedNativeAddress,
      tokenOut: params.quoteTokenAddress,
      chainId,
    });
    if (!quotedAmount) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote: 0,
        gasPriceGwei,
        reason: 'failed to quote gas cost into quote token',
      };
    }
    gasCostQuoteRaw = quotedAmount;
    gasCostQuote = Number(ethers.utils.formatUnits(gasCostQuoteRaw, quoteDecimals));
  }

  const maxGasCostQuote = params.policy?.maxGasCostQuote;
  if (maxGasCostQuote !== undefined && gasCostQuote > maxGasCostQuote) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote,
      gasCostQuoteRaw,
      gasPriceGwei,
      quoteTokenDecimals: quoteDecimals,
      reason: `estimated gas cost ${gasCostQuote.toFixed(6)} exceeds maxGasCostQuote ${maxGasCostQuote}`,
    };
  }

  let minProfitNativeQuoteRaw: BigNumber | undefined;
  if (params.policy?.minProfitNative !== undefined) {
    minProfitNativeQuoteRaw = await quoteExactNativeAmountToQuote({
      signer: params.signer,
      config: params.config,
      liquiditySource: preferredLiquiditySource,
      amountInNative: BigNumber.from(params.policy.minProfitNative),
      wrappedNativeAddress,
      quoteTokenAddress: params.quoteTokenAddress,
      chainId,
    });
    if (minProfitNativeQuoteRaw === undefined) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote,
        gasCostQuoteRaw,
        gasPriceGwei,
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
    gasPriceGwei,
    quoteTokenDecimals: quoteDecimals,
  };
}

async function quoteExactNativeAmountToQuote(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  liquiditySource?: LiquiditySource;
  amountInNative: BigNumber;
  wrappedNativeAddress: string;
  quoteTokenAddress: string;
  chainId?: number;
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
  if (params.liquiditySource === undefined) {
    return undefined;
  }
  return await quoteTokensByLiquiditySource({
    signer: params.signer,
    config: params.config,
    liquiditySource: params.liquiditySource,
    amountIn: params.amountInNative,
    tokenIn: params.wrappedNativeAddress,
    tokenOut: params.quoteTokenAddress,
    chainId: params.chainId,
  });
}
