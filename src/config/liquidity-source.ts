import {
  CurveRouterOverrides,
  DiscoveredDefaultsConfig,
  KeeperConfig,
  LiquiditySource,
  UniswapV3RouterOverrides,
  hasNonEmptyObject,
} from './schema';
import { MAX_UINT24_FEE_TIER } from '../constants';

export interface LiquiditySourceConfig {
  curveRouterOverrides?: CurveRouterOverrides;
  discoveredDefaults?: DiscoveredDefaultsConfig;
  oneInchRouters?: { [chainId: number]: string };
  tokenAddresses?: { [tokenSymbol: string]: string };
  uniswapV3RouterOverrides?: UniswapV3RouterOverrides;
}

export function getLiquiditySourceConfig(
  config: KeeperConfig
): LiquiditySourceConfig {
  return {
    curveRouterOverrides: config.dex?.curve,
    discoveredDefaults: config.discovery?.defaults,
    oneInchRouters: config.dex?.oneInch?.routers,
    tokenAddresses: config.network.tokenAddresses,
    uniswapV3RouterOverrides: config.dex?.uniswapV3?.router,
  };
}

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

type DefaultV3FeeTierSource = LiquiditySource.UNISWAPV3;

export const DEFAULT_FEE_TIER_BY_SOURCE: Readonly<
  Record<DefaultV3FeeTierSource, number>
> = {
  [LiquiditySource.UNISWAPV3]: 3000,
};

export const STANDARD_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

export const UNISWAP_V3_FACTORY_ROUTE_REQUIRED_ADDRESS_FIELDS = [
  'swapRouter02Address',
  'poolFactoryAddress',
  'quoterV2Address',
  'wethAddress',
] as const;

export type UniswapV3DirectDexRouteAddressField =
  (typeof UNISWAP_V3_FACTORY_ROUTE_REQUIRED_ADDRESS_FIELDS)[number];

export const UNISWAP_V3_DIRECT_DEX_ROUTE_CONTRACT_ADDRESS_FIELDS: readonly UniswapV3DirectDexRouteAddressField[] =
  [
    'swapRouter02Address',
    'poolFactoryAddress',
    'quoterV2Address',
    'wethAddress',
  ];

export interface ResolvedUniswapV3DirectDexQuoteConfig {
  poolFactoryAddress: string;
  quoterV2Address: string;
  wethAddress: string;
  defaultFeeTier: number;
  candidateFeeTiers?: number[];
  defaultSlippage?: number;
}

export interface ResolvedUniswapV3DirectDexRouteConfig
  extends ResolvedUniswapV3DirectDexQuoteConfig {
  swapRouter02Address: string;
}

export function getMissingUniswapV3DirectDexRouteConfigFields(
  config: UniswapV3RouterOverrides | undefined
): UniswapV3DirectDexRouteAddressField[] {
  return UNISWAP_V3_FACTORY_ROUTE_REQUIRED_ADDRESS_FIELDS.filter(
    (field) => !config?.[field]
  );
}

export function resolveUniswapV3DirectDexQuoteConfig(
  config: UniswapV3RouterOverrides | undefined
): ResolvedUniswapV3DirectDexQuoteConfig | undefined {
  if (
    !config?.poolFactoryAddress ||
    !config.quoterV2Address ||
    !config.wethAddress
  ) {
    return undefined;
  }

  return {
    poolFactoryAddress: config.poolFactoryAddress,
    quoterV2Address: config.quoterV2Address,
    wethAddress: config.wethAddress,
    defaultFeeTier:
      config.defaultFeeTier ??
      DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3],
    candidateFeeTiers: config.candidateFeeTiers,
    defaultSlippage: config.defaultSlippage,
  };
}

export function resolveUniswapV3DirectDexRouteConfig(
  config: UniswapV3RouterOverrides | undefined
): ResolvedUniswapV3DirectDexRouteConfig | undefined {
  const quoteConfig = resolveUniswapV3DirectDexQuoteConfig(config);
  if (!quoteConfig || !config?.swapRouter02Address) {
    return undefined;
  }

  return {
    ...quoteConfig,
    swapRouter02Address: config.swapRouter02Address,
  };
}

export function isValidV3FeeTier(tier: number): boolean {
  return Number.isInteger(tier) && tier > 0 && tier <= MAX_UINT24_FEE_TIER;
}

export function getEffectiveV3FeeTiers(params: {
  defaultFeeTier?: number;
  fallbackFeeTier?: number;
  candidateFeeTiers?: readonly number[];
  automaticCandidateFeeTiers?: readonly number[];
  filterInvalid?: boolean;
}): number[] {
  const primaryTier = params.defaultFeeTier ?? params.fallbackFeeTier;
  const candidateTiers =
    params.candidateFeeTiers !== undefined
      ? params.candidateFeeTiers
      : (params.automaticCandidateFeeTiers ??
        (primaryTier !== undefined ? [primaryTier] : []));
  const tiers = Array.from(
    new Set([
      ...(primaryTier !== undefined ? [primaryTier] : []),
      ...candidateTiers,
    ])
  );
  return params.filterInvalid ? tiers.filter(isValidV3FeeTier) : tiers;
}

export function formatLiquiditySource(
  source: LiquiditySource | undefined
): string {
  return source !== undefined
    ? (LiquiditySource[source] ?? String(source))
    : 'n/a';
}

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
      return !!resolveUniswapV3DirectDexQuoteConfig(
        config.uniswapV3RouterOverrides
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
      config.uniswapV3RouterOverrides?.wethAddress ??
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
    config.uniswapV3RouterOverrides?.wethAddress ??
    config.curveRouterOverrides?.wethAddress
  );
}

export function hasConfiguredWrappedNativeAddress(
  config: LiquiditySourceConfig
): boolean {
  return resolveConfiguredWrappedNativeAddress(config) !== undefined;
}
