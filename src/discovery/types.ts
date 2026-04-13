import { BigNumber } from 'ethers';
import { KeeperConfig } from '../config';
import { FactoryQuoteProviderRuntimeCache } from '../take/factory';

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

export interface DiscoveryRpcCache {
  gasPrice?: BigNumber;
  gasPriceFetchedAt?: number;
  gasQuoteConversions?: Map<string, BigNumber | null>;
  factoryQuoteProviders?: FactoryQuoteProviderRuntimeCache;
}
