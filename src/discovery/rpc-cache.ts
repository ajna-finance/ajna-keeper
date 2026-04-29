import { Signer } from '@ajna-finance/sdk';
import { ReadRpc } from '../read-transports';
import {
  FactoryQuoteProviderRuntimeCache,
  createFactoryQuoteProviderRuntimeCache,
} from '../take/factory';
import { DiscoveryRpcCache, OneInchQuoteCircuitState } from './types';

export async function createDiscoveryRpcCache(params: {
  signer: Signer;
  readRpc: ReadRpc;
  includeFactoryQuoteProviders?: boolean;
  factoryQuoteProviders?: FactoryQuoteProviderRuntimeCache;
  oneInchQuoteCircuit?: OneInchQuoteCircuitState;
}): Promise<DiscoveryRpcCache | undefined> {
  if (!params.signer.provider) {
    return undefined;
  }

  const chainId =
    typeof params.signer.getChainId === 'function'
      ? await params.signer.getChainId()
      : undefined;
  const factoryQuoteProviders = params.includeFactoryQuoteProviders
    ? (params.factoryQuoteProviders ?? createFactoryQuoteProviderRuntimeCache())
    : undefined;
  if (factoryQuoteProviders && chainId !== undefined) {
    factoryQuoteProviders.chainId = chainId;
  }

  return {
    chainId,
    gasPrice: await params.readRpc.getGasPrice(),
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
  };
}
