import { Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  AutoDiscoverActionPolicy,
  AutoDiscoverTakePolicy,
  LiquiditySource,
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
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from './types';

export interface GasPolicyResult {
  approved: boolean;
  gasCostNative: number;
  gasCostQuote: number;
  gasCostQuoteRaw?: BigNumber;
  gasPriceGwei: number;
  quoteTokenDecimals?: number;
  reason?: string;
}

export interface NativeToQuoteConversion {
  amountInNative: BigNumber;
  amountOutQuoteRaw: BigNumber;
}

export function createDiscoveryTransportsForConfig(
  config: DiscoveryExecutionConfig,
  signer: Signer
): DiscoveryReadTransports {
  return createDiscoveryReadTransports(
    config as unknown as DiscoveryReadTransportConfig,
    signer.provider
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

function getTokenAddressCaseInsensitive(
  addresses: { [tokenSymbol: string]: string } | undefined,
  symbol: string
): string | undefined {
  if (!addresses) {
    return undefined;
  }
  for (const [key, value] of Object.entries(addresses)) {
    if (key.toLowerCase() === symbol.toLowerCase()) {
      return value;
    }
  }
  return undefined;
}

export function resolveWrappedNativeAddress(
  config: DiscoveryExecutionConfig,
  liquiditySource?: LiquiditySource
): string | undefined {
  if (liquiditySource === LiquiditySource.UNISWAPV3) {
    return config.universalRouterOverrides?.wethAddress;
  }
  if (liquiditySource === LiquiditySource.SUSHISWAP) {
    return config.sushiswapRouterOverrides?.wethAddress;
  }
  if (liquiditySource === LiquiditySource.CURVE) {
    return config.curveRouterOverrides?.wethAddress;
  }
  return (
    getTokenAddressCaseInsensitive(config.tokenAddresses, 'weth') ??
    config.universalRouterOverrides?.wethAddress ??
    config.sushiswapRouterOverrides?.wethAddress ??
    config.curveRouterOverrides?.wethAddress
  );
}

function resolveGasQuoteSource(
  config: DiscoveryExecutionConfig
): LiquiditySource | undefined {
  return (
    config.discoveredDefaults?.take?.liquiditySource ??
    (config.oneInchRouters ? LiquiditySource.ONEINCH : undefined) ??
    (config.universalRouterOverrides ? LiquiditySource.UNISWAPV3 : undefined) ??
    (config.sushiswapRouterOverrides ? LiquiditySource.SUSHISWAP : undefined) ??
    (config.curveRouterOverrides ? LiquiditySource.CURVE : undefined)
  );
}

async function quoteTokensByLiquiditySource(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  liquiditySource: LiquiditySource;
  amountIn: BigNumber;
  tokenIn: string;
  tokenOut: string;
}): Promise<BigNumber | undefined> {
  if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) {
    return params.amountIn;
  }

  if (params.liquiditySource === LiquiditySource.ONEINCH) {
    const chainId = await params.signer.getChainId();
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
      !routerConfig.wethAddress
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
      !sushiConfig.wethAddress
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

function gasQuoteConversionCacheKey(params: {
  liquiditySource: LiquiditySource;
  amountIn: BigNumber;
  tokenIn: string;
  tokenOut: string;
}): string {
  return [
    params.liquiditySource,
    params.amountIn.toString(),
    params.tokenIn.toLowerCase(),
    params.tokenOut.toLowerCase(),
  ].join('|');
}

export async function evaluateGasPolicy(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  transports: Pick<DiscoveryReadTransports, 'readRpc'>;
  policy?: Pick<
    AutoDiscoverActionPolicy,
    'maxGasCostNative' | 'maxGasCostQuote' | 'maxGasPriceGwei'
  > &
    Pick<AutoDiscoverTakePolicy, 'minExpectedProfitQuote'>;
  gasLimit: BigNumber;
  quoteTokenAddress: string;
  preferredLiquiditySource?: LiquiditySource;
  useProfitFloor?: boolean;
  gasPrice?: BigNumber;
  nativeToQuoteConversion?: NativeToQuoteConversion;
  rpcCache?: DiscoveryRpcCache;
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

  const gasCostNativeRaw = gasPrice.mul(params.gasLimit);
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
      params.policy?.minExpectedProfitQuote !== undefined);
  if (!requiresGasCostQuote) {
    return {
      approved: true,
      gasCostNative,
      gasCostQuote: 0,
      gasPriceGwei,
    };
  }

  const wrappedNativeAddress =
    resolveWrappedNativeAddress(
      params.config,
      params.preferredLiquiditySource
    ) ?? resolveWrappedNativeAddress(params.config, resolveGasQuoteSource(params.config));
  if (!wrappedNativeAddress) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote: 0,
      gasPriceGwei,
      reason: 'no wrapped native token configured for gas cost conversion',
    };
  }

  const quoteDecimals = await getDecimalsErc20(
    params.signer,
    params.quoteTokenAddress
  );

  let gasCostQuote: number;
  let gasCostQuoteRaw: BigNumber;
  if (wrappedNativeAddress.toLowerCase() === params.quoteTokenAddress.toLowerCase()) {
    gasCostQuoteRaw = gasCostNativeRaw;
    gasCostQuote = Number(
      ethers.utils.formatUnits(gasCostQuoteRaw, quoteDecimals)
    );
  } else if (
    params.nativeToQuoteConversion &&
    params.nativeToQuoteConversion.amountInNative.gt(0)
  ) {
    gasCostQuoteRaw = gasCostNativeRaw
      .mul(params.nativeToQuoteConversion.amountOutQuoteRaw)
      .add(params.nativeToQuoteConversion.amountInNative.sub(1))
      .div(params.nativeToQuoteConversion.amountInNative);
    gasCostQuote = Number(
      ethers.utils.formatUnits(gasCostQuoteRaw, quoteDecimals)
    );
  } else {
    const liquiditySource =
      params.preferredLiquiditySource ?? resolveGasQuoteSource(params.config);
    if (liquiditySource === undefined) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote: 0,
        gasPriceGwei,
        reason: 'no liquidity source available for gas cost conversion',
      };
    }

    const cacheKey = gasQuoteConversionCacheKey({
      liquiditySource,
      amountIn: gasCostNativeRaw,
      tokenIn: wrappedNativeAddress,
      tokenOut: params.quoteTokenAddress,
    });
    const quoteCache = params.rpcCache?.gasQuoteConversions;
    let quotedAmount = quoteCache?.get(cacheKey);
    if (quotedAmount === undefined) {
      quotedAmount =
        (await quoteTokensByLiquiditySource({
          signer: params.signer,
          config: params.config,
          liquiditySource,
          amountIn: gasCostNativeRaw,
          tokenIn: wrappedNativeAddress,
          tokenOut: params.quoteTokenAddress,
        })) ?? null;
      quoteCache?.set(cacheKey, quotedAmount);
    }
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

  return {
    approved: true,
    gasCostNative,
    gasCostQuote,
    gasCostQuoteRaw,
    gasPriceGwei,
    quoteTokenDecimals: quoteDecimals,
  };
}
