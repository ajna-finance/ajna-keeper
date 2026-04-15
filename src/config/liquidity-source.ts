import { KeeperConfig, LiquiditySource, hasNonEmptyObject } from './schema';

type LiquiditySourceConfig = Pick<
  KeeperConfig,
  | 'curveRouterOverrides'
  | 'discoveredDefaults'
  | 'oneInchRouters'
  | 'sushiswapRouterOverrides'
  | 'tokenAddresses'
  | 'universalRouterOverrides'
>;

export const WRAPPED_NATIVE_TOKEN_SYMBOLS = [
  'weth',
  'wavax',
  'wftm',
  'wmatic',
  'wbnb',
  'wxdai',
  'wglmr',
  'wmovr',
  'wsei',
  'wrose',
  'wnear',
  'wone',
];

export function getTokenAddressCaseInsensitive(
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

export function resolveWrappedNativeTokenAddress(
  addresses: { [tokenSymbol: string]: string } | undefined
): string | undefined {
  for (const symbol of WRAPPED_NATIVE_TOKEN_SYMBOLS) {
    const address = getTokenAddressCaseInsensitive(addresses, symbol);
    if (address) {
      return address;
    }
  }

  return undefined;
}

export function hasConfiguredGasQuoteLiquiditySource(
  config: LiquiditySourceConfig,
  liquiditySource: LiquiditySource,
  chainId?: number
): boolean {
  switch (liquiditySource) {
    case LiquiditySource.ONEINCH:
      return !!(
        hasNonEmptyObject(config.oneInchRouters) &&
        (chainId === undefined || config.oneInchRouters?.[chainId])
      );
    case LiquiditySource.UNISWAPV3:
      return !!(
        config.universalRouterOverrides?.universalRouterAddress &&
        config.universalRouterOverrides.poolFactoryAddress &&
        config.universalRouterOverrides.wethAddress
      );
    case LiquiditySource.SUSHISWAP:
      return !!(
        config.sushiswapRouterOverrides?.swapRouterAddress &&
        config.sushiswapRouterOverrides.factoryAddress &&
        config.sushiswapRouterOverrides.wethAddress
      );
    case LiquiditySource.CURVE:
      return !!(
        hasNonEmptyObject(config.curveRouterOverrides?.poolConfigs) &&
        config.curveRouterOverrides?.wethAddress
      );
    default:
      return false;
  }
}

export function resolveConfiguredGasQuoteLiquiditySource(
  config: LiquiditySourceConfig,
  chainId?: number
): LiquiditySource | undefined {
  const preferredSource = config.discoveredDefaults?.take?.liquiditySource;
  if (
    preferredSource !== undefined &&
    hasConfiguredGasQuoteLiquiditySource(config, preferredSource, chainId)
  ) {
    return preferredSource;
  }

  for (const candidate of [
    LiquiditySource.ONEINCH,
    LiquiditySource.UNISWAPV3,
    LiquiditySource.SUSHISWAP,
    LiquiditySource.CURVE,
  ]) {
    if (hasConfiguredGasQuoteLiquiditySource(config, candidate, chainId)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveConfiguredWrappedNativeAddress(
  config: LiquiditySourceConfig,
  liquiditySource?: LiquiditySource
): string | undefined {
  if (liquiditySource === LiquiditySource.UNISWAPV3) {
    return (
      config.universalRouterOverrides?.wethAddress ??
      resolveWrappedNativeTokenAddress(config.tokenAddresses)
    );
  }

  if (liquiditySource === LiquiditySource.SUSHISWAP) {
    return (
      config.sushiswapRouterOverrides?.wethAddress ??
      resolveWrappedNativeTokenAddress(config.tokenAddresses)
    );
  }

  if (liquiditySource === LiquiditySource.CURVE) {
    return (
      config.curveRouterOverrides?.wethAddress ??
      resolveWrappedNativeTokenAddress(config.tokenAddresses)
    );
  }

  return (
    resolveWrappedNativeTokenAddress(config.tokenAddresses) ??
    config.universalRouterOverrides?.wethAddress ??
    config.sushiswapRouterOverrides?.wethAddress ??
    config.curveRouterOverrides?.wethAddress
  );
}

export function hasConfiguredWrappedNativeAddress(
  config: LiquiditySourceConfig
): boolean {
  return resolveConfiguredWrappedNativeAddress(config) !== undefined;
}
