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
} from './targets';
import {
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
  KeeperConfig,
  validateTakeSettings,
} from '../config';
import {
  DiscoveryRpcCache,
  handleDiscoveredSettlementTarget,
  handleDiscoveredTakeTarget,
} from './handlers';
import { logger } from '../logging';
import {
  createDiscoveryReadTransports,
  DiscoveryReadTransports,
} from '../read-transports';
import { handleSettlements } from '../settlement';
import { ChainwideLiquidationAuction } from '../subgraph';
import { createFactoryQuoteProviderRuntimeCache } from '../take/factory';
import { handleTakes } from '../take';
import { TakeWriteTransport } from '../take/write-transport';
import { delay } from '../utils';

export interface DiscoverySnapshotState {
  latestLiquidationAuctions?: ChainwideLiquidationAuction[];
  fetchedAt?: number;
}

export interface CreateDiscoveryRuntimeParams {
  ajna: AjnaSDK;
  poolMap: PoolMap;
  config: KeeperConfig;
  signer: Signer;
  takeWriteTransport?: TakeWriteTransport;
  hydrationCooldowns: PoolHydrationCooldowns;
  discoverySnapshotState?: DiscoverySnapshotState;
}

export interface DiscoveryRuntime {
  runTakeCycle(): Promise<void>;
  runSettlementCycle(): Promise<void>;
  getSettlementCheckIntervalSeconds(): number;
}

type DiscoveryRuntimeState = CreateDiscoveryRuntimeParams;
type BoundDiscoveryRuntimeState = DiscoveryRuntimeState & {
  readTransports: DiscoveryReadTransports;
  lastDiscoveredSettlementCycleStartedAtMs?: number;
};
type EffectiveTargetIdentity =
  | Pick<EffectiveTakeTarget, 'source' | 'poolAddress' | 'name'>
  | Pick<EffectiveSettlementTarget, 'source' | 'poolAddress' | 'name'>;

interface DiscoveryCycleSnapshotInfo {
  liquidationAuctions?: ChainwideLiquidationAuction[];
  snapshotRefreshed: boolean;
  snapshotAgeMs?: number;
}

interface DiscoveryCycleStats {
  targets: number;
  manualTargets: number;
  discoveredTargets: number;
  poolsUnavailable: number;
  targetSuccesses: number;
  targetFailures: number;
}

interface DiscoveryRpcCacheState {
  initialized: boolean;
  cache?: DiscoveryRpcCache;
}

const DISCOVERY_GAS_PRICE_TTL_MS = 30_000;

function getPoolFromMap(poolMap: PoolMap, address: string) {
  return poolMap.get(address) ?? poolMap.get(address.toLowerCase());
}

function shouldRefreshDiscoverySnapshotOnTakeCycle(config: KeeperConfig): boolean {
  return !!config.autoDiscover?.enabled && !!getAutoDiscoverTakePolicy(config.autoDiscover);
}

function shouldRefreshDiscoverySnapshotOnSettlementCycle(
  config: KeeperConfig,
  discoverySnapshotState?: DiscoverySnapshotState
): boolean {
  if (
    !config.autoDiscover?.enabled ||
    !getAutoDiscoverSettlementPolicy(config.autoDiscover)
  ) {
    return false;
  }

  if (!getAutoDiscoverTakePolicy(config.autoDiscover)) {
    return true;
  }

  if (discoverySnapshotState?.fetchedAt === undefined) {
    return true;
  }

  const maxSnapshotAgeMs =
    computeDiscoveredSettlementCheckIntervalSeconds(config) * 1000;
  return Date.now() - discoverySnapshotState.fetchedAt >= maxSnapshotAgeMs;
}

async function refreshDiscoverySnapshot(
  state: BoundDiscoveryRuntimeState
): Promise<ChainwideLiquidationAuction[]> {
  const liquidationAuctions = await getChainwideLiquidationAuctionsShared(
    state.config,
    state.readTransports.subgraph
  );
  if (state.discoverySnapshotState) {
    state.discoverySnapshotState.latestLiquidationAuctions = liquidationAuctions;
    state.discoverySnapshotState.fetchedAt = Date.now();
  }
  return liquidationAuctions;
}

