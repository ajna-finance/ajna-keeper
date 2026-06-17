import { AjnaSDK, FungiblePool, Signer } from '@ajna-finance/sdk';
import { Wallet } from 'ethers';
import {
  buildDiscoveredSettlementTargets,
  buildDiscoveredTakeTargets,
  EffectiveSettlementTarget,
  EffectiveTakeTarget,
  ensurePoolLoaded,
  getChainwideLiquidationAuctionsShared,
  HotAuctionCandidateCache,
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
import {
  ExternalProviderCircuits,
  getDiscoveryExecutionConfig,
} from './types';
import { logger } from '../logging';
import {
  createDiscoveryReadTransports,
  DiscoveryReadTransports,
  getDiscoveryReadTransportConfig,
} from '../read-transports';
import { handleSettlements } from '../settlement';
import { ChainwideLiquidationAuction } from '../subgraph';
import { handleTakes } from '../take';
import { getDiscoveryGasPriceFreshnessTtlMs } from './gas-policy';
import {
  createTakeWriteTransport,
  resolveTakeWriteConfig,
  TakeWriteTransport,
} from '../take/write-transport';
import {
  delay,
  getAddressInsensitiveMapValue,
  getErrorMessage,
} from '../utils';
import { createDiscoveryRpcCache } from './rpc-cache';
import {
  DirectDexQuoteProviderRuntimeCache,
  createDirectDexQuoteProviderRuntimeCache,
} from '../take/direct-dex';
import {
  DEFAULT_HOT_AUCTION_CANDIDATE_TTL_MS,
  DEFAULT_MAX_HOT_AUCTION_CANDIDATES,
} from '../constants';

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
  chainId?: number;
  hotAuctionCandidateCache?: HotAuctionCandidateCache;
  directDexQuoteProviders: DirectDexQuoteProviderRuntimeCache;
  providerCircuits: ExternalProviderCircuits;
  lastDiscoveredSettlementCycleStartedAtMs?: number;
  lastDiscoveredSettlementFailureAtMs?: number;
};
type EffectiveTargetIdentity =
  | Pick<EffectiveTakeTarget, 'source' | 'poolAddress' | 'name'>
  | Pick<EffectiveSettlementTarget, 'source' | 'poolAddress' | 'name'>;

