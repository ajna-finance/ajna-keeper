import { Signer } from '@ajna-finance/sdk';
import { ReadRpc } from '../read-transports';
import { createFactoryQuoteProviderRuntimeCache } from '../take/factory';
import { DiscoveryRpcCache } from './types';

export async function createDiscoveryRpcCache(params: {
  signer: Signer;
  readRpc: ReadRpc;
  includeFactoryQuoteProviders?: boolean;
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
          factoryQuoteProviders: createFactoryQuoteProviderRuntimeCache(),
        }
      : {}),
  };
}
