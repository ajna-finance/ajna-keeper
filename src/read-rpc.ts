import { BigNumber, providers } from 'ethers';
import { KeeperConfig } from './config';
import {
  EndpointKind,
  clearEndpointHealthState,
  formatEndpointForLogs,
  logEndpointFailover,
  orderEndpointsByHealth,
  recordEndpointFailure,
  recordEndpointSuccess,
} from './endpoint-health';
import { logger } from './logging';
import { JsonRpcProvider } from './provider';
import { withTimeout } from './utils';

const READ_RPC_FAILURE_THRESHOLD = 3;
const READ_RPC_COOLDOWN_MS = 30_000;
const READ_RPC_TIMEOUT_MS = 5_000;

const readProviders = new Map<string, providers.JsonRpcProvider>();
const readProviderChainIds = new Map<string, number>();

function uniqueEndpoints(endpoints: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const endpoint of endpoints) {
    if (!endpoint || seen.has(endpoint)) {
      continue;
    }
    seen.add(endpoint);
    result.push(endpoint);
  }
  return result;
}

function inferProviderUrl(
  provider: providers.Provider | undefined
): string | undefined {
  return (provider as any)?.connection?.url;
}

function getReadRpcEndpoints(config: Pick<KeeperConfig, 'ethRpcUrl' | 'readRpcUrls'>): string[] {
  if (config.readRpcUrls && config.readRpcUrls.length > 0) {
    return uniqueEndpoints(config.readRpcUrls);
  }
  return uniqueEndpoints([config.ethRpcUrl]);
}

function getReadProvider(url: string): providers.JsonRpcProvider {
  const cached = readProviders.get(url);
  if (cached) {
    return cached;
  }
  const provider = new JsonRpcProvider(url);
  readProviders.set(url, provider);
  return provider;
}

async function getReadProviderChainId(
  endpoint: string,
  provider: providers.Provider
): Promise<number> {
  const cached = readProviderChainIds.get(endpoint);
  if (cached !== undefined) {
    return cached;
  }

  const network = await withTimeout(
    provider.getNetwork(),
    READ_RPC_TIMEOUT_MS,
    `read-rpc getNetwork for ${formatEndpointForLogs(endpoint)}`
  );
  const chainId = Number(network.chainId);
  readProviderChainIds.set(endpoint, chainId);
  return chainId;
}

export async function getResilientReadGasPrice(params: {
  config: Pick<KeeperConfig, 'ethRpcUrl' | 'readRpcUrls'>;
  primaryProvider?: providers.Provider;
  expectedChainId?: number;
}): Promise<BigNumber> {
  const endpointKind: EndpointKind = 'read-rpc';
  const configuredEndpoints = getReadRpcEndpoints(params.config);
  const primaryProviderUrl = inferProviderUrl(params.primaryProvider);
  const primaryEndpoint =
    primaryProviderUrl ?? params.config.ethRpcUrl ?? '__primary_provider__';
  const usePrimaryProviderFirst =
    !!params.primaryProvider &&
    (!params.config.readRpcUrls || params.config.readRpcUrls.length === 0);
  const orderedEndpoints = orderEndpointsByHealth(
    endpointKind,
    uniqueEndpoints(
      usePrimaryProviderFirst
        ? [primaryEndpoint, ...configuredEndpoints]
        : configuredEndpoints
    )
  );

  let lastError: unknown;
  for (let index = 0; index < orderedEndpoints.length; index++) {
    const endpoint = orderedEndpoints[index];
    const provider =
      params.primaryProvider &&
      index === 0 &&
      endpoint === primaryEndpoint
        ? params.primaryProvider
        : getReadProvider(endpoint);

    try {
      if (
        params.expectedChainId !== undefined &&
        provider !== params.primaryProvider
      ) {
        const providerChainId = await getReadProviderChainId(endpoint, provider);
        if (providerChainId !== params.expectedChainId) {
          throw new Error(
            `read-rpc endpoint ${formatEndpointForLogs(endpoint)} is on chainId ${providerChainId}, expected ${params.expectedChainId}`
          );
        }
      }

      const gasPrice = await withTimeout(
        provider.getGasPrice(),
        READ_RPC_TIMEOUT_MS,
        `read-rpc getGasPrice for ${formatEndpointForLogs(endpoint)}`
      );
      recordEndpointSuccess(endpointKind, endpoint);
      if (index > 0) {
        logger.warn(
          `read-rpc request succeeded on fallback endpoint=${formatEndpointForLogs(endpoint)}`
        );
      }
      return gasPrice;
    } catch (error) {
      lastError = error;
      recordEndpointFailure(endpointKind, endpoint, error, {
        failureThreshold: READ_RPC_FAILURE_THRESHOLD,
        cooldownMs: READ_RPC_COOLDOWN_MS,
      });
      const nextEndpoint = orderedEndpoints[index + 1];
      if (nextEndpoint) {
        logEndpointFailover({
          kind: endpointKind,
          from: endpoint,
          to: nextEndpoint,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throw lastError ?? new Error('All read-rpc endpoints failed');
}

export function clearReadProviderCache(): void {
  readProviders.clear();
  readProviderChainIds.clear();
}

export function resetReadRpcHealthForTests(): void {
  clearReadProviderCache();
  clearEndpointHealthState();
}