async function getTakeCycleLiquidationAuctions(
  state: BoundDiscoveryRuntimeState
): Promise<DiscoveryCycleSnapshotInfo> {
  const liquidationAuctions = shouldRefreshDiscoverySnapshotOnTakeCycle(state.config)
    ? await refreshDiscoverySnapshot(state)
    : undefined;
  const snapshotAgeMs =
    state.discoverySnapshotState?.fetchedAt !== undefined
      ? Math.max(0, Date.now() - state.discoverySnapshotState.fetchedAt)
      : undefined;
  return {
    liquidationAuctions,
    snapshotRefreshed: liquidationAuctions !== undefined,
    snapshotAgeMs,
  };
}

async function getSettlementCycleLiquidationAuctions(
  state: BoundDiscoveryRuntimeState
): Promise<DiscoveryCycleSnapshotInfo> {
  const refreshedLiquidationAuctions =
    shouldRefreshDiscoverySnapshotOnSettlementCycle(
      state.config,
      state.discoverySnapshotState
    )
      ? await refreshDiscoverySnapshot(state)
      : undefined;

  const liquidationAuctions =
    refreshedLiquidationAuctions ??
    state.discoverySnapshotState?.latestLiquidationAuctions ??
    undefined;
  const snapshotAgeMs =
    state.discoverySnapshotState?.fetchedAt !== undefined
      ? Math.max(0, Date.now() - state.discoverySnapshotState.fetchedAt)
      : undefined;
  return {
    liquidationAuctions,
    snapshotRefreshed: refreshedLiquidationAuctions !== undefined,
    snapshotAgeMs,
  };
}

function createEmptyDiscoveryRpcCache(): DiscoveryRpcCache {
  return {
    gasQuoteConversions: new Map(),
  };
}

async function resolveTakeCycleTargets(
  state: BoundDiscoveryRuntimeState,
  liquidationAuctions?: ChainwideLiquidationAuction[]
): Promise<EffectiveTakeTarget[]> {
  return [
    ...getManualTakeTargets(state.config),
    ...(await buildDiscoveredTakeTargets(
      state.config,
      liquidationAuctions,
      state.readTransports.subgraph
    )),
  ];
}

async function resolveSettlementCycleTargets(
  state: BoundDiscoveryRuntimeState,
  liquidationAuctions?: ChainwideLiquidationAuction[]
): Promise<EffectiveSettlementTarget[]> {
  return [
    ...getManualSettlementTargets(state.config),
    ...(await buildDiscoveredSettlementTargets(
      state.config,
      liquidationAuctions,
      state.readTransports.subgraph
    )),
  ];
}

async function createTakeCycleRpcCache(
  state: BoundDiscoveryRuntimeState
): Promise<DiscoveryRpcCache | undefined> {
  return state.signer.provider
    ? {
        ...createEmptyDiscoveryRpcCache(),
        gasPrice: await state.readTransports.readRpc.getGasPrice(),
        gasPriceFetchedAt: Date.now(),
        factoryQuoteProviders: createFactoryQuoteProviderRuntimeCache(),
      }
    : undefined;
}

async function createSettlementCycleRpcCache(
  state: BoundDiscoveryRuntimeState
): Promise<DiscoveryRpcCache | undefined> {
  return state.signer.provider
    ? {
        ...createEmptyDiscoveryRpcCache(),
        gasPrice: await state.readTransports.readRpc.getGasPrice(),
        gasPriceFetchedAt: Date.now(),
      }
    : undefined;
}

async function ensureFreshDiscoveryGasPrice(params: {
  state: BoundDiscoveryRuntimeState;
  cache?: DiscoveryRpcCache;
}): Promise<void> {
  if (!params.cache || !params.state.signer.provider) {
    return;
  }

  const gasPriceAgeMs =
    params.cache.gasPriceFetchedAt !== undefined
      ? Math.max(0, Date.now() - params.cache.gasPriceFetchedAt)
      : undefined;
  if (
    params.cache.gasPrice !== undefined &&
    gasPriceAgeMs !== undefined &&
    gasPriceAgeMs < DISCOVERY_GAS_PRICE_TTL_MS
  ) {
    return;
  }

  params.cache.gasPrice = await params.state.readTransports.readRpc.getGasPrice();
  params.cache.gasPriceFetchedAt = Date.now();
}

