import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { SubgraphReader } from '../read-transports';
import {
  CollectLpRewardSettings,
  KeeperConfig,
} from '../config';
import { LpIngester, LpRedeemer } from './collect-lp';
import { RewardActionTracker } from './action-tracker';
import { normalizeAddress } from '../discovery/targets';

/**
 * Test-only facade that mirrors the pre-refactor `LpCollector` API for
 * single-pool tests (integration against a hardhat-fork pool, or unit
 * tests with a fake pool). Wires an `LpIngester` + `LpRedeemer` behind
 * `ingestNewAwardsFromSubgraph` / `collectLpRewards` / `lpMap` so existing
 * tests keep their shape.
 *
 * Pick ONE of `ingestNewAwardsFromSubgraph()` or `collectLpRewards()` per
 * test cycle — calling both in sequence runs the subgraph query twice and
 * advances the cursor past the first call's events, which can falsify
 * assertions that care about the final cursor state.
 *
 * Production does NOT use this — production uses `LpManager` with
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
  const poolAddress = normalizeAddress(pool.poolAddress);

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
