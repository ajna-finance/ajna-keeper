import { ethers, providers } from 'ethers';
import { KeeperConfig, LiquiditySource } from '../../config';
import { normalizeSushiAggregatorChainPolicy } from '../../config/sushi-aggregator-policy';
import { reconcileTakerAllowlistSnapshot } from '../../take/aggregator-calldata/allowlist';
import { getErrorMessage } from '../../utils';

/**
 * Sushi aggregator route-deployment preflight (Packet 3B). Fail-closed
 * before live use:
 * - the configured TakerRouter must be compiled with the appended
 *   SUSHI_AGGREGATOR source id (old factories are rejected: their
 *   getConfiguredTakers() enumeration stops at the old last source)
 * - the deployed taker's on-chain call-target / approval-spender / selector
 *   allowlists must exactly match the normalized dex.sushiAggregator policy
 *   for the chain
 */
const FACTORY_CONFIGURED_TAKERS_ABI = [
  'function getConfiguredTakers() view returns (uint8[] memory sources, address[] memory takers)',
];
const SUSHI_AGGREGATOR_SOURCE_ID = LiquiditySource.SUSHI_AGGREGATOR;
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

export async function validateSushiAggregatorTakerRouterSupport(params: {
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
      label: 'Sushi aggregator TakerRouter getConfiguredTakers',
      operation: () => factory.getConfiguredTakers(),
    })) as [number[], string[]];
    const configuredSources = configured[0].map(Number);
    if (!configuredSources.includes(SUSHI_AGGREGATOR_SOURCE_ID)) {
      params.errors.push(
        `Sushi aggregator preflight: TakerRouter ${factoryAddress} was compiled ` +
          `without source id ${SUSHI_AGGREGATOR_SOURCE_ID}; deploy a TakerRouter compiled with the appended ` +
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
  await validateSushiAggregatorTakerRouterSupport({
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
    // Mirror LI.FI/1inch: every allowlisted call target + approval spender must
    // have on-chain code, else the taker reverts CallTargetHasNoCode at take
    // time. Caught here at startup rather than only on the first live take.
    for (const address of Array.from(
      new Set([...policy.callTargets, ...policy.approvalSpenders])
    )) {
      const code = await readWithRetries({
        label: `Sushi aggregator code at ${address}`,
        operation: () => params.provider.getCode(address),
      });
      if (!code || code === '0x') {
        params.errors.push(
          `Sushi aggregator preflight: allowlisted address ${address} has no contract code on chain ${params.chainId}`
        );
      }
    }
    // Sushi reads selectors only for its configured call targets (no extra
    // selectorAllowlist keys) and retries on any read error.
    await reconcileTakerAllowlistSnapshot({
      provider: params.provider,
      takerAddress: params.takerAddress,
      policy,
      selectorTargets: policy.callTargets,
      labelPrefix: 'Sushi aggregator taker',
      read: readWithRetries,
      errors: params.errors,
    });
  } catch (error) {
    params.errors.push(getErrorMessage(error));
  }
}
