import {
  CurveRouterOverrides,
  DiscoveredDefaultsConfig,
  KeeperConfig,
  LiquiditySource,
  SushiswapRouterOverrides,
  UniversalRouterOverrides,
  hasNonEmptyObject,
} from './schema';
import { MAX_UINT24_FEE_TIER } from '../constants';

export interface LiquiditySourceConfig {
  curveRouterOverrides?: CurveRouterOverrides;
  discoveredDefaults?: DiscoveredDefaultsConfig;
  oneInchRouters?: { [chainId: number]: string };
  sushiswapRouterOverrides?: SushiswapRouterOverrides;
  tokenAddresses?: { [tokenSymbol: string]: string };
  universalRouterOverrides?: UniversalRouterOverrides;
}

export function getLiquiditySourceConfig(
  config: KeeperConfig
): LiquiditySourceConfig {
  return {
    curveRouterOverrides: config.dex?.curve,
    discoveredDefaults: config.discovery?.defaults,
    oneInchRouters: config.dex?.oneInch?.routers,
    sushiswapRouterOverrides: config.dex?.sushiswap,
    tokenAddresses: config.network.tokenAddresses,
    universalRouterOverrides: config.dex?.uniswapV3?.universalRouter,
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

type DefaultFactoryFeeTierSource =
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.SUSHISWAP;

export const DEFAULT_FEE_TIER_BY_SOURCE: Readonly<
  Record<DefaultFactoryFeeTierSource, number>
> = {
  [LiquiditySource.UNISWAPV3]: 3000,
  [LiquiditySource.SUSHISWAP]: 500,
};

export const STANDARD_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

export function isValidFactoryFeeTier(tier: number): boolean {
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
  return params.filterInvalid ? tiers.filter(isValidFactoryFeeTier) : tiers;
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
      return !!(
        config.universalRouterOverrides?.universalRouterAddress &&
        config.universalRouterOverrides.poolFactoryAddress &&
        config.universalRouterOverrides.wethAddress &&
        config.universalRouterOverrides.quoterV2Address
      );
    case LiquiditySource.SUSHISWAP:
      return !!(
        config.sushiswapRouterOverrides?.swapRouterAddress &&
        config.sushiswapRouterOverrides.factoryAddress &&
        config.sushiswapRouterOverrides.wethAddress &&
        config.sushiswapRouterOverrides.quoterV2Address
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
