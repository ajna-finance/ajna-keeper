import { ethers, providers } from 'ethers';
import { KeeperConfig } from '../../config';
import { normalizeSushiAggregatorChainPolicy } from '../../config/sushi-aggregator-policy';
import {
  AGGREGATOR_TAKER_ALLOWLIST_ABI,
  compareTakerAllowlistPolicy,
  createTakerAllowlistReader,
  readTakerAllowlistSnapshot,
} from '../../take/aggregator-calldata/allowlist';
import { getErrorMessage } from '../../utils';

/**
 * Sushi aggregator route-deployment preflight (Packet 3B). Fail-closed
 * before live use:
 * - the configured factory must be compiled with the appended
 *   SUSHI_AGGREGATOR source id (old factories are rejected: their
 *   getConfiguredTakers() enumeration stops at the old last source)
 * - the deployed taker's on-chain call-target / approval-spender / selector
 *   allowlists must exactly match the normalized dex.sushiAggregator policy
 *   for the chain
 */
const FACTORY_CONFIGURED_TAKERS_ABI = [
  'function getConfiguredTakers() view returns (uint8[] memory sources, address[] memory takers)',
];
const SUSHI_AGGREGATOR_SOURCE_ID = 6;
const PREFLIGHT_READ_RETRY_DELAYS_MS = [100, 250, 500];

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readWithRetries<T>(params: {
  label: string;
  operation: () => Promise<T>;
}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PREFLIGHT_READ_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await params.operation();
    } catch (error) {
      lastError = error;
      const delay = PREFLIGHT_READ_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await sleepMs(delay);
      }
    }
  }
  throw new Error(
    `${params.label} could not be read after retries: ${getErrorMessage(lastError)}`
  );
}

export async function validateSushiAggregatorFactorySupport(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  errors: string[];
}): Promise<void> {
  const factoryAddress = params.config.takers?.router;
  if (!factoryAddress) {
    params.errors.push(
      'Sushi aggregator preflight: takers.router is not configured'
    );
    return;
  }
  try {
    const factory = new ethers.Contract(
      factoryAddress,
      FACTORY_CONFIGURED_TAKERS_ABI,
      params.provider
    );
    const configured = (await readWithRetries({
      label: 'Sushi aggregator factory getConfiguredTakers',
      operation: () => factory.getConfiguredTakers(),
    })) as [number[], string[]];
    const lastSource = configured[0].length;
    if (lastSource < SUSHI_AGGREGATOR_SOURCE_ID) {
      params.errors.push(
        `Sushi aggregator preflight: factory ${factoryAddress} was compiled ` +
          `before source id ${SUSHI_AGGREGATOR_SOURCE_ID} (last supported ` +
          `source ${lastSource}); deploy a factory compiled with the appended ` +
          'SushiAggregator enum before enabling provider sushi_aggregator'
      );
    }
  } catch (error) {
    params.errors.push(getErrorMessage(error));
  }
}

export async function validateSushiAggregatorAllowlistPreflight(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  chainId: number;
  takerAddress: string | undefined;
  errors: string[];
}): Promise<void> {
  await validateSushiAggregatorFactorySupport({
    config: params.config,
    provider: params.provider,
    errors: params.errors,
  });
  const sushiConfig = params.config.dex?.sushiAggregator;
  if (!sushiConfig) {
    params.errors.push(
      'Sushi aggregator preflight: dex.sushiAggregator is not configured'
    );
    return;
  }
  if (!params.takerAddress) {
    params.errors.push(
      'Sushi aggregator preflight: takers.contracts.SushiAggregator is not configured'
    );
    return;
  }
  try {
    const policy = normalizeSushiAggregatorChainPolicy({
      config: sushiConfig,
      fieldName: 'dex.sushiAggregator',
      chainId: params.chainId,
    });
    const taker = new ethers.Contract(
      params.takerAddress,
      AGGREGATOR_TAKER_ALLOWLIST_ABI,
      params.provider
    );
    const actual = await readTakerAllowlistSnapshot({
      reader: createTakerAllowlistReader(taker),
      selectorTargets: policy.callTargets,
      labelPrefix: 'Sushi aggregator taker',
      read: readWithRetries,
    });
    params.errors.push(
      ...compareTakerAllowlistPolicy({
        expected: policy,
        actual,
        mode: 'exact',
      })
    );
  } catch (error) {
    params.errors.push(getErrorMessage(error));
  }
}
