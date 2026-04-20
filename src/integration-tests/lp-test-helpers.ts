import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { SubgraphReader } from '../read-transports';
import {
  CollectLpRewardSettings,
  KeeperConfig,
} from '../config';
import {
  LpIngester,
  LpRedeemer,
  RewardActionTracker,
} from '../rewards';

/**
 * Test-only facade that mirrors the pre-refactor `LpCollector` API for
 * integration tests against a single hardhat-fork pool. Wires an
 * `LpIngester` + `LpRedeemer` behind `ingestNewAwardsFromSubgraph` /
 * `collectLpRewards` / `lpMap` so existing tests keep their shape.
 *
 * Not intended for production — production uses `LpManager` with
 * on-demand redeemer materialization across all pools.
 */
export function makeSinglePoolLpCollector(
  pool: FungiblePool,
  signer: Signer,
  settings: CollectLpRewardSettings,
  config: Pick<KeeperConfig, 'dryRun' | 'lpRewardLookbackSeconds'>,
  exchangeTracker: RewardActionTracker,
  subgraph: SubgraphReader
) {
  const ingester = new LpIngester(signer, subgraph, config);
  const redeemer = new LpRedeemer(
    pool,
    signer,
    settings,
    config,
    exchangeTracker
  );
  const poolAddress = pool.poolAddress.toLowerCase();

  return {
    pool,
    ingester,
    redeemer,
    get lpMap() {
      return redeemer.lpMap;
    },
    async ingestNewAwardsFromSubgraph() {
      const byPool = await ingester.ingest();
      for (const reward of byPool.get(poolAddress) ?? []) {
        redeemer.creditReward(reward);
      }
    },
    async collectLpRewards() {
      const byPool = await ingester.ingest();
      for (const reward of byPool.get(poolAddress) ?? []) {
        redeemer.creditReward(reward);
      }
      await redeemer.sweep();
    },
  };
}
