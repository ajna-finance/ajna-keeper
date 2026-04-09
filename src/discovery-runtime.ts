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

export interface CreateDiscoveryRuntimeParams {
  ajna: AjnaSDK;
  poolMap: PoolMap;
  config: KeeperConfig;
  signer: Signer;
  hydrationCooldowns: PoolHydrationCooldowns;
  discoverySnapshotState?: DiscoverySnapshotState;
}

export interface DiscoveryRuntime {
  runTakeCycle(): Promise<void>;
  runSettlementCycle(): Promise<void>;
  getSettlementCheckIntervalSeconds(): number;
}

type DiscoveryRuntimeState = CreateDiscoveryRuntimeParams;
type EffectiveTargetIdentity =
  | Pick<EffectiveTakeTarget, 'source' | 'poolAddress' | 'name'>
  | Pick<EffectiveSettlementTarget, 'source' | 'poolAddress' | 'name'>;

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

async function refreshDiscoverySnapshot(
  state: DiscoveryRuntimeState
): Promise<ChainwideLiquidationAuction[]> {
  const liquidationAuctions = await getChainwideLiquidationAuctionsShared(state.config);
  if (state.discoverySnapshotState) {
    state.discoverySnapshotState.latestLiquidationAuctions = liquidationAuctions;
    state.discoverySnapshotState.fetchedAt = Date.now();
  }
  return liquidationAuctions;
}

async function getTakeCycleLiquidationAuctions(
  state: DiscoveryRuntimeState
): Promise<ChainwideLiquidationAuction[] | undefined> {
  return shouldRefreshDiscoverySnapshotOnTakeCycle(state.config)
    ? await refreshDiscoverySnapshot(state)
    : undefined;
}

async function getSettlementCycleLiquidationAuctions(
  state: DiscoveryRuntimeState
): Promise<ChainwideLiquidationAuction[] | undefined> {
  const refreshedLiquidationAuctions =
    shouldRefreshDiscoverySnapshotOnSettlementCycle(state.config)
      ? await refreshDiscoverySnapshot(state)
      : undefined;

  return (
    refreshedLiquidationAuctions ??
    state.discoverySnapshotState?.latestLiquidationAuctions ??
    undefined
  );
}

async function resolveTakeCycleTargets(
  state: DiscoveryRuntimeState,
  liquidationAuctions?: ChainwideLiquidationAuction[]
): Promise<EffectiveTakeTarget[]> {
  return [
    ...getManualTakeTargets(state.config),
    ...(await buildDiscoveredTakeTargets(state.config, liquidationAuctions)),
  ];
}

async function resolveSettlementCycleTargets(
  state: DiscoveryRuntimeState,
  liquidationAuctions?: ChainwideLiquidationAuction[]
): Promise<EffectiveSettlementTarget[]> {
  return [
    ...getManualSettlementTargets(state.config),
    ...(await buildDiscoveredSettlementTargets(state.config, liquidationAuctions)),
  ];
}

async function createTakeCycleRpcCache(
  state: DiscoveryRuntimeState,
  targets: EffectiveTakeTarget[]
): Promise<DiscoveryRpcCache | undefined> {
  return targets.some((target) => target.source === 'discovered') &&
    state.signer.provider
    ? {
        gasPrice: await state.signer.provider.getGasPrice(),
        factoryQuoteProviders: createFactoryQuoteProviderRuntimeCache(),
      }
    : undefined;
}

async function createSettlementCycleRpcCache(
  state: DiscoveryRuntimeState,
  targets: EffectiveSettlementTarget[]
): Promise<DiscoveryRpcCache | undefined> {
  return targets.some((target) => target.source === 'discovered') &&
    state.signer.provider
    ? {
        gasPrice: await state.signer.provider.getGasPrice(),
      }
    : undefined;
}

async function resolveEffectiveTargetPool(
  state: DiscoveryRuntimeState,
  target: EffectiveTargetIdentity
): Promise<FungiblePool | undefined> {
  const pool =
    target.source === 'manual'
      ? getPoolFromMap(state.poolMap, target.poolAddress)
      : await ensurePoolLoaded({
          ajna: state.ajna,
          poolMap: state.poolMap,
          poolAddress: target.poolAddress,
          config: state.config,
          hydrationCooldowns: state.hydrationCooldowns,
        });

  if (!pool) {
    logger.warn(`Skipping target ${target.name} because the pool is unavailable`);
    return undefined;
  }

  return pool;
}

