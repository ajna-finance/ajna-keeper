import { Signer } from '@ajna-finance/sdk';
import { ReadRpc } from '../read-transports';
import {
  DirectDexQuoteProviderRuntimeCache,
  createDirectDexQuoteProviderRuntimeCache,
} from '../take/direct-dex';
import {
  DiscoveryRpcCache,
  ExternalProviderCircuits,
  OneInchQuoteCircuitState,
} from './types';

export async function createDiscoveryRpcCache(params: {
  signer: Signer;
  readRpc: ReadRpc;
  includeDirectDexQuoteProviders?: boolean;
  directDexQuoteProviders?: DirectDexQuoteProviderRuntimeCache;
  oneInchQuoteCircuit?: OneInchQuoteCircuitState;
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
  if (providerCircuits && params.oneInchQuoteCircuit) {
    providerCircuits.oneinch ??= {};
    providerCircuits.oneinch.route_quote = params.oneInchQuoteCircuit;
  }

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
    ...(params.oneInchQuoteCircuit
      ? {
          oneInchQuoteCircuit: params.oneInchQuoteCircuit,
        }
      : {}),
    ...(providerCircuits
      ? {
          providerCircuits,
        }
      : {}),
  };
}
