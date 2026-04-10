import { BigNumber } from 'ethers';
import { KeeperConfig } from '../config-types';
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
  factoryQuoteProviders?: FactoryQuoteProviderRuntimeCache;
}
