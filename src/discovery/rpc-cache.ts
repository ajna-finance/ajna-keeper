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

  return {
    chainId:
      typeof params.signer.getChainId === 'function'
        ? await params.signer.getChainId()
        : undefined,
    gasPrice: await params.readRpc.getGasPrice(),
    gasPriceFetchedAt: Date.now(),
    ...(params.includeFactoryQuoteProviders
      ? {
          factoryQuoteProviders:
            params.factoryQuoteProviders ??
            createFactoryQuoteProviderRuntimeCache(),
        }
      : {}),
    ...(params.oneInchQuoteCircuit
      ? {
          oneInchQuoteCircuit: params.oneInchQuoteCircuit,
        }
      : {}),
  };
}
