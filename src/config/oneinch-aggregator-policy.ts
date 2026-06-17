import { OneInchDexConfig } from './schema';
import {
  NormalizedAggregatorChainPolicy,
  assertValidAggregatorAllowlistPolicyChains,
  normalizeAggregatorChainPolicy,
} from '../take/aggregator-calldata/allowlist';

// Production calldata-aggregator allowlist policy for the
// OneInchAggregatorKeeperTaker. The per-chain reviewed call-target /
// approval-spender / selector allowlists the deployed 1inch taker enforces are
// normalized fail-closed through the canonical normalizeAggregatorChainPolicy
// (shared verbatim with Sushi), so the deploy loop, preflight reconciliation,
// and config validation cannot drift. 1inch keeps no mode field (unlike LI.FI's
// canary/production); the presence of an allowlist policy is what marks
// dex.oneInch as production-deployable for external takes.

export type NormalizedOneInchChainPolicy = NormalizedAggregatorChainPolicy;

export function normalizeOneInchChainPolicy(params: {
  config: OneInchDexConfig;
  fieldName: string;
  chainId: number;
}): NormalizedOneInchChainPolicy {
  return normalizeAggregatorChainPolicy(params);
}

/**
 * True when dex.oneInch carries any production aggregator allowlist policy field
 * — the gate the deploy loop and preflight use to decide the 1inch
 * OneInchAggregatorKeeperTaker is provisioned (vs. quote/discovery-only 1inch).
 */
export function hasOneInchAggregatorAllowlistPolicy(
  config: OneInchDexConfig | undefined
): boolean {
  return Boolean(
    config &&
      (config.callTargetAllowlist ||
        config.approvalSpenderAllowlist ||
        config.selectorAllowlist)
  );
}

/**
 * Fail-closed validation for the 1inch production aggregator allowlist policy.
 * When `requireProduction` (live, non-dry-run external takes), a complete policy
 * is mandatory: a production 1inch source without target/spender/selector
 * allowlists is rejected before it can be deployed/registered. When a policy is
 * present, every configured chain (and `chainId` when given) is normalized so an
 * incomplete or non-covering policy fails closed at config time.
 */
export function assertValidOneInchAggregatorDexConfig(params: {
  config: OneInchDexConfig | undefined;
  fieldName: string;
  chainId?: number;
  requireProduction: boolean;
}): void {
  const { config, fieldName, chainId, requireProduction } = params;
  const hasPolicy = hasOneInchAggregatorAllowlistPolicy(config);
  if (requireProduction && !hasPolicy) {
    throw new Error(
      `${fieldName} requires callTargetAllowlist/approvalSpenderAllowlist/selectorAllowlist policy for live 1inch external takes`
    );
  }
  if (!config || !hasPolicy) {
    return;
  }
  assertValidAggregatorAllowlistPolicyChains({ config, fieldName, chainId });
}