async function getTakeTargetRpcCache(params: {
  state: BoundDiscoveryRuntimeState;
  target: EffectiveTakeTarget;
  cacheState: DiscoveryRpcCacheState;
}): Promise<DiscoveryRpcCache | undefined> {
  if (params.target.source === 'manual') {
    return undefined;
  }

  if (!params.cacheState.initialized) {
    try {
      params.cacheState.cache = await createTakeCycleRpcCache(params.state);
      params.cacheState.initialized = true;
    } catch (error) {
      const discoveryError =
        error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `Discovery take rpc cache unavailable for this target; discovered take target will fail: ${discoveryError.message}`
      );
      throw discoveryError;
    }
  }

  try {
    await ensureFreshDiscoveryGasPrice({
      state: params.state,
      cache: params.cacheState.cache,
    });
  } catch (error) {
    const discoveryError =
      error instanceof Error ? error : new Error(String(error));
    logger.warn(
      `Discovery take gas price refresh unavailable for this target; discovered take target will fail: ${discoveryError.message}`
    );
    throw discoveryError;
  }

  return params.cacheState.cache;
}

async function getSettlementTargetRpcCache(params: {
  state: BoundDiscoveryRuntimeState;
  target: EffectiveSettlementTarget;
  cacheState: DiscoveryRpcCacheState;
}): Promise<DiscoveryRpcCache | undefined> {
  if (params.target.source === 'manual') {
    return undefined;
  }

  if (!params.cacheState.initialized) {
    try {
      params.cacheState.cache = await createSettlementCycleRpcCache(
        params.state
      );
      params.cacheState.initialized = true;
    } catch (error) {
      const discoveryError =
        error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `Discovery settlement rpc cache unavailable for this target; discovered settlement target will fail: ${discoveryError.message}`
      );
      throw discoveryError;
    }
  }

  try {
    await ensureFreshDiscoveryGasPrice({
      state: params.state,
      cache: params.cacheState.cache,
    });
  } catch (error) {
    const discoveryError =
      error instanceof Error ? error : new Error(String(error));
    logger.warn(
      `Discovery settlement gas price refresh unavailable for this target; discovered settlement target will fail: ${discoveryError.message}`
    );
    throw discoveryError;
  }

  return params.cacheState.cache;
}

async function resolveEffectiveTargetPool(
  state: BoundDiscoveryRuntimeState,
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
  state: BoundDiscoveryRuntimeState;
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
      takeWriteTransport: state.takeWriteTransport,
      config: {
        dryRun: state.config.dryRun,
        delayBetweenActions: state.config.delayBetweenActions,
        connectorTokens: state.config.connectorTokens,
        oneInchRouters: state.config.oneInchRouters,
        keeperTaker: state.config.keeperTaker,
        keeperTakerFactory: state.config.keeperTakerFactory,
        takerContracts: state.config.takerContracts,
        universalRouterOverrides: state.config.universalRouterOverrides,
        sushiswapRouterOverrides: state.config.sushiswapRouterOverrides,
        curveRouterOverrides: state.config.curveRouterOverrides,
        tokenAddresses: state.config.tokenAddresses,
        subgraph: state.readTransports.subgraph,
      },
    });
    return;
  }

  await handleDiscoveredTakeTarget({
    pool,
    signer: state.signer,
    takeWriteTransport: state.takeWriteTransport,
    target,
    config: state.config,
    transports: state.readTransports,
    rpcCache,
  });
}

async function executeEffectiveSettlementTarget(params: {
  state: BoundDiscoveryRuntimeState;
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
        delayBetweenActions: state.config.delayBetweenActions,
        subgraph: state.readTransports.subgraph,
      },
    });
    return;
  }

  await handleDiscoveredSettlementTarget({
    pool,
    signer: state.signer,
    target,
    config: state.config,
    transports: state.readTransports,
    rpcCache,
  });
}

function summarizeCycleTargets(
  targets: EffectiveTakeTarget[] | EffectiveSettlementTarget[]
): Pick<DiscoveryCycleStats, 'targets' | 'manualTargets' | 'discoveredTargets'> {
  let manualTargets = 0;
  for (const target of targets) {
    if (target.source === 'manual') {
      manualTargets += 1;
    }
  }
  return {
    targets: targets.length,
    manualTargets,
    discoveredTargets: targets.length - manualTargets,
  };
}

