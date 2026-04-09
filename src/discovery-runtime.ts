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
} from './discovery-targets';
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
} from './discovery-handlers';
import { logger } from './logging';
import { handleSettlements } from './settlement';
import { ChainwideLiquidationAuction } from './subgraph';
import { createFactoryQuoteProviderRuntimeCache } from './take-factory';
import { handleTakes } from './take';
import { delay } from './utils';

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

export interface DiscoveryCycleParams extends DiscoveryRuntimeContext {
  signer: Signer;
  discoverySnapshotState?: DiscoverySnapshotState;
}

function getPoolFromMap(poolMap: PoolMap, address: string) {
  return poolMap.get(address) ?? poolMap.get(address.toLowerCase());
}

function createDiscoveryRuntimeContext(
  params: DiscoveryCycleParams
): DiscoveryRuntimeContext {
  return {
    ajna: params.ajna,
    poolMap: params.poolMap,
    config: params.config,
    hydrationCooldowns: params.hydrationCooldowns,
  };
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

export async function runTakeDiscoveryCycle(
  params: DiscoveryCycleParams
): Promise<void> {
  const runtime = createDiscoveryRuntimeContext(params);
  const liquidationAuctions = await getTakeCycleLiquidationAuctions({
    config: params.config,
    discoverySnapshotState: params.discoverySnapshotState,
  });
  const targets = await resolveTakeCycleTargets({
    config: params.config,
    liquidationAuctions,
  });
  const rpcCache = await createTakeCycleRpcCache(targets, params.signer);

  for (const target of targets) {
    const pool = await resolveEffectiveTargetPool({ target, runtime });
    if (!pool) {
      continue;
    }

    try {
      await executeEffectiveTakeTarget({
        pool,
        signer: params.signer,
        target,
        config: params.config,
        rpcCache,
      });
      await delay(params.config.delayBetweenActions);
    } catch (error) {
      logger.error(`Failed to handle take for pool: ${pool.name}.`, error);
    }
  }
}

export async function runSettlementDiscoveryCycle(
  params: DiscoveryCycleParams
): Promise<void> {
  const runtime = createDiscoveryRuntimeContext(params);
  const liquidationAuctions = await getSettlementCycleLiquidationAuctions({
    config: params.config,
    discoverySnapshotState: params.discoverySnapshotState,
  });
  const targets = await resolveSettlementCycleTargets({
    config: params.config,
    liquidationAuctions,
  });
  const rpcCache = await createSettlementCycleRpcCache(targets, params.signer);

  logger.info(`Settlement loop started with ${targets.length} pools`);
  logger.info(`Settlement pools: ${targets.map((target) => target.name).join(', ')}`);

  for (const target of targets) {
    const pool = await resolveEffectiveTargetPool({ target, runtime });
    if (!pool) {
      continue;
    }

    try {
      logger.debug(`Processing settlement check for pool: ${pool.name}`);
      await executeEffectiveSettlementTarget({
        pool,
        signer: params.signer,
        target,
        config: params.config,
        rpcCache,
      });
      logger.debug(`Settlement check completed for pool: ${pool.name}`);
      await delay(params.config.delayBetweenActions);
    } catch (error) {
      logger.error(`Failed to handle settlements for pool: ${pool.name}`, error);
    }
  }
}

export function getSettlementCheckIntervalSeconds(config: KeeperConfig): number {
  return Math.max(config.delayBetweenRuns * 5, 120);
}