interface DiscoveryCycleSnapshotInfo {
  liquidationAuctions?: ChainwideLiquidationAuction[];
  snapshotRefreshed: boolean;
  snapshotRefreshFailed?: boolean;
  snapshotFallbackUsed?: boolean;
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

function createHotAuctionCandidateCacheForConfig(
  config: KeeperConfig
): HotAuctionCandidateCache | undefined {
  const takePolicy = getAutoDiscoverTakePolicy(config.discovery);
  if (!config.discovery?.enabled || !takePolicy) {
    return undefined;
  }
  const ttlMs =
    takePolicy.hotAuctionCandidateTtlMs ?? DEFAULT_HOT_AUCTION_CANDIDATE_TTL_MS;
  if (ttlMs <= 0) {
    return undefined;
  }
  return new HotAuctionCandidateCache({
    ttlMs,
    maxCandidates:
      takePolicy.maxHotAuctionCandidates ?? DEFAULT_MAX_HOT_AUCTION_CANDIDATES,
  });
}

async function getRuntimeChainId(
  state: BoundDiscoveryRuntimeState
): Promise<number | undefined> {
  if (state.chainId !== undefined) {
    return state.chainId;
  }
  try {
    state.chainId = await state.signer.getChainId();
    return state.chainId;
  } catch (error) {
    logger.warn(
      `Discovery runtime could not resolve chainId; hot auction cache will be skipped this cycle: ${getErrorMessage(error)}`
    );
    return undefined;
  }
}

function shouldRefreshDiscoverySnapshotOnTakeCycle(
  config: KeeperConfig
): boolean {
  return (
    !!config.discovery?.enabled && !!getAutoDiscoverTakePolicy(config.discovery)
  );
}

function shouldRefreshDiscoverySnapshotOnSettlementCycle(
  config: KeeperConfig,
  discoverySnapshotState?: DiscoverySnapshotState
): boolean {
  if (
    !config.discovery?.enabled ||
    !getAutoDiscoverSettlementPolicy(config.discovery)
  ) {
    return false;
  }

  if (!getAutoDiscoverTakePolicy(config.discovery)) {
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
    getDiscoveryReadTransportConfig(state.config),
    state.readTransports.subgraph
  );
  if (state.discoverySnapshotState) {
    state.discoverySnapshotState.latestLiquidationAuctions =
      liquidationAuctions;
    state.discoverySnapshotState.fetchedAt = Date.now();
  }
  return liquidationAuctions;
}

function getSnapshotAgeMs(
  discoverySnapshotState?: DiscoverySnapshotState
): number | undefined {
  return discoverySnapshotState?.fetchedAt !== undefined
    ? Math.max(0, Date.now() - discoverySnapshotState.fetchedAt)
    : undefined;
}

function getMaxDiscoverySnapshotFallbackAgeMs(config: KeeperConfig): number {
  return Math.max(config.runtime.delayBetweenRuns * 5, 120) * 1000;
}

function getCachedDiscoverySnapshotForFallback(
  state: BoundDiscoveryRuntimeState,
  cycleType: 'take' | 'settlement'
): ChainwideLiquidationAuction[] | undefined {
  const cachedAuctions =
    state.discoverySnapshotState?.latestLiquidationAuctions;
  if (!cachedAuctions) {
    return undefined;
  }

  const snapshotAgeMs = getSnapshotAgeMs(state.discoverySnapshotState);
  if (
    snapshotAgeMs === undefined ||
    snapshotAgeMs <= getMaxDiscoverySnapshotFallbackAgeMs(state.config)
  ) {
    return cachedAuctions;
  }

  logger.warn(
    `Cached ${cycleType} discovery snapshot is too stale (${Math.round(
      snapshotAgeMs / 1000
    )}s old); continuing with manual targets only`
  );
  return undefined;
}

function requiresDedicatedTakeWriteTransport(config: KeeperConfig): boolean {
  return !config.runtime.dryRun && resolveTakeWriteConfig(config) !== undefined;
}

function isTakeWriteWalletSigner(signer: Signer): signer is Wallet {
  const candidate = signer as Partial<Wallet>;
  return (
    typeof candidate.connect === 'function' &&
    typeof candidate.populateTransaction === 'function' &&
    typeof candidate.signTransaction === 'function'
  );
}

async function ensureTakeWriteTransport(
  state: BoundDiscoveryRuntimeState
): Promise<boolean> {
  if (!requiresDedicatedTakeWriteTransport(state.config)) {
    return true;
  }

  if (state.takeWriteTransport) {
    return true;
  }

  if (!isTakeWriteWalletSigner(state.signer)) {
    logger.error(
      'Configured take write transport requires a wallet-capable signer; skipping take execution for this cycle.'
    );
    return false;
  }

  try {
    state.takeWriteTransport = await createTakeWriteTransport({
      signer: state.signer,
      config: state.config,
      expectedChainId: await state.signer.getChainId(),
    });
    return true;
  } catch (error) {
    logger.error(
      'Failed to initialize take write transport for this take cycle; skipping take execution until the next retry.',
      error
    );
    return false;
  }
}

async function getTakeCycleLiquidationAuctions(
  state: BoundDiscoveryRuntimeState
): Promise<DiscoveryCycleSnapshotInfo> {
  let liquidationAuctions: ChainwideLiquidationAuction[] | undefined;
  let snapshotRefreshed = false;
  let snapshotRefreshFailed = false;
  let snapshotFallbackUsed = false;
  if (shouldRefreshDiscoverySnapshotOnTakeCycle(state.config)) {
    try {
      liquidationAuctions = await refreshDiscoverySnapshot(state);
      snapshotRefreshed = true;
    } catch (error) {
      const cachedAuctions = getCachedDiscoverySnapshotForFallback(
        state,
        'take'
      );
      logger.warn(
        `Failed to refresh take discovery snapshot; continuing with ${cachedAuctions ? 'cached discovery data' : 'manual targets only'}`,
        error
      );
      liquidationAuctions = cachedAuctions ?? [];
      snapshotRefreshFailed = true;
      snapshotFallbackUsed = cachedAuctions !== undefined;
    }
  }
  return {
    liquidationAuctions,
    snapshotRefreshed,
    snapshotRefreshFailed,
    snapshotFallbackUsed,
    snapshotAgeMs: getSnapshotAgeMs(state.discoverySnapshotState),
  };
}

async function getSettlementCycleLiquidationAuctions(
  state: BoundDiscoveryRuntimeState
): Promise<DiscoveryCycleSnapshotInfo> {
  let refreshedLiquidationAuctions: ChainwideLiquidationAuction[] | undefined;
  let snapshotRefreshed = false;
  let snapshotRefreshFailed = false;
  let snapshotFallbackUsed = false;
  if (
    shouldRefreshDiscoverySnapshotOnSettlementCycle(
      state.config,
      state.discoverySnapshotState
    )
  ) {
    try {
      refreshedLiquidationAuctions = await refreshDiscoverySnapshot(state);
      snapshotRefreshed = true;
    } catch (error) {
      const cachedAuctions = getCachedDiscoverySnapshotForFallback(
        state,
        'settlement'
      );
      logger.warn(
        `Failed to refresh settlement discovery snapshot; continuing with ${cachedAuctions ? 'cached discovery data' : 'manual targets only'}`,
        error
      );
      refreshedLiquidationAuctions = cachedAuctions ?? [];
      snapshotRefreshFailed = true;
      snapshotFallbackUsed = cachedAuctions !== undefined;
    }
  }

  const liquidationAuctions =
    refreshedLiquidationAuctions ??
    state.discoverySnapshotState?.latestLiquidationAuctions ??
    undefined;
  return {
    liquidationAuctions,
    snapshotRefreshed,
    snapshotRefreshFailed,
    snapshotFallbackUsed,
    snapshotAgeMs: getSnapshotAgeMs(state.discoverySnapshotState),
  };
}

async function resolveTakeCycleTargets(
  state: BoundDiscoveryRuntimeState,
  liquidationAuctions?: ChainwideLiquidationAuction[]
): Promise<EffectiveTakeTarget[]> {
  const chainId = state.hotAuctionCandidateCache
    ? await getRuntimeChainId(state)
    : undefined;
  return [
    ...getManualTakeTargets(state.config),
    ...(await buildDiscoveredTakeTargets(
      state.config,
      liquidationAuctions,
      state.readTransports.subgraph,
      {
        hotAuctionCandidateCache: state.hotAuctionCandidateCache,
        chainId,
      }
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

async function createDiscoveryCycleRpcCache(params: {
  state: BoundDiscoveryRuntimeState;
  includeDirectDexQuoteProviders?: boolean;
}): Promise<DiscoveryRpcCache | undefined> {
  return await createDiscoveryRpcCache({
    signer: params.state.signer,
    readRpc: params.state.readTransports.readRpc,
    includeDirectDexQuoteProviders: params.includeDirectDexQuoteProviders,
    directDexQuoteProviders: params.includeDirectDexQuoteProviders
      ? params.state.directDexQuoteProviders
      : undefined,
    providerCircuits: params.includeDirectDexQuoteProviders
      ? params.state.providerCircuits
      : undefined,
  });
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
    gasPriceAgeMs <
      getDiscoveryGasPriceFreshnessTtlMs(
        getAutoDiscoverTakePolicy(params.state.config.discovery),
        params.cache.chainId ?? params.state.chainId
      )
  ) {
    return;
  }

  params.cache.gasPrice =
    await params.state.readTransports.readRpc.getGasPrice();
  params.cache.gasPriceFetchedAt = Date.now();
}

async function getDiscoveryTargetRpcCache<
  TTarget extends { source: 'manual' | 'discovered' },
>(params: {
  state: BoundDiscoveryRuntimeState;
  target: TTarget;
  cacheState: DiscoveryRpcCacheState;
  targetLabel: 'take' | 'settlement';
  createCache: () => Promise<DiscoveryRpcCache | undefined>;
}): Promise<DiscoveryRpcCache | undefined> {
  if (params.target.source === 'manual') {
    return undefined;
  }

  if (!params.cacheState.initialized) {
    try {
      params.cacheState.cache = await params.createCache();
      params.cacheState.initialized = true;
    } catch (error) {
      const discoveryError =
        error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `Discovery ${params.targetLabel} rpc cache unavailable for this target; discovered ${params.targetLabel} target will fail: ${discoveryError.message}`
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
      `Discovery ${params.targetLabel} gas price refresh unavailable for this target; discovered ${params.targetLabel} target will fail: ${discoveryError.message}`
    );
    throw discoveryError;
  }

  return params.cacheState.cache;
}

async function getTakeTargetRpcCache(params: {
  state: BoundDiscoveryRuntimeState;
  target: EffectiveTakeTarget;
  cacheState: DiscoveryRpcCacheState;
}): Promise<DiscoveryRpcCache | undefined> {
  return await getDiscoveryTargetRpcCache({
    state: params.state,
    target: params.target,
    cacheState: params.cacheState,
    targetLabel: 'take',
    createCache: async () =>
      await createDiscoveryCycleRpcCache({
        state: params.state,
        includeDirectDexQuoteProviders: true,
      }),
  });
}

async function getSettlementTargetRpcCache(params: {
  state: BoundDiscoveryRuntimeState;
  target: EffectiveSettlementTarget;
  cacheState: DiscoveryRpcCacheState;
}): Promise<DiscoveryRpcCache | undefined> {
  return await getDiscoveryTargetRpcCache({
    state: params.state,
    target: params.target,
    cacheState: params.cacheState,
    targetLabel: 'settlement',
    createCache: async () =>
      await createDiscoveryCycleRpcCache({
        state: params.state,
      }),
  });
}

async function resolveEffectiveTargetPool(
  state: BoundDiscoveryRuntimeState,
  target: EffectiveTargetIdentity
): Promise<FungiblePool | undefined> {
  const pool =
    target.source === 'manual'
      ? getAddressInsensitiveMapValue(state.poolMap, target.poolAddress)
      : await ensurePoolLoaded({
          ajna: state.ajna,
          poolMap: state.poolMap,
          poolAddress: target.poolAddress,
          config: state.config,
          hydrationCooldowns: state.hydrationCooldowns,
        });

  if (!pool) {
    logger.warn(
      `Skipping target ${target.name} because the pool is unavailable`
    );
    return undefined;
  }

  return pool;
}

function createHotAuctionCandidateRemover(
  state: BoundDiscoveryRuntimeState
):
  | ((candidate: { poolAddress: string; borrower: string }) => boolean)
  | undefined {
  if (!state.hotAuctionCandidateCache || state.chainId === undefined) {
    return undefined;
  }
  return (candidate) => {
    const removed = state.hotAuctionCandidateCache?.removeCandidate({
      chainId: state.chainId!,
      poolAddress: candidate.poolAddress,
      borrower: candidate.borrower,
    });
    if (removed) {
      logger.debug(
        `Removed inactive hot take candidate ${candidate.poolAddress}/${candidate.borrower} from cache`
      );
    }
    return removed === true;
  };
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
        ...getDiscoveryExecutionConfig(state.config),
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
    config: getDiscoveryExecutionConfig(state.config),
    transports: state.readTransports,
    rpcCache,
    onCandidateInactive: createHotAuctionCandidateRemover(state),
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
        dryRun: state.config.runtime.dryRun,
        subgraph: state.readTransports.subgraph,
      },
    });
    return;
  }

