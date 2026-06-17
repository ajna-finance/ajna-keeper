import { Signer } from '@ajna-finance/sdk';
import { ReadRpc } from '../read-transports';
import {
  DirectDexQuoteProviderRuntimeCache,
  createDirectDexQuoteProviderRuntimeCache,
} from '../take/direct-dex';
import { DiscoveryRpcCache, ExternalProviderCircuits } from './types';

export async function createDiscoveryRpcCache(params: {
  signer: Signer;
  readRpc: ReadRpc;
  includeDirectDexQuoteProviders?: boolean;
  directDexQuoteProviders?: DirectDexQuoteProviderRuntimeCache;
  providerCircuits?: ExternalProviderCircuits;
}): Promise<DiscoveryRpcCache | undefined> {
  if (!params.signer.provider) {
    return undefined;
  }

  const chainIdInflight =
    typeof params.signer.getChainId === 'function'
      ? params.signer.getChainId()
      : Promise.resolve(undefined);
  const gasPriceInflight = params.readRpc.getGasPrice();
  const [chainId, gasPrice] = await Promise.all([
    chainIdInflight,
    gasPriceInflight,
  ]);
  const directDexQuoteProviders = params.includeDirectDexQuoteProviders
    ? (params.directDexQuoteProviders ?? createDirectDexQuoteProviderRuntimeCache())
    : undefined;
  if (directDexQuoteProviders && chainId !== undefined) {
    directDexQuoteProviders.chainId = chainId;
  }
  const providerCircuits = params.includeDirectDexQuoteProviders
    ? params.providerCircuits
    : undefined;

  return {
    chainId,
    gasPrice,
    gasPriceFetchedAt: Date.now(),
    stats: {
      directDex: {},
    },
    ...(params.includeDirectDexQuoteProviders
      ? {
          directDexQuoteProviders,
        }
      : {}),
    ...(providerCircuits
      ? {
          providerCircuits,
        }
      : {}),
  };
}
