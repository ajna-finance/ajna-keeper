import { BigNumber } from 'ethers';
import {
  AutoDiscoverConfig,
  CurveRouterOverrides,
  DiscoveredDefaultsConfig,
  ExternalTakeTakerContractKey,
  KeeperConfig,
  LifiDexConfig,
  SushiAggregatorDexConfig,
  LiquiditySource,
  UniswapV3RouterOverrides,
  resolveExternalTakeDeployment,
} from '../config';
import {
  FactoryQuoteProviderRuntimeCache,
  FactoryQuoteProviderRuntimeStats,
} from '../take/direct-dex';
import {
  DiscoveryReadTransportConfig,
  getDiscoveryReadTransportConfig,
} from '../read-transports';

export interface DiscoveryExecutionConfig {
  autoDiscover?: AutoDiscoverConfig;
  connectorTokens?: Array<string>;
  curveRouterOverrides?: CurveRouterOverrides;
  dryRun?: boolean;
  discoveredDefaults?: DiscoveredDefaultsConfig;
  keeperTakerRouter?: string;
  takerContracts?: Partial<Record<ExternalTakeTakerContractKey, string>>;
  lifi?: LifiDexConfig;
  lifiTaker?: string;
  sushiAggregator?: SushiAggregatorDexConfig;
  sushiAggregatorTaker?: string;
  oneInchAggregatorTaker?: string;
  oneInchAggregationExecutorAllowlist?: { [chainId: number]: string[] };
  oneInchDefaultSlippage?: number;
  oneInchRouters?: { [chainId: number]: string };
  tokenAddresses?: { [tokenSymbol: string]: string };
  uniswapV3RouterOverrides?: UniswapV3RouterOverrides;
}

export type DiscoveryExecutionTransportConfig = DiscoveryExecutionConfig &
  DiscoveryReadTransportConfig;

export function getDiscoveryExecutionConfig(
  config: KeeperConfig
): DiscoveryExecutionConfig {
  const lifiDeployment = resolveExternalTakeDeployment({
    liquiditySource: LiquiditySource.LIFI,
    config: {
      keeperTakerRouter: config.takers?.router,
      takerContracts: config.takers?.contracts,
    },
  });
  const sushiAggregatorDeployment = resolveExternalTakeDeployment({
    liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
    config: {
      keeperTakerRouter: config.takers?.router,
      takerContracts: config.takers?.contracts,
    },
  });
  const oneInchAggregatorDeployment = resolveExternalTakeDeployment({
    liquiditySource: LiquiditySource.ONEINCH,
    config: {
      keeperTakerRouter: config.takers?.router,
      takerContracts: config.takers?.contracts,
    },
  });
  return {
    autoDiscover: config.discovery,
    connectorTokens: config.dex?.oneInch?.connectorTokens,
    curveRouterOverrides: config.dex?.curve,
    dryRun: config.runtime.dryRun,
    discoveredDefaults: config.discovery?.defaults,
    keeperTakerRouter: config.takers?.router,
    takerContracts: config.takers?.contracts,
    lifi: config.dex?.lifi,
    lifiTaker:
      lifiDeployment.deploymentType === 'calldata_aggregator'
        ? lifiDeployment.resolvedTakerAddress
        : undefined,
    sushiAggregator: config.dex?.sushiAggregator,
    sushiAggregatorTaker:
      sushiAggregatorDeployment.deploymentType === 'calldata_aggregator'
        ? sushiAggregatorDeployment.resolvedTakerAddress
        : undefined,
    oneInchAggregatorTaker:
      oneInchAggregatorDeployment.deploymentType === 'calldata_aggregator'
        ? oneInchAggregatorDeployment.resolvedTakerAddress
        : undefined,
    oneInchAggregationExecutorAllowlist:
      config.dex?.oneInch?.aggregationExecutorAllowlist,
    oneInchDefaultSlippage: config.dex?.oneInch?.defaultSlippage,
    oneInchRouters: config.dex?.oneInch?.routers,
    tokenAddresses: config.network.tokenAddresses,
    uniswapV3RouterOverrides: config.dex?.uniswapV3?.router,
  };
}

export function getDiscoveryExecutionTransportConfig(
  config: KeeperConfig
): DiscoveryExecutionTransportConfig {
  return {
    ...getDiscoveryExecutionConfig(config),
    ...getDiscoveryReadTransportConfig(config),
  };
}

export interface OneInchQuoteCircuitState {
  failures: number;
  cooldownUntilMs?: number;
  lastOpenLogAtMs?: number;
}

export type OneInchQuoteCircuitPurpose =
  | 'route_quote'
  | 'swap_data'
  | 'gas_conversion';

export interface ExternalProviderCircuitState {
  failures: number;
  cooldownUntilMs?: number;
  lastOpenLogAtMs?: number;
}

export type ExternalProviderCircuitPath = 'oneinch' | 'lifi';
export type LifiCircuitPurpose = 'route_quote' | 'execution_refresh';

// Union of every provider's circuit purposes, used by ExternalTakeRouteProvider
// metadata so a provider can declare which circuits it participates in.
export type ExternalTakeCircuitPurpose =
  | OneInchQuoteCircuitPurpose
  | LifiCircuitPurpose;

export type ExternalProviderCircuitPurposeByPath = {
  oneinch: OneInchQuoteCircuitPurpose;
  lifi: LifiCircuitPurpose;
};

export type ExternalProviderCircuits = {
  [Path in ExternalProviderCircuitPath]?: Partial<
    Record<
      ExternalProviderCircuitPurposeByPath[Path],
      ExternalProviderCircuitState
    >
  >;
};

export interface DiscoveryRpcCache {
  chainId?: number;
  gasPrice?: BigNumber;
  gasPriceFetchedAt?: number;
  gasPriceInflight?: Promise<BigNumber>;
  factoryQuoteProviders?: FactoryQuoteProviderRuntimeCache;
  stats?: DiscoveryRpcCacheStats;
  gasQuoteFallbackWarningKeys?: Set<string>;
  gasQuoteConversions?: Map<string, GasQuoteConversionCacheEntry>;
  oneInchQuoteCircuits?: Partial<
    Record<OneInchQuoteCircuitPurpose, OneInchQuoteCircuitState>
  >;
  oneInchQuoteCircuit?: OneInchQuoteCircuitState;
  providerCircuits?: ExternalProviderCircuits;
}

export interface DiscoveryRpcCacheStats {
  takeStatusReadCount?: number;
  takeStatusBatchReadCount?: number;
  takeStatusBatchBorrowerCount?: number;
  takeStatusBatchFallbackCount?: number;
  gasQuoteConversionCacheHits?: number;
  gasQuoteConversionCacheMisses?: number;
  routeProbeAbandonedCount?: number;
  factory?: FactoryQuoteProviderRuntimeStats;
}

export interface GasQuoteConversionCacheEntry {
  value: BigNumber;
  createdAtMs: number;
  gasPrice: BigNumber;
  liquiditySource: LiquiditySource;
}
