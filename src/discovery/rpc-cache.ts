import { Signer } from '@ajna-finance/sdk';
import { ReadRpc } from '../read-transports';
import {
  FactoryQuoteProviderRuntimeCache,
  createFactoryQuoteProviderRuntimeCache,
} from '../take/direct-dex';
import {
  DiscoveryRpcCache,
  ExternalProviderCircuits,
  OneInchQuoteCircuitState,
} from './types';

export async function createDiscoveryRpcCache(params: {
  signer: Signer;
  readRpc: ReadRpc;
  includeFactoryQuoteProviders?: boolean;
  factoryQuoteProviders?: FactoryQuoteProviderRuntimeCache;
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
  const factoryQuoteProviders = params.includeFactoryQuoteProviders
    ? (params.factoryQuoteProviders ?? createFactoryQuoteProviderRuntimeCache())
    : undefined;
  if (factoryQuoteProviders && chainId !== undefined) {
    factoryQuoteProviders.chainId = chainId;
  }
  const providerCircuits = params.includeFactoryQuoteProviders
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
      factory: {},
    },
    ...(params.includeFactoryQuoteProviders
      ? {
          factoryQuoteProviders,
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