function logDiscoveryCycleSummary(params: {
  cycleType: 'take' | 'settlement';
  stats: DiscoveryCycleStats;
  durationMs: number;
  snapshotInfo: DiscoveryCycleSnapshotInfo;
}): void {
  logger.info(
    `Discovery ${params.cycleType} cycle summary: durationMs=${params.durationMs} snapshotRefreshed=${params.snapshotInfo.snapshotRefreshed} snapshotAgeMs=${params.snapshotInfo.snapshotAgeMs ?? -1} auctionCount=${params.snapshotInfo.liquidationAuctions?.length ?? 0} targets=${params.stats.targets} manualTargets=${params.stats.manualTargets} discoveredTargets=${params.stats.discoveredTargets} poolsUnavailable=${params.stats.poolsUnavailable} targetSuccesses=${params.stats.targetSuccesses} targetFailures=${params.stats.targetFailures}`
  );
}

function logDiscoveryCycleFailure(params: {
  cycleType: 'take' | 'settlement';
  phase: string;
  durationMs: number;
  snapshotInfo?: DiscoveryCycleSnapshotInfo;
  stats?: Partial<DiscoveryCycleStats>;
  error: unknown;
}): void {
  logger.error(
    `Discovery ${params.cycleType} cycle failed: phase=${params.phase} durationMs=${params.durationMs} snapshotRefreshed=${params.snapshotInfo?.snapshotRefreshed ?? false} snapshotAgeMs=${params.snapshotInfo?.snapshotAgeMs ?? -1} auctionCount=${params.snapshotInfo?.liquidationAuctions?.length ?? 0} targets=${params.stats?.targets ?? 0} manualTargets=${params.stats?.manualTargets ?? 0} discoveredTargets=${params.stats?.discoveredTargets ?? 0} poolsUnavailable=${params.stats?.poolsUnavailable ?? 0} targetSuccesses=${params.stats?.targetSuccesses ?? 0} targetFailures=${params.stats?.targetFailures ?? 0}`,
    params.error
  );
}

async function runTakeDiscoveryCycle(state: BoundDiscoveryRuntimeState): Promise<void> {
  const startedAt = Date.now();
  let phase = 'snapshot';
  let snapshotInfo: DiscoveryCycleSnapshotInfo = {
    snapshotRefreshed: false,
  };
  const stats: DiscoveryCycleStats = {
    targets: 0,
    manualTargets: 0,
    discoveredTargets: 0,
    poolsUnavailable: 0,
    targetSuccesses: 0,
    targetFailures: 0,
  };
  const rpcCacheState: DiscoveryRpcCacheState = {
    initialized: false,
  };

  try {
    snapshotInfo = await getTakeCycleLiquidationAuctions(state);
    phase = 'targets';
    const targets = await resolveTakeCycleTargets(
      state,
      snapshotInfo.liquidationAuctions
    );
    Object.assign(stats, summarizeCycleTargets(targets));
    phase = 'dispatch';

    for (const target of targets) {
      const pool = await resolveEffectiveTargetPool(state, target);
      if (!pool) {
        stats.poolsUnavailable += 1;
        continue;
      }

      try {
        const rpcCache = await getTakeTargetRpcCache({
          state,
          target,
          cacheState: rpcCacheState,
        });
        await executeEffectiveTakeTarget({
          state,
          pool,
          target,
          rpcCache,
        });
        stats.targetSuccesses += 1;
        await delay(state.config.delayBetweenActions);
      } catch (error) {
        stats.targetFailures += 1;
        logger.error(`Failed to handle take for pool: ${pool.name}.`, error);
      }
    }

    logDiscoveryCycleSummary({
      cycleType: 'take',
      stats,
      durationMs: Date.now() - startedAt,
      snapshotInfo,
    });
  } catch (error) {
    logDiscoveryCycleFailure({
      cycleType: 'take',
      phase,
      durationMs: Date.now() - startedAt,
      snapshotInfo,
      stats,
      error,
    });
    throw error;
  }
}

