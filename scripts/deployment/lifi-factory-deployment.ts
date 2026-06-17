import {
  KeeperConfig,
  type NormalizedLifiAllowlistPolicy,
} from '../../src/config';
import { normalizeLifiProductionChainPolicy } from '../../src/config/lifi-policy';
import {
  buildTakerAllowlistReconciliationPlan,
  type TakerAllowlistReconciliationPlan,
  normalizeTakerAllowlistSnapshot,
} from '../../src/take/aggregator-calldata/allowlist';

// The per-provider deploy/register/configure orchestration that once lived here
// is now the descriptor-driven loop in scripts/deployment/deploy-registry.ts
// (deployTaker / reconcileTakerAllowlists / registerTakerInRouter). This module
// retains only the pure LI.FI config/policy helpers the deploy CLI and unit
// tests still consume.

export type LifiProductionAllowlists = NormalizedLifiAllowlistPolicy;
export type { TakerAllowlistReconciliationPlan };

export function getLifiProductionAllowlists(
  config: KeeperConfig,
  chainId: number
): LifiProductionAllowlists {
  const lifi = config.dex?.lifi;
  if (!lifi) {
    throw new Error('LI.FI production config is required for deployment');
  }
  const policy = normalizeLifiProductionChainPolicy({
    config: lifi,
    fieldName: 'LI.FI',
    chainId,
  });
  return {
    callTargets: policy.callTargets,
    approvalSpenders: policy.approvalSpenders,
    selectorAllowlist: policy.selectorAllowlist,
  };
}

export function hasProductionLifiConfig(config: KeeperConfig): boolean {
  return config.dex?.lifi?.mode === 'production';
}

export function getLifiProductionDeploymentGateMessages(
  configPath: string
): string[] {
  return [
    `Run the LI.FI route-shape gate: AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true npm run lifi-route-canary -- --config ${configPath}`,
    `Run the LI.FI callback-path fork gate: AJNA_AGENT_LIFI_FORK_CANARY_CONFIG=${configPath} npm run lifi-fork-execution-canary`,
    'For non-Base LI.FI production support, run an equivalent reviewed chain-specific fork canary before live use',
    `After both LI.FI gates pass, test startup with: yarn start --config ${configPath}`,
  ];
}

export function buildLifiAllowlistReconciliationPlan(params: {
  desired: LifiProductionAllowlists;
  currentCallTargets: readonly string[];
  currentApprovalSpenders: readonly string[];
  currentSelectorsByTarget: Record<string, readonly string[]>;
}): TakerAllowlistReconciliationPlan {
  return buildTakerAllowlistReconciliationPlan({
    desired: params.desired,
    current: normalizeTakerAllowlistSnapshot({
      callTargets: params.currentCallTargets,
      approvalSpenders: params.currentApprovalSpenders,
      selectorAllowlist: params.currentSelectorsByTarget,
      selectorTargets: [
        ...params.desired.callTargets,
        ...Object.keys(params.desired.selectorAllowlist),
      ],
      labelPrefix: 'on-chain LI.FI',
    }),
  });
}

export function validateDetectedChainLifiProductionConfig(
  config: KeeperConfig,
  chainInfo: { chainId: number; name: string }
): void {
  if (!hasProductionLifiConfig(config)) {
    return;
  }

  const { callTargets, approvalSpenders, selectorAllowlist } =
    getLifiProductionAllowlists(config, chainInfo.chainId);
  console.log(
    `✅ LI.FI production allowlists validated for ${chainInfo.name} (${chainInfo.chainId}): targets=${callTargets.length}, spenders=${approvalSpenders.length}, selectorTargets=${Object.keys(selectorAllowlist).length}`
  );
}
