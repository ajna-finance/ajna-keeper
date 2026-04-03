import { Address, AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { ethers } from 'ethers';
import {
  KeeperConfig,
  PoolConfig,
  SettlementConfig,
  TakeSettings,
  validateSettlementSettings,
  validateTakeSettings,
} from './config-types';
import { logger } from './logging';
import subgraph, { ChainwideLiquidationAuction } from './subgraph';
import { overrideMulticall, RequireFields } from './utils';

const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_MAX_PAGES = 100;

export type PoolMap = Map<string, FungiblePool>;
export type PoolHydrationCooldowns = Map<string, number>;

export interface ManualTakeTarget {
  source: 'manual';
  poolAddress: Address;
  name: string;
  dryRun: boolean;
  poolConfig: RequireFields<PoolConfig, 'take'>;
}

export interface ManualSettlementTarget {
  source: 'manual';
  poolAddress: Address;
  name: string;
  dryRun: boolean;
  poolConfig: RequireFields<PoolConfig, 'settlement'>;
}

export interface DiscoveredAuctionCandidate {
  poolAddress: Address;
  borrower: string;
  kickTime: number;
  debtRemaining: string;
  collateralRemaining: string;
  neutralPrice: string;
  debt: string;
  collateral: string;
  heuristicScore: number;
}

export interface ResolvedTakeTarget {
  source: 'discovered';
  poolAddress: Address;
  name: string;
  dryRun: boolean;
  take: TakeSettings;
  candidates: DiscoveredAuctionCandidate[];
}

export interface ResolvedSettlementTarget {
  source: 'discovered';
  poolAddress: Address;
  name: string;
  dryRun: boolean;
  settlement: SettlementConfig;
  candidates: DiscoveredAuctionCandidate[];
}

export type EffectiveTakeTarget = ManualTakeTarget | ResolvedTakeTarget;
export type EffectiveSettlementTarget =
  | ManualSettlementTarget
  | ResolvedSettlementTarget;

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function getCachedPool(poolMap: PoolMap, address: string): FungiblePool | undefined {
  return poolMap.get(address) ?? poolMap.get(normalizeAddress(address));
}

function cachePool(poolMap: PoolMap, address: string, pool: FungiblePool): void {
  poolMap.set(address, pool);
  const normalized = normalizeAddress(address);
  if (normalized !== address) {
    poolMap.set(normalized, pool);
  }
}

function buildPoolIndex(config: KeeperConfig): Map<string, PoolConfig> {
  const poolIndex = new Map<string, PoolConfig>();
  for (const poolConfig of config.pools) {
    poolIndex.set(normalizeAddress(poolConfig.address), poolConfig);
  }
  return poolIndex;
}

function logDiscoverySkip(config: KeeperConfig, message: string): void {
  if (config.autoDiscover?.logSkips) {
    logger.info(`Discovery skip: ${message}`);
  } else {
    logger.debug(`Discovery skip: ${message}`);
  }
}

function poolAllowed(config: KeeperConfig, poolAddress: string): boolean {
  const autoDiscover = config.autoDiscover;
  if (!autoDiscover?.enabled) {
    return false;
  }

  const normalized = normalizeAddress(poolAddress);
  const allowPools = new Set(
    (autoDiscover.allowPools ?? []).map((address) => normalizeAddress(address))
  );
  const denyPools = new Set(
    (autoDiscover.denyPools ?? []).map((address) => normalizeAddress(address))
  );

  if (allowPools.size > 0 && !allowPools.has(normalized)) {
    logDiscoverySkip(config, `pool ${normalized} not in allowPools`);
    return false;
  }
  if (denyPools.has(normalized)) {
    logDiscoverySkip(config, `pool ${normalized} is in denyPools`);
    return false;
  }
  return true;
}

function candidateKey(candidate: { poolAddress: string; borrower: string }): string {
  return `${normalizeAddress(candidate.poolAddress)}:${candidate.borrower.toLowerCase()}`;
}

function computeTakeHeuristicScore(candidate: ChainwideLiquidationAuction): number {
  const collateralRemaining = Number(candidate.collateralRemaining || '0');
  const neutralPrice = Number(candidate.neutralPrice || '0');
  const debtRemaining = Number(candidate.debtRemaining || '0');
  const baseScore = collateralRemaining * neutralPrice;
  return Number.isFinite(baseScore) && baseScore > 0 ? baseScore : debtRemaining;
}

function computeSettlementHeuristicScore(candidate: ChainwideLiquidationAuction): number {
  const kickTime = Number(candidate.kickTime || '0');
  const debtRemaining = Number(candidate.debtRemaining || '0');
  return debtRemaining + Math.max(0, Date.now() / 1000 - kickTime);
}

function hydrateCandidate(
  candidate: ChainwideLiquidationAuction,
  heuristicScore: number
): DiscoveredAuctionCandidate {
  return {
    poolAddress: candidate.pool.id,
    borrower: candidate.borrower,
    kickTime: Number(candidate.kickTime || '0') * 1000,
    debtRemaining: candidate.debtRemaining,
    collateralRemaining: candidate.collateralRemaining,
    neutralPrice: candidate.neutralPrice,
    debt: candidate.debt,
    collateral: candidate.collateral,
    heuristicScore,
  };
}

function dedupeCandidates(
  candidates: DiscoveredAuctionCandidate[]
): DiscoveredAuctionCandidate[] {
  const deduped: DiscoveredAuctionCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function groupCandidatesByPool(
  candidates: DiscoveredAuctionCandidate[]
): Map<string, DiscoveredAuctionCandidate[]> {
  const grouped = new Map<string, DiscoveredAuctionCandidate[]>();
  for (const candidate of candidates) {
    const normalizedPool = normalizeAddress(candidate.poolAddress);
    const existing = grouped.get(normalizedPool) ?? [];
    existing.push(candidate);
    grouped.set(normalizedPool, existing);
  }
  return grouped;
}

function candidateGroupScore(candidates: DiscoveredAuctionCandidate[]): number {
  let bestScore = 0;
  for (const candidate of candidates) {
    if (candidate.heuristicScore > bestScore) {
      bestScore = candidate.heuristicScore;
    }
  }
  return bestScore;
}

export function getManualTakeTargets(config: KeeperConfig): ManualTakeTarget[] {
  return config.pools
    .filter(
      (poolConfig): poolConfig is RequireFields<PoolConfig, 'take'> =>
        !!poolConfig.take
    )
    .map((poolConfig) => ({
      source: 'manual' as const,
      poolAddress: poolConfig.address,
      name: poolConfig.name,
      dryRun: !!config.dryRun,
      poolConfig,
    }));
}

export function getManualSettlementTargets(
  config: KeeperConfig
): ManualSettlementTarget[] {
  return config.pools
    .filter(
      (poolConfig): poolConfig is RequireFields<PoolConfig, 'settlement'> =>
        !!poolConfig.settlement?.enabled
    )
    .map((poolConfig) => ({
      source: 'manual' as const,
      poolAddress: poolConfig.address,
      name: poolConfig.name,
      dryRun: !!config.dryRun,
      poolConfig,
    }));
}

export async function buildDiscoveredTakeTargets(
  config: KeeperConfig
): Promise<ResolvedTakeTarget[]> {
  const autoDiscover = config.autoDiscover;
  if (!autoDiscover?.enabled || !autoDiscover.take) {
    return [];
  }

  const poolIndex = buildPoolIndex(config);
  const manualTakePools = new Set(
    config.pools
      .filter((poolConfig) => !!poolConfig.take)
      .map((poolConfig) => normalizeAddress(poolConfig.address))
  );

  const { liquidationAuctions } = await subgraph.getChainwideLiquidationAuctions(
    config.subgraphUrl,
    DISCOVERY_PAGE_SIZE,
    DISCOVERY_MAX_PAGES
  );

  const takeCandidates = dedupeCandidates(
    liquidationAuctions
      .filter((candidate) => poolAllowed(config, candidate.pool.id))
      .filter((candidate) => Number(candidate.collateralRemaining || '0') > 0)
      .filter((candidate) => {
        const normalizedPool = normalizeAddress(candidate.pool.id);
        if (manualTakePools.has(normalizedPool)) {
          logDiscoverySkip(
            config,
            `take discovery ignored ${normalizedPool} because manual take config wins`
          );
          return false;
        }
        return true;
      })
      .map((candidate) =>
        hydrateCandidate(candidate, computeTakeHeuristicScore(candidate))
      )
  );

  takeCandidates.sort((left, right) => right.heuristicScore - left.heuristicScore);

  const quoteBudget = autoDiscover.takeQuoteBudgetPerRun ?? takeCandidates.length;
  const budgetedCandidates = takeCandidates.slice(0, quoteBudget);
  if (budgetedCandidates.length < takeCandidates.length) {
    logDiscoverySkip(
      config,
      `take quote budget kept ${budgetedCandidates.length} of ${takeCandidates.length} candidates`
    );
  }

  const grouped = groupCandidatesByPool(budgetedCandidates);
  const groupedEntries = Array.from(grouped.entries()).sort(
    ([, leftCandidates], [, rightCandidates]) =>
      candidateGroupScore(rightCandidates) - candidateGroupScore(leftCandidates)
  );
  const maxPoolsPerRun = autoDiscover.maxPoolsPerRun ?? groupedEntries.length;

  const targets: ResolvedTakeTarget[] = [];
  for (const [poolAddress, candidates] of groupedEntries.slice(0, maxPoolsPerRun)) {
    const manualPool = poolIndex.get(poolAddress);
    const takeConfig = manualPool?.take ?? config.discoveredDefaults?.take;
    if (!takeConfig) {
      logDiscoverySkip(
        config,
        `take discovery found ${poolAddress} but no discoveredDefaults.take was configured`
      );
      continue;
    }

    const target: ResolvedTakeTarget = {
      source: 'discovered',
      poolAddress,
      name: manualPool?.name ?? `discovered:${poolAddress}`,
      dryRun: !!config.dryRun || !!autoDiscover.dryRunNewPools,
      take: takeConfig,
      candidates,
    };

    validateResolvedTakeTarget(target, config);
    targets.push(target);
  }

  return targets;
}

export async function buildDiscoveredSettlementTargets(
  config: KeeperConfig
): Promise<ResolvedSettlementTarget[]> {
  const autoDiscover = config.autoDiscover;
  if (!autoDiscover?.enabled || !autoDiscover.settlement) {
    return [];
  }

  const poolIndex = buildPoolIndex(config);
  const manualSettlementPools = new Set(
    config.pools
      .filter((poolConfig) => !!poolConfig.settlement?.enabled)
      .map((poolConfig) => normalizeAddress(poolConfig.address))
  );

  const { liquidationAuctions } = await subgraph.getChainwideLiquidationAuctions(
    config.subgraphUrl,
    DISCOVERY_PAGE_SIZE,
    DISCOVERY_MAX_PAGES
  );

  const settlementCandidates = dedupeCandidates(
    liquidationAuctions
      .filter((candidate) => poolAllowed(config, candidate.pool.id))
      .filter((candidate) => Number(candidate.debtRemaining || '0') > 0)
      .filter((candidate) => {
        const normalizedPool = normalizeAddress(candidate.pool.id);
        if (manualSettlementPools.has(normalizedPool)) {
          logDiscoverySkip(
            config,
            `settlement discovery ignored ${normalizedPool} because manual settlement config wins`
          );
          return false;
        }
        return true;
      })
      .map((candidate) =>
        hydrateCandidate(candidate, computeSettlementHeuristicScore(candidate))
      )
  );

  const grouped = groupCandidatesByPool(settlementCandidates);
  const groupedEntries = Array.from(grouped.entries()).sort(
    ([, leftCandidates], [, rightCandidates]) =>
      candidateGroupScore(rightCandidates) - candidateGroupScore(leftCandidates)
  );
  const maxPoolsPerRun = autoDiscover.maxPoolsPerRun ?? groupedEntries.length;

  const targets: ResolvedSettlementTarget[] = [];
  for (const [poolAddress, candidates] of groupedEntries.slice(0, maxPoolsPerRun)) {
    const manualPool = poolIndex.get(poolAddress);
    const settlementConfig =
      manualPool?.settlement ?? config.discoveredDefaults?.settlement;
    if (!settlementConfig?.enabled) {
      logDiscoverySkip(
        config,
        `settlement discovery found ${poolAddress} but no enabled discoveredDefaults.settlement was configured`
      );
      continue;
    }

    const target: ResolvedSettlementTarget = {
      source: 'discovered',
      poolAddress,
      name: manualPool?.name ?? `discovered:${poolAddress}`,
      dryRun: !!config.dryRun || !!autoDiscover.dryRunNewPools,
      settlement: settlementConfig,
      candidates,
    };

    validateResolvedSettlementTarget(target);
    targets.push(target);
  }

  return targets;
}

export function validateResolvedTakeTarget(
  target: ResolvedTakeTarget,
  config: KeeperConfig
): void {
  if (!ethers.utils.isAddress(target.poolAddress)) {
    throw new Error(`ResolvedTakeTarget: invalid pool address ${target.poolAddress}`);
  }
  if (target.candidates.length === 0) {
    throw new Error(`ResolvedTakeTarget: no candidates for ${target.poolAddress}`);
  }
  validateTakeSettings(target.take, config);
}

export function validateResolvedSettlementTarget(
  target: ResolvedSettlementTarget
): void {
  if (!ethers.utils.isAddress(target.poolAddress)) {
    throw new Error(
      `ResolvedSettlementTarget: invalid pool address ${target.poolAddress}`
    );
  }
  if (target.candidates.length === 0) {
    throw new Error(
      `ResolvedSettlementTarget: no candidates for ${target.poolAddress}`
    );
  }
  validateSettlementSettings(target.settlement);
}

export async function ensurePoolLoaded(params: {
  ajna: AjnaSDK;
  poolMap: PoolMap;
  poolAddress: Address;
  config: KeeperConfig;
  hydrationCooldowns: PoolHydrationCooldowns;
}): Promise<FungiblePool | undefined> {
  const normalizedPool = normalizeAddress(params.poolAddress);
  const cachedPool = getCachedPool(params.poolMap, params.poolAddress);
  if (cachedPool) {
    return cachedPool;
  }

  const cooldownUntil = params.hydrationCooldowns.get(normalizedPool);
  if (cooldownUntil !== undefined && cooldownUntil > Date.now()) {
    logger.debug(
      `Skipping hydration for ${normalizedPool} until ${new Date(
        cooldownUntil
      ).toISOString()}`
    );
    return undefined;
  }

  try {
    const pool = await params.ajna.fungiblePoolFactory.getPoolByAddress(
      params.poolAddress
    );
    overrideMulticall(pool, params.config);
    cachePool(params.poolMap, params.poolAddress, pool);
    return pool;
  } catch (error) {
    const cooldownSeconds =
      params.config.autoDiscover?.hydrateCooldownSec ?? params.config.delayBetweenRuns;
    params.hydrationCooldowns.set(
      normalizedPool,
      Date.now() + cooldownSeconds * 1000
    );
    logger.error(`Failed to hydrate discovered pool ${normalizedPool}`, error);
    return undefined;
  }
}

export function cacheConfiguredPool(
  poolMap: PoolMap,
  poolConfig: PoolConfig,
  pool: FungiblePool
): void {
  cachePool(poolMap, poolConfig.address, pool);
}
