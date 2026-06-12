import { KeeperConfig, SushiAggregatorDexConfig } from './schema';
import {
  normalizeTakerAddressAllowlist,
  normalizeTakerSelectorAllowlistRecord,
} from '../take/aggregator-calldata/allowlist';

/**
 * Sushi aggregator provider policy (Packet 3B). Focused provider module so
 * src/config/validation.ts only carries the validator-map entry. Entirely
 * separate from the removed dex.sushiswap direct-router surface and from the
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

export interface NormalizedSushiAggregatorChainPolicy {
  chainId: number;
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
}

export function normalizeSushiAggregatorChainPolicy(params: {
  config: SushiAggregatorDexConfig;
  fieldName: string;
  chainId: number;
}): NormalizedSushiAggregatorChainPolicy {
  const { config, fieldName, chainId } = params;
  const callTargets = normalizeTakerAddressAllowlist(
    config.callTargetAllowlist?.[chainId],
    { label: `${fieldName}.callTargetAllowlist[${chainId}]`, requireNonEmpty: true }
  );
  const approvalSpenders = normalizeTakerAddressAllowlist(
    config.approvalSpenderAllowlist?.[chainId],
    {
      label: `${fieldName}.approvalSpenderAllowlist[${chainId}]`,
      requireNonEmpty: true,
    }
  );
  const selectorAllowlist = normalizeTakerSelectorAllowlistRecord(
    config.selectorAllowlist?.[chainId],
    { label: `${fieldName}.selectorAllowlist[${chainId}]`, requireNonEmpty: true }
  );
  return { chainId, callTargets, approvalSpenders, selectorAllowlist };
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
  if (chainId !== undefined) {
    normalizeSushiAggregatorChainPolicy({ config, fieldName, chainId });
  } else {
    const chains = Object.keys(config.callTargetAllowlist ?? {});
    if (chains.length === 0) {
      throw new Error(
        `${fieldName}.callTargetAllowlist must configure at least one chain`
      );
    }
    for (const chain of chains) {
      normalizeSushiAggregatorChainPolicy({
        config,
        fieldName,
        chainId: Number(chain),
      });
    }
  }
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
