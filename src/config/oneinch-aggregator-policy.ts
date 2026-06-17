import { OneInchDexConfig } from './schema';
import {
  normalizeTakerAddressAllowlist,
  normalizeTakerSelectorAllowlistRecord,
} from '../take/aggregator-calldata/allowlist';

// Production calldata-aggregator allowlist policy for the
// OneInchAggregatorKeeperTaker. Mirrors src/config/sushi-aggregator-policy.ts:
// the per-chain reviewed call-target / approval-spender / selector allowlists
// the deployed 1inch taker enforces on-chain, normalized fail-closed so the
// deploy loop and preflight reconciliation share one definition. 1inch keeps no
// mode field (unlike LI.FI's canary/production); the presence of an allowlist
// policy is what marks dex.oneInch as production-deployable for external takes.

export interface NormalizedOneInchChainPolicy {
  chainId: number;
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
}

export function normalizeOneInchChainPolicy(params: {
  config: OneInchDexConfig;
  fieldName: string;
  chainId: number;
}): NormalizedOneInchChainPolicy {
  const { config, fieldName, chainId } = params;
  const callTargets = normalizeTakerAddressAllowlist(
    config.callTargetAllowlist?.[chainId],
    {
      label: `${fieldName}.callTargetAllowlist[${chainId}]`,
      requireNonEmpty: true,
    }
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
    {
      label: `${fieldName}.selectorAllowlist[${chainId}]`,
      requireNonEmpty: true,
      // Fail closed like LI.FI/Sushi: every selector target must be an
      // allowlisted call target, and every call target must have selector
      // coverage. Otherwise deploy/preflight could register a 1inch taker whose
      // selectors don't cover its call targets, so a take passes config
      // validation then reverts on-chain.
      callTargetAllowlist: callTargets,
      requireCallTargetCoverage: true,
    }
  );
  return { chainId, callTargets, approvalSpenders, selectorAllowlist };
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
  const chainIds = new Set<number>();
  for (const list of [
    config.callTargetAllowlist,
    config.approvalSpenderAllowlist,
    config.selectorAllowlist,
  ]) {
    for (const key of Object.keys(list ?? {})) {
      chainIds.add(Number(key));
    }
  }
  if (chainId !== undefined) {
    chainIds.add(chainId);
  }
  for (const id of Array.from(chainIds)) {
    normalizeOneInchChainPolicy({ config, fieldName, chainId: id });
  }
}
