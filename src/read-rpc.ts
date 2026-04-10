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

const READ_RPC_FAILURE_THRESHOLD = 3;
const READ_RPC_COOLDOWN_MS = 30_000;
const READ_RPC_TIMEOUT_MS = 5_000;

const readProviders = new Map<string, providers.JsonRpcProvider>();

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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

export async function getResilientReadGasPrice(params: {
  config: Pick<KeeperConfig, 'ethRpcUrl' | 'readRpcUrls'>;
  primaryProvider?: providers.Provider;
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
      (usePrimaryProviderFirst ||
        (primaryProviderUrl && configuredEndpoints[0] !== primaryProviderUrl))
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
}

export function resetReadRpcHealthForTests(): void {
  clearReadProviderCache();
  clearEndpointHealthState();
}
