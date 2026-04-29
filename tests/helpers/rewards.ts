import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { CollectLpRewardSettings, KeeperConfig } from '../../src/config';
import { normalizeAddress } from '../../src/discovery/targets';
import { SubgraphReader } from '../../src/read-transports';
import { RewardActionTracker } from '../../src/rewards/action-tracker';
import { LpIngester, LpRedeemer } from '../../src/rewards/collect-lp';

type LpCollectorTestConfig = Partial<Pick<KeeperConfig, 'runtime' | 'rewards'>>;

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
  config: LpCollectorTestConfig,
  exchangeTracker: RewardActionTracker,
  subgraph: SubgraphReader
) {
  const ingesterConfig: Pick<KeeperConfig, 'rewards'> = {
    rewards: config.rewards,
  };
  const redeemerConfig: Pick<KeeperConfig, 'runtime'> = {
    runtime: {
      logLevel: 'debug',
      delayBetweenRuns: 0,
      dryRun: false,
      ...config.runtime,
    },
  };
  const ingester = new LpIngester(signer, subgraph, ingesterConfig);
  const redeemer = new LpRedeemer(
    pool,
    signer,
    settings,
    redeemerConfig,
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
