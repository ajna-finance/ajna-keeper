import { BigNumber } from 'ethers';
import { KeeperConfig } from '../config';
import { FactoryQuoteProviderRuntimeCache } from '../take/factory';
import { DiscoveryReadTransportConfig } from '../read-transports';

export type DiscoveryExecutionConfig = Pick<
  KeeperConfig,
  | 'autoDiscover'
  | 'connectorTokens'
  | 'curveRouterOverrides'
  | 'delayBetweenActions'
  | 'dryRun'
  | 'discoveredDefaults'
  | 'keeperTaker'
  | 'keeperTakerFactory'
  | 'oneInchRouters'
  | 'sushiswapRouterOverrides'
  | 'takerContracts'
  | 'tokenAddresses'
  | 'universalRouterOverrides'
>;

export type DiscoveryExecutionTransportConfig = DiscoveryExecutionConfig &
  DiscoveryReadTransportConfig;

export interface DiscoveryRpcCache {
  chainId?: number;
  gasPrice?: BigNumber;
  gasPriceFetchedAt?: number;
  factoryQuoteProviders?: FactoryQuoteProviderRuntimeCache;
  gasQuoteFallbackWarningKeys?: Set<string>;
}