async function runSettlementDiscoveryCycle(
  state: BoundDiscoveryRuntimeState
): Promise<void> {
  const startedAt = Date.now();
  let phase = 'snapshot';
  let snapshotInfo: DiscoveryCycleSnapshotInfo = {
    snapshotRefreshed: false,
  };
  const stats: DiscoveryCycleStats = {
    targets: 0,
    manualTargets: 0,
    discoveredTargets: 0,
    poolsUnavailable: 0,
    targetSuccesses: 0,
    targetFailures: 0,
  };
  const rpcCacheState: DiscoveryRpcCacheState = {
    initialized: false,
  };

  try {
    const includeDiscoveredTargets = shouldRunDiscoveredSettlementCycle(state);
    if (includeDiscoveredTargets) {
      snapshotInfo = await getSettlementCycleLiquidationAuctions(state);
    } else {
      snapshotInfo = {
        liquidationAuctions: state.discoverySnapshotState?.latestLiquidationAuctions,
        snapshotRefreshed: false,
        snapshotAgeMs:
          state.discoverySnapshotState?.fetchedAt !== undefined
            ? Math.max(0, Date.now() - state.discoverySnapshotState.fetchedAt)
            : undefined,
      };
    }
    phase = 'targets';
    const targets = includeDiscoveredTargets
      ? await resolveSettlementCycleTargets(
          state,
          snapshotInfo.liquidationAuctions
        )
      : getManualSettlementTargets(state.config);
    Object.assign(stats, summarizeCycleTargets(targets));
    if (includeDiscoveredTargets) {
      state.lastDiscoveredSettlementCycleStartedAtMs = Date.now();
    }
    phase = 'dispatch';

    for (const target of targets) {
      const pool = await resolveEffectiveTargetPool(state, target);
      if (!pool) {
        stats.poolsUnavailable += 1;
        continue;
      }

      try {
        const rpcCache = await getSettlementTargetRpcCache({
          state,
          target,
          cacheState: rpcCacheState,
        });
        logger.debug(`Processing settlement check for pool: ${pool.name}`);
        await executeEffectiveSettlementTarget({
          state,
          pool,
          target,
          rpcCache,
        });
        stats.targetSuccesses += 1;
        logger.debug(`Settlement check completed for pool: ${pool.name}`);
        await delay(state.config.delayBetweenActions);
      } catch (error) {
        stats.targetFailures += 1;
        logger.error(`Failed to handle settlements for pool: ${pool.name}`, error);
      }
    }

    logDiscoveryCycleSummary({
      cycleType: 'settlement',
      stats,
      durationMs: Date.now() - startedAt,
      snapshotInfo,
    });
  } catch (error) {
    logDiscoveryCycleFailure({
      cycleType: 'settlement',
      phase,
      durationMs: Date.now() - startedAt,
      snapshotInfo,
      stats,
      error,
    });
    throw error;
  }
}

function computeSettlementLoopIntervalSeconds(config: KeeperConfig): number {
  return config.delayBetweenRuns;
}

function computeDiscoveredSettlementCheckIntervalSeconds(
  config: KeeperConfig
): number {
  return Math.max(config.delayBetweenRuns * 5, 120);
}

function shouldRunDiscoveredSettlementCycle(
  state: BoundDiscoveryRuntimeState
): boolean {
  if (
    !state.config.autoDiscover?.enabled ||
    !getAutoDiscoverSettlementPolicy(state.config.autoDiscover)
  ) {
    return false;
  }

  if (state.lastDiscoveredSettlementCycleStartedAtMs === undefined) {
    return true;
  }

  return (
    Date.now() - state.lastDiscoveredSettlementCycleStartedAtMs >=
    computeDiscoveredSettlementCheckIntervalSeconds(state.config) * 1000
  );
}

export function createDiscoveryRuntime(
  params: CreateDiscoveryRuntimeParams
): DiscoveryRuntime {
  const state: BoundDiscoveryRuntimeState = {
    ...params,
    readTransports: createDiscoveryReadTransports(
      params.config,
      params.signer.provider
    ),
  };

  return {
    async runTakeCycle() {
      await runTakeDiscoveryCycle(state);
    },
    async runSettlementCycle() {
      await runSettlementDiscoveryCycle(state);
    },
    getSettlementCheckIntervalSeconds() {
      return computeSettlementLoopIntervalSeconds(state.config);
    },
  };
}
