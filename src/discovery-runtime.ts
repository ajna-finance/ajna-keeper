import { AjnaSDK, FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  buildDiscoveredSettlementTargets,
  buildDiscoveredTakeTargets,
  EffectiveSettlementTarget,
  EffectiveTakeTarget,
  ensurePoolLoaded,
  getChainwideLiquidationAuctionsShared,
  getManualSettlementTargets,
  getManualTakeTargets,
  PoolHydrationCooldowns,
  PoolMap,
} from './auto-discovery';
import {
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
  KeeperConfig,
  validateTakeSettings,
} from './config-types';
import {
  DiscoveryRpcCache,
  handleDiscoveredSettlementTarget,
  handleDiscoveredTakeTarget,
} from './auto-discovery-handlers';
import { logger } from './logging';
import { handleSettlements } from './settlement';
import { ChainwideLiquidationAuction } from './subgraph';
import { createFactoryQuoteProviderRuntimeCache } from './take-factory';
import { handleTakes } from './take';

export interface DiscoverySnapshotState {
  latestLiquidationAuctions?: ChainwideLiquidationAuction[];
  fetchedAt?: number;
}

export interface DiscoveryRuntimeContext {
  ajna: AjnaSDK;
  poolMap: PoolMap;
  config: KeeperConfig;
  hydrationCooldowns: PoolHydrationCooldowns;
}

function getPoolFromMap(poolMap: PoolMap, address: string) {
  return poolMap.get(address) ?? poolMap.get(address.toLowerCase());
}

function shouldRefreshDiscoverySnapshotOnTakeCycle(config: KeeperConfig): boolean {
  return !!config.autoDiscover?.enabled && !!getAutoDiscoverTakePolicy(config.autoDiscover);
}

function shouldRefreshDiscoverySnapshotOnSettlementCycle(
  config: KeeperConfig
): boolean {
  return (
    !!config.autoDiscover?.enabled &&
    !getAutoDiscoverTakePolicy(config.autoDiscover) &&
    !!getAutoDiscoverSettlementPolicy(config.autoDiscover)
  );
}

export async function refreshDiscoverySnapshot(
  config: KeeperConfig,
  discoverySnapshotState?: DiscoverySnapshotState
): Promise<ChainwideLiquidationAuction[]> {
  const liquidationAuctions = await getChainwideLiquidationAuctionsShared(config);
  if (discoverySnapshotState) {
    discoverySnapshotState.latestLiquidationAuctions = liquidationAuctions;
    discoverySnapshotState.fetchedAt = Date.now();
  }
  return liquidationAuctions;
}

export async function getTakeCycleLiquidationAuctions(params: {
  config: KeeperConfig;
  discoverySnapshotState?: DiscoverySnapshotState;
}): Promise<ChainwideLiquidationAuction[] | undefined> {
  return shouldRefreshDiscoverySnapshotOnTakeCycle(params.config)
    ? await refreshDiscoverySnapshot(params.config, params.discoverySnapshotState)
    : undefined;
}

export async function getSettlementCycleLiquidationAuctions(params: {
  config: KeeperConfig;
  discoverySnapshotState?: DiscoverySnapshotState;
}): Promise<ChainwideLiquidationAuction[] | undefined> {
  const refreshedLiquidationAuctions =
    shouldRefreshDiscoverySnapshotOnSettlementCycle(params.config)
      ? await refreshDiscoverySnapshot(params.config, params.discoverySnapshotState)
      : undefined;

  return (
    refreshedLiquidationAuctions ??
    (params.discoverySnapshotState
      ? params.discoverySnapshotState.latestLiquidationAuctions ?? []
      : undefined)
  );
}

export async function resolveTakeCycleTargets(params: {
  config: KeeperConfig;
  liquidationAuctions?: ChainwideLiquidationAuction[];
}): Promise<EffectiveTakeTarget[]> {
  return [
    ...getManualTakeTargets(params.config),
    ...(await buildDiscoveredTakeTargets(params.config, params.liquidationAuctions)),
  ];
}

export async function resolveSettlementCycleTargets(params: {
  config: KeeperConfig;
  liquidationAuctions?: ChainwideLiquidationAuction[];
}): Promise<EffectiveSettlementTarget[]> {
  return [
    ...getManualSettlementTargets(params.config),
    ...(await buildDiscoveredSettlementTargets(
      params.config,
      params.liquidationAuctions
    )),
  ];
}

export async function createTakeCycleRpcCache(
  targets: EffectiveTakeTarget[],
  signer: Signer
): Promise<DiscoveryRpcCache | undefined> {
  return targets.some((target) => target.source === 'discovered') && signer.provider
    ? {
        gasPrice: await signer.provider.getGasPrice(),
        factoryQuoteProviders: createFactoryQuoteProviderRuntimeCache(),
      }
    : undefined;
}

export async function createSettlementCycleRpcCache(
  targets: EffectiveSettlementTarget[],
  signer: Signer
): Promise<DiscoveryRpcCache | undefined> {
  return targets.some((target) => target.source === 'discovered') && signer.provider
    ? {
        gasPrice: await signer.provider.getGasPrice(),
      }
    : undefined;
}

export async function resolveEffectiveTargetPool(params: {
  target: Pick<EffectiveTakeTarget, 'source' | 'poolAddress' | 'name'>;
  runtime: DiscoveryRuntimeContext;
}): Promise<FungiblePool | undefined> {
  const { target, runtime } = params;
  const pool =
    target.source === 'manual'
      ? getPoolFromMap(runtime.poolMap, target.poolAddress)
      : await ensurePoolLoaded({
          ajna: runtime.ajna,
          poolMap: runtime.poolMap,
          poolAddress: target.poolAddress,
          config: runtime.config,
          hydrationCooldowns: runtime.hydrationCooldowns,
        });

  if (!pool) {
    logger.warn(`Skipping target ${target.name} because the pool is unavailable`);
    return undefined;
  }

  return pool;
}

export async function executeEffectiveTakeTarget(params: {
  pool: FungiblePool;
  signer: Signer;
  target: EffectiveTakeTarget;
  config: KeeperConfig;
  rpcCache?: DiscoveryRpcCache;
}): Promise<void> {
  if (params.target.source === 'manual') {
    validateTakeSettings(params.target.poolConfig.take, params.config);
    await handleTakes({
      pool: params.pool,
      poolConfig: params.target.poolConfig,
      signer: params.signer,
      config: params.config,
    });
    return;
  }

  await handleDiscoveredTakeTarget({
    pool: params.pool,
    signer: params.signer,
    target: params.target,
    config: params.config,
    rpcCache: params.rpcCache,
  });
}

export async function executeEffectiveSettlementTarget(params: {
  pool: FungiblePool;
  signer: Signer;
  target: EffectiveSettlementTarget;
  config: KeeperConfig;
  rpcCache?: DiscoveryRpcCache;
}): Promise<void> {
  if (params.target.source === 'manual') {
    await handleSettlements({
      pool: params.pool,
      poolConfig: params.target.poolConfig,
      signer: params.signer,
      config: {
        dryRun: params.config.dryRun,
        subgraphUrl: params.config.subgraphUrl,
        delayBetweenActions: params.config.delayBetweenActions,
      },
    });
    return;
  }

  await handleDiscoveredSettlementTarget({
    pool: params.pool,
    signer: params.signer,
    target: params.target,
    config: params.config,
    rpcCache: params.rpcCache,
  });
}

export function getSettlementCheckIntervalSeconds(config: KeeperConfig): number {
  return Math.max(config.delayBetweenRuns * 5, 120);
}
