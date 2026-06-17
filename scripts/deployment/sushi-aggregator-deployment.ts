import { KeeperConfig } from '../../src/config';
import {
  normalizeSushiAggregatorChainPolicy,
  type NormalizedSushiAggregatorChainPolicy,
} from '../../src/config/sushi-aggregator-policy';

// The per-provider Sushi deploy/configure/register orchestration that once lived
// here is now the descriptor-driven loop in scripts/deployment/deploy-registry.ts
// (deployTaker / reconcileTakerAllowlists / registerTakerInRouter). This module
// retains only the pure Sushi config/policy helpers the deploy registry and unit
// tests still consume.

export function hasSushiAggregatorConfig(config: KeeperConfig): boolean {
  return Boolean(config.dex?.sushiAggregator);
}

export function getSushiAggregatorProductionAllowlists(
  config: KeeperConfig,
  chainId: number
): NormalizedSushiAggregatorChainPolicy {
  const sushiAggregator = config.dex?.sushiAggregator;
  if (!sushiAggregator) {
    throw new Error(
      'dex.sushiAggregator config is required for Sushi aggregator deployment'
    );
  }
  return normalizeSushiAggregatorChainPolicy({
    config: sushiAggregator,
    fieldName: 'dex.sushiAggregator',
    chainId,
  });
}
