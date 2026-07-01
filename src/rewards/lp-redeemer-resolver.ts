import { AjnaSDK, Signer } from '@ajna-finance/sdk';
import {
  getManualPools,
  KeeperConfig,
  PoolConfig,
  resolveCollectLpRewardForPool,
} from '../config';
import {
  ensurePoolLoaded,
  normalizeAddress,
  PoolHydrationCooldowns,
  PoolMap,
} from '../discovery/targets';
import { RewardActionTracker } from './action-tracker';
import { LpRedeemer, LpRedeemerResolver } from './collect-lp';

export function buildPoolConfigByAddress(
  config: KeeperConfig
): Map<string, PoolConfig> {
  const poolConfigByAddress = new Map<string, PoolConfig>();
  for (const pool of getManualPools(config)) {
    poolConfigByAddress.set(normalizeAddress(pool.address), pool);
  }
  return poolConfigByAddress;
}

export function createLpRedeemerResolver(params: {
  ajna: AjnaSDK;
  poolMap: PoolMap;
  config: KeeperConfig;
  signer: Signer;
  exchangeTracker: RewardActionTracker;
  hydrationCooldowns: PoolHydrationCooldowns;
  poolConfigByAddress?: Map<string, PoolConfig>;
  redeemers?: Map<string, LpRedeemer>;
}): LpRedeemerResolver {
  const poolConfigByAddress =
    params.poolConfigByAddress ?? buildPoolConfigByAddress(params.config);
  const redeemers = params.redeemers ?? new Map<string, LpRedeemer>();

  return async (poolAddress: string): Promise<LpRedeemer | undefined> => {
    const normalized = normalizeAddress(poolAddress);
    const cached = redeemers.get(normalized);
    if (cached) {
      return cached;
    }

    const pool = await ensurePoolLoaded({
      ajna: params.ajna,
      poolMap: params.poolMap,
      poolAddress: normalized,
      config: params.config,
      hydrationCooldowns: params.hydrationCooldowns,
    });
    if (!pool) {
      return undefined;
    }

    const matchingConfig = poolConfigByAddress.get(normalized);
    const settings = resolveCollectLpRewardForPool(
      params.config.rewards?.defaultLpReward,
      matchingConfig?.collectLpReward,
      normalized
    );
    if (!settings) {
      return undefined;
    }

    const redeemer = new LpRedeemer(
      pool,
      params.signer,
      settings,
      params.config,
      params.exchangeTracker
    );
    redeemers.set(normalized, redeemer);
    return redeemer;
  };
}