  await handleDiscoveredSettlementTarget({
    pool,
    signer: state.signer,
    target,
    config: getDiscoveryExecutionConfig(state.config),
    transports: state.readTransports,
    rpcCache,
  });
}

function summarizeCycleTargets(
  targets: EffectiveTakeTarget[] | EffectiveSettlementTarget[]
): Pick<
  DiscoveryCycleStats,
  'targets' | 'manualTargets' | 'discoveredTargets'
> {
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

function getDiscoveryRpcStatParts(cache?: DiscoveryRpcCache): string[] {
  const stats = cache?.stats;
  if (!stats) {
    return [];
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(stats)) {
    if (key === 'directDex' || typeof value !== 'number' || value === 0) {
      continue;
    }
    parts.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(stats.directDex ?? {})) {
    if (typeof value === 'number' && value !== 0) {
      parts.push(`directDex.${key}=${value}`);
    }
  }
  return parts;
}

function logDiscoveryRpcStats(params: {
  cycleType: 'take' | 'settlement';
  cache?: DiscoveryRpcCache;
}): void {
  const parts = getDiscoveryRpcStatParts(params.cache);
  if (parts.length === 0) {
    return;
  }
  logger.debug(`Discovery ${params.cycleType} rpc stats: ${parts.join(' ')}`);
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

async function runTakeDiscoveryCycle(
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
    phase = 'transport';
    if (!(await ensureTakeWriteTransport(state))) {
      logDiscoveryCycleSummary({
        cycleType: 'take',
        stats,
        durationMs: Date.now() - startedAt,
        snapshotInfo: {
          snapshotRefreshed: false,
          snapshotAgeMs: getSnapshotAgeMs(state.discoverySnapshotState),
        },
      });
      return;
    }

    phase = 'snapshot';
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
      } catch (error) {
        stats.targetFailures += 1;
        logger.error(`Failed to handle take for pool: ${pool.name}.`, error);
      }
    }

    logDiscoveryRpcStats({
      cycleType: 'take',
      cache: rpcCacheState.cache,
    });
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
  let includeDiscoveredTargets = false;
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
  let discoveredTargetSuccesses = 0;

  try {
    includeDiscoveredTargets = shouldRunDiscoveredSettlementCycle(state);
    if (includeDiscoveredTargets) {
      snapshotInfo = await getSettlementCycleLiquidationAuctions(state);
    } else {
      snapshotInfo = {
        liquidationAuctions:
          state.discoverySnapshotState?.latestLiquidationAuctions,
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
        if (target.source === 'discovered') {
          discoveredTargetSuccesses += 1;
        }
        logger.debug(`Settlement check completed for pool: ${pool.name}`);
      } catch (error) {
        stats.targetFailures += 1;
        logger.error(
          `Failed to handle settlements for pool: ${pool.name}`,
          error
        );
      }
    }

    if (includeDiscoveredTargets) {
      const completedWithUsableDiscoveryData =
        !snapshotInfo.snapshotRefreshFailed ||
        snapshotInfo.snapshotFallbackUsed;
      if (
        !completedWithUsableDiscoveryData &&
        snapshotInfo.snapshotRefreshFailed
      ) {
        state.lastDiscoveredSettlementFailureAtMs = Date.now();
      } else if (
        stats.discoveredTargets === 0 ||
        discoveredTargetSuccesses > 0
      ) {
        state.lastDiscoveredSettlementCycleStartedAtMs = Date.now();
        state.lastDiscoveredSettlementFailureAtMs = undefined;
      } else {
        state.lastDiscoveredSettlementFailureAtMs = Date.now();
      }
    }

    logDiscoveryCycleSummary({
      cycleType: 'settlement',
      stats,
      durationMs: Date.now() - startedAt,
      snapshotInfo,
    });
  } catch (error) {
    if (includeDiscoveredTargets) {
      state.lastDiscoveredSettlementFailureAtMs = Date.now();
    }
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
  return config.runtime.delayBetweenRuns;
}

function computeDiscoveredSettlementCheckIntervalSeconds(
  config: KeeperConfig
): number {
  return Math.max(config.runtime.delayBetweenRuns * 5, 120);
}

function computeDiscoveredSettlementFailureRetrySeconds(
  config: KeeperConfig
): number {
  return Math.min(
    computeDiscoveredSettlementCheckIntervalSeconds(config),
    Math.max(config.runtime.delayBetweenRuns, 30)
  );
}

function shouldRunDiscoveredSettlementCycle(
  state: BoundDiscoveryRuntimeState
): boolean {
  if (
    !state.config.discovery?.enabled ||
    !getAutoDiscoverSettlementPolicy(state.config.discovery)
  ) {
    return false;
  }

  const lastFailureAtMs = state.lastDiscoveredSettlementFailureAtMs;
  const lastSuccessAtMs = state.lastDiscoveredSettlementCycleStartedAtMs;
  if (
    lastFailureAtMs !== undefined &&
    (lastSuccessAtMs === undefined || lastFailureAtMs > lastSuccessAtMs) &&
    Date.now() - lastFailureAtMs <
      computeDiscoveredSettlementFailureRetrySeconds(state.config) * 1000
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
    hotAuctionCandidateCache: createHotAuctionCandidateCacheForConfig(
      params.config
    ),
    directDexQuoteProviders: createDirectDexQuoteProviderRuntimeCache(),
    providerCircuits: {},
    readTransports: createDiscoveryReadTransports(
      getDiscoveryReadTransportConfig(params.config),
      params.signer.provider,
      async () => await params.signer.getChainId()
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
