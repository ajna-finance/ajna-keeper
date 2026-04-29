import { BigNumber } from 'ethers';
import {
  AutoDiscoverConfig,
  CurveRouterOverrides,
  DiscoveredDefaultsConfig,
  KeeperConfig,
  SushiswapRouterOverrides,
  UniversalRouterOverrides,
} from '../config';
import {
  FactoryQuoteProviderRuntimeCache,
  FactoryQuoteProviderRuntimeStats,
} from '../take/factory';
import {
  DiscoveryReadTransportConfig,
  getDiscoveryReadTransportConfig,
} from '../read-transports';

export interface DiscoveryExecutionConfig {
  autoDiscover?: AutoDiscoverConfig;
  connectorTokens?: Array<string>;
  curveRouterOverrides?: CurveRouterOverrides;
  delayBetweenActions: number;
  dryRun?: boolean;
  discoveredDefaults?: DiscoveredDefaultsConfig;
  keeperTaker?: string;
  keeperTakerFactory?: string;
  oneInchAggregationExecutorAllowlist?: { [chainId: number]: string[] };
  oneInchDefaultSlippage?: number;
  oneInchRouters?: { [chainId: number]: string };
  sushiswapRouterOverrides?: SushiswapRouterOverrides;
  takerContracts?: { [source: string]: string };
  tokenAddresses?: { [tokenSymbol: string]: string };
  universalRouterOverrides?: UniversalRouterOverrides;
}

export type DiscoveryExecutionTransportConfig = DiscoveryExecutionConfig &
  DiscoveryReadTransportConfig;

export function getDiscoveryExecutionConfig(
  config: KeeperConfig
): DiscoveryExecutionConfig {
  return {
    autoDiscover: config.discovery,
    connectorTokens: config.dex?.oneInch?.connectorTokens,
    curveRouterOverrides: config.dex?.curve,
    delayBetweenActions: config.runtime.delayBetweenActions,
    dryRun: config.runtime.dryRun,
    discoveredDefaults: config.discovery?.defaults,
    keeperTaker: config.takers?.oneInch,
    keeperTakerFactory: config.takers?.factory,
    oneInchAggregationExecutorAllowlist:
      config.dex?.oneInch?.aggregationExecutorAllowlist,
    oneInchDefaultSlippage: config.dex?.oneInch?.defaultSlippage,
    oneInchRouters: config.dex?.oneInch?.routers,
    sushiswapRouterOverrides: config.dex?.sushiswap,
    takerContracts: config.takers?.contracts,
    tokenAddresses: config.network.tokenAddresses,
    universalRouterOverrides: config.dex?.uniswapV3?.universalRouter,
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

export interface DiscoveryRpcCache {
  chainId?: number;
  gasPrice?: BigNumber;
  gasPriceFetchedAt?: number;
  gasPriceInflight?: Promise<BigNumber>;
  factoryQuoteProviders?: FactoryQuoteProviderRuntimeCache;
  stats?: DiscoveryRpcCacheStats;
  gasQuoteFallbackWarningKeys?: Set<string>;
  gasQuoteConversions?: Map<string, GasQuoteConversionCacheEntry>;
  oneInchQuoteCircuit?: OneInchQuoteCircuitState;
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
}