async function executeEffectiveTakeTarget(params: {
  state: DiscoveryRuntimeState;
  pool: FungiblePool;
  target: EffectiveTakeTarget;
  rpcCache?: DiscoveryRpcCache;
}): Promise<void> {
  const { state, pool, target, rpcCache } = params;
  if (target.source === 'manual') {
    validateTakeSettings(target.poolConfig.take, state.config);
    await handleTakes({
      pool,
      poolConfig: target.poolConfig,
      signer: state.signer,
      config: state.config,
    });
    return;
  }

  await handleDiscoveredTakeTarget({
    pool,
    signer: state.signer,
    target,
    config: state.config,
    rpcCache,
  });
}

async function executeEffectiveSettlementTarget(params: {
  state: DiscoveryRuntimeState;
  pool: FungiblePool;
  target: EffectiveSettlementTarget;
  rpcCache?: DiscoveryRpcCache;
}): Promise<void> {
  const { state, pool, target, rpcCache } = params;
  if (target.source === 'manual') {
    await handleSettlements({
      pool,
      poolConfig: target.poolConfig,
      signer: state.signer,
      config: {
        dryRun: state.config.dryRun,
        subgraphUrl: state.config.subgraphUrl,
        delayBetweenActions: state.config.delayBetweenActions,
      },
    });
    return;
  }

  await handleDiscoveredSettlementTarget({
    pool,
    signer: state.signer,
    target,
    config: state.config,
    rpcCache,
  });
}

async function runTakeDiscoveryCycle(state: DiscoveryRuntimeState): Promise<void> {
  const liquidationAuctions = await getTakeCycleLiquidationAuctions(state);
  const targets = await resolveTakeCycleTargets(state, liquidationAuctions);
  const rpcCache = await createTakeCycleRpcCache(state, targets);

  for (const target of targets) {
    const pool = await resolveEffectiveTargetPool(state, target);
    if (!pool) {
      continue;
    }

    try {
      await executeEffectiveTakeTarget({
        state,
        pool,
        target,
        rpcCache,
      });
      await delay(state.config.delayBetweenActions);
    } catch (error) {
      logger.error(`Failed to handle take for pool: ${pool.name}.`, error);
    }
  }
}

async function runSettlementDiscoveryCycle(
  state: DiscoveryRuntimeState
): Promise<void> {
  const liquidationAuctions = await getSettlementCycleLiquidationAuctions(state);
  const targets = await resolveSettlementCycleTargets(state, liquidationAuctions);
  const rpcCache = await createSettlementCycleRpcCache(state, targets);

  logger.info(`Settlement loop started with ${targets.length} pools`);
  logger.info(`Settlement pools: ${targets.map((target) => target.name).join(', ')}`);

  for (const target of targets) {
    const pool = await resolveEffectiveTargetPool(state, target);
    if (!pool) {
      continue;
    }

    try {
      logger.debug(`Processing settlement check for pool: ${pool.name}`);
      await executeEffectiveSettlementTarget({
        state,
        pool,
        target,
        rpcCache,
      });
      logger.debug(`Settlement check completed for pool: ${pool.name}`);
      await delay(state.config.delayBetweenActions);
    } catch (error) {
      logger.error(`Failed to handle settlements for pool: ${pool.name}`, error);
    }
  }
}

function computeSettlementCheckIntervalSeconds(config: KeeperConfig): number {
  return Math.max(config.delayBetweenRuns * 5, 120);
}

export function createDiscoveryRuntime(
  params: CreateDiscoveryRuntimeParams
): DiscoveryRuntime {
  const state: DiscoveryRuntimeState = params;

  return {
    async runTakeCycle() {
      await runTakeDiscoveryCycle(state);
    },
    async runSettlementCycle() {
      await runSettlementDiscoveryCycle(state);
    },
    getSettlementCheckIntervalSeconds() {
      return computeSettlementCheckIntervalSeconds(state.config);
    },
  };
}
