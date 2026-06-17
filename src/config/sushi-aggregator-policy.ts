import { KeeperConfig, SushiAggregatorDexConfig } from './schema';
import {
  NormalizedAggregatorChainPolicy,
  assertValidAggregatorAllowlistPolicyChains,
  normalizeAggregatorChainPolicy,
} from '../take/aggregator-calldata/allowlist';
import { normalizeAggregatorApiBaseUrl } from '../dex/lifi/api-policy';

/**
 * Sushi aggregator provider policy (Packet 3B). Focused provider module so
 * src/config/validation.ts only carries the validator-map entry. Entirely
 * separate from the removed direct-router config surface and from the
 * LI.FI policy module; allowlists are isolated per provider deployment.
 *
 * Initial production scope is bounded by the Packet 3A proceed artifact
 * (chains 1, 8453, 42161, 10, 137, 43114; the single stability-proven
 * RouteProcessor target/selector/spender tuple). Live code enforces typed
 * config and allowlists only — the planning artifact is never read at
 * runtime; enabling a new chain or route requires a new reviewed evidence
 * artifact before the config change.
 */
export const DEFAULT_SUSHI_AGGREGATOR_API_BASE_URL =
  'https://api.sushi.com/swap/v7';
export const DEFAULT_SUSHI_AGGREGATOR_QUOTE_TIMEOUT_MS = 2_000;
export const DEFAULT_SUSHI_AGGREGATOR_MAX_QUOTE_AGE_MS = 30_000;
export const DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE = 0.005;
export const DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT = 0.05;

export const SUSHI_AGGREGATOR_POLICY_BOUNDS = {
  maxQuoteTimeoutMs: 10_000,
  maxQuoteAgeMsCap: 120_000,
  maxSlippage: 0.05,
  maxPriceImpactCap: 0.15,
} as const;

export type NormalizedSushiAggregatorChainPolicy =
  NormalizedAggregatorChainPolicy;

export function normalizeSushiAggregatorChainPolicy(params: {
  config: SushiAggregatorDexConfig;
  fieldName: string;
  chainId: number;
}): NormalizedSushiAggregatorChainPolicy {
  return normalizeAggregatorChainPolicy(params);
}

export function assertValidSushiAggregatorDexConfig(params: {
  config: SushiAggregatorDexConfig | undefined;
  fieldName: string;
  chainId?: number;
}): void {
  const { config, fieldName, chainId } = params;
  if (!config) {
    throw new Error(
      `${fieldName} required when the Sushi aggregator provider is enabled`
    );
  }
  if (config.mode !== 'production') {
    throw new Error(`${fieldName}.mode must be 'production'`);
  }
  if (config.apiBaseUrl !== undefined) {
    // Sushi is production-only; require the same fail-closed URL shape LI.FI
    // already enforces (http(s) only, no credentials/query/fragment, HTTPS).
    normalizeAggregatorApiBaseUrl(config.apiBaseUrl, `${fieldName}.apiBaseUrl`, {
      requireHttps: true,
    });
  }
  if (
    config.quoteTimeoutMs !== undefined &&
    (config.quoteTimeoutMs <= 0 ||
      config.quoteTimeoutMs > SUSHI_AGGREGATOR_POLICY_BOUNDS.maxQuoteTimeoutMs)
  ) {
    throw new Error(
      `${fieldName}.quoteTimeoutMs must be 1..${SUSHI_AGGREGATOR_POLICY_BOUNDS.maxQuoteTimeoutMs}`
    );
  }
  if (
    config.maxQuoteAgeMs !== undefined &&
    (config.maxQuoteAgeMs <= 0 ||
      config.maxQuoteAgeMs > SUSHI_AGGREGATOR_POLICY_BOUNDS.maxQuoteAgeMsCap)
  ) {
    throw new Error(
      `${fieldName}.maxQuoteAgeMs must be 1..${SUSHI_AGGREGATOR_POLICY_BOUNDS.maxQuoteAgeMsCap}`
    );
  }
  if (
    config.defaultSlippage !== undefined &&
    (config.defaultSlippage <= 0 ||
      config.defaultSlippage > SUSHI_AGGREGATOR_POLICY_BOUNDS.maxSlippage)
  ) {
    throw new Error(
      `${fieldName}.defaultSlippage must be a fraction in (0, ${SUSHI_AGGREGATOR_POLICY_BOUNDS.maxSlippage}]`
    );
  }
  if (
    config.maxPriceImpact !== undefined &&
    (config.maxPriceImpact <= 0 ||
      config.maxPriceImpact > SUSHI_AGGREGATOR_POLICY_BOUNDS.maxPriceImpactCap)
  ) {
    throw new Error(
      `${fieldName}.maxPriceImpact must be a fraction in (0, ${SUSHI_AGGREGATOR_POLICY_BOUNDS.maxPriceImpactCap}]`
    );
  }
  // Sushi requires its callTargetAllowlist (the policy is mandatory, not
  // mode-gated like 1inch), then every chain present in ANY of the three
  // allowlist records (plus the active chainId) is validated fail-closed via
  // the shared helper — a spender-only or selector-only chain cannot slip past.
  if (Object.keys(config.callTargetAllowlist ?? {}).length === 0) {
    throw new Error(
      `${fieldName}.callTargetAllowlist must configure at least one chain`
    );
  }
  assertValidAggregatorAllowlistPolicyChains({ config, fieldName, chainId });
}

/**
 * Validator-map entry for LiquiditySource.SUSHI_AGGREGATOR take settings
 * (consumed by src/config/validation.ts; the taker-contract requirement is
 * delegated back to the shared helper there).
 */
export function validateSushiAggregatorDexRequirements(params: {
  keeperConfig: KeeperConfig;
  chainId?: number;
}): void {
  assertValidSushiAggregatorDexConfig({
    config: params.keeperConfig.dex?.sushiAggregator,
    fieldName: 'KeeperConfig.dex.sushiAggregator',
    chainId: params.chainId,
  });
}
