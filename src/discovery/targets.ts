import { Address, AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { ethers } from 'ethers';
import {
  KeeperConfig,
  PoolConfig,
  SettlementConfig,
  TakeSettings,
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
  hasExternalTakeSettings,
  validateSettlementSettings,
  validateTakeSettings,
} from '../config-types';
import { logger } from '../logging';
import {
  createSubgraphReader,
  SubgraphReader,
  SubgraphTransportConfig,
} from '../read-transports';
import { ChainwideLiquidationAuction } from '../subgraph';
import { overrideMulticall, RequireFields } from '../utils';

const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_MAX_PAGES = 100;
const DISCOVERY_SCAN_CACHE_WINDOW_MS = 1000;

export type PoolMap = Map<string, FungiblePool>;
export type PoolHydrationCooldowns = Map<string, number>;

export interface ManualTakeTarget {
  source: 'manual';
  poolAddress: Address;
  name?: string;
  dryRun: boolean;
  poolConfig: RequireFields<PoolConfig, 'take'>;
}

export interface ManualSettlementTarget {
  source: 'manual';
  poolAddress: Address;
  name?: string;
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

interface SharedDiscoveryScan {
  promise?: Promise<ChainwideLiquidationAuction[]>;
  fetchedAt?: number;
  liquidationAuctions?: ChainwideLiquidationAuction[];
}

const candidateDebtRemainingCache = new WeakMap<
  DiscoveredAuctionCandidate,
  DecimalValue
>();
const candidateTakePriorityCache = new WeakMap<
  DiscoveredAuctionCandidate,
  DecimalValue
>();
const sharedDiscoveryScans = new Map<string, SharedDiscoveryScan>();

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

interface DecimalValue {
  digits: string;
  scale: number;
}

function normalizeIntegerString(value: string): string {
  const normalized = value.replace(/^0+/, '');
  return normalized === '' ? '0' : normalized;
}

function parseDecimalValue(value: string | undefined): DecimalValue {
  const trimmed = (value ?? '0').trim();
  if (trimmed === '') {
    return { digits: '0', scale: 0 };
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [integerPartRaw, fractionalPartRaw = ''] = unsigned.split('.');
  const integerPart = normalizeIntegerString(integerPartRaw || '0');
  let fractionalPart = fractionalPartRaw.replace(/0+$/, '');

  if (integerPart === '0' && fractionalPart === '') {
    return { digits: '0', scale: 0 };
  }

  const digits = normalizeIntegerString(`${integerPart}${fractionalPart}`);
  if (digits === '0') {
    fractionalPart = '';
  }

  return {
    digits: negative ? `-${digits}` : digits,
    scale: fractionalPart.length,
  };
}

function compareIntegerStrings(left: string, right: string): number {
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');
  if (leftNegative !== rightNegative) {
    return leftNegative ? -1 : 1;
  }

  const leftUnsigned = normalizeIntegerString(leftNegative ? left.slice(1) : left);
  const rightUnsigned = normalizeIntegerString(rightNegative ? right.slice(1) : right);
  const multiplier = leftNegative ? -1 : 1;

  if (leftUnsigned.length !== rightUnsigned.length) {
    return leftUnsigned.length > rightUnsigned.length ? multiplier : -multiplier;
  }
  if (leftUnsigned === rightUnsigned) {
    return 0;
  }
  return leftUnsigned > rightUnsigned ? multiplier : -multiplier;
}

function compareDecimalValues(left: DecimalValue, right: DecimalValue): number {
  const targetScale = Math.max(left.scale, right.scale);
  const leftScaled = `${left.digits}${'0'.repeat(targetScale - left.scale)}`;
  const rightScaled = `${right.digits}${'0'.repeat(targetScale - right.scale)}`;
  return compareIntegerStrings(leftScaled, rightScaled);
}

function multiplyIntegerStrings(left: string, right: string): string {
  const leftUnsigned = normalizeIntegerString(left.startsWith('-') ? left.slice(1) : left);
  const rightUnsigned = normalizeIntegerString(right.startsWith('-') ? right.slice(1) : right);
  if (leftUnsigned === '0' || rightUnsigned === '0') {
    return '0';
  }

  const digits = new Array(leftUnsigned.length + rightUnsigned.length).fill(0);
  for (let leftIndex = leftUnsigned.length - 1; leftIndex >= 0; leftIndex--) {
    const leftDigit = Number(leftUnsigned[leftIndex]);
    for (let rightIndex = rightUnsigned.length - 1; rightIndex >= 0; rightIndex--) {
      const rightDigit = Number(rightUnsigned[rightIndex]);
      const offset = leftIndex + rightIndex + 1;
      const total = digits[offset] + leftDigit * rightDigit;
      digits[offset] = total % 10;
      digits[offset - 1] += Math.floor(total / 10);
    }
  }

  for (let index = digits.length - 1; index > 0; index--) {
    const carry = Math.floor(digits[index] / 10);
    if (carry > 0) {
      digits[index] %= 10;
      digits[index - 1] += carry;
    }
  }

  return normalizeIntegerString(digits.join(''));
}

function multiplyDecimalValues(left: DecimalValue, right: DecimalValue): DecimalValue {
  return {
    digits: multiplyIntegerStrings(left.digits, right.digits),
    scale: left.scale + right.scale,
  };
}

function compareCandidateIdentity(left: DiscoveredAuctionCandidate, right: DiscoveredAuctionCandidate): number {
  const poolComparison = normalizeAddress(left.poolAddress).localeCompare(normalizeAddress(right.poolAddress));
  if (poolComparison !== 0) {
    return poolComparison;
  }
  return left.borrower.toLowerCase().localeCompare(right.borrower.toLowerCase());
}

function debtRemainingValue(candidate: DiscoveredAuctionCandidate): DecimalValue {
  const cached = candidateDebtRemainingCache.get(candidate);
  if (cached) {
    return cached;
  }

  const parsed = parseDecimalValue(candidate.debtRemaining);
  candidateDebtRemainingCache.set(candidate, parsed);
  return parsed;
}

function takePriorityValue(candidate: DiscoveredAuctionCandidate): DecimalValue {
  const cached = candidateTakePriorityCache.get(candidate);
  if (cached) {
    return cached;
  }

  const collateralValue = multiplyDecimalValues(
    parseDecimalValue(candidate.collateralRemaining),
    parseDecimalValue(candidate.neutralPrice)
  );
  const debtRemaining = debtRemainingValue(candidate);
  const priority =
    compareDecimalValues(collateralValue, debtRemaining) >= 0
    ? collateralValue
    : debtRemaining;
  candidateTakePriorityCache.set(candidate, priority);
  return priority;
}

function compareTakeCandidates(left: DiscoveredAuctionCandidate, right: DiscoveredAuctionCandidate): number {
  const priorityComparison = compareDecimalValues(
    takePriorityValue(right),
    takePriorityValue(left)
  );
  if (priorityComparison !== 0) {
    return priorityComparison;
  }

  const debtComparison = compareDecimalValues(
    debtRemainingValue(right),
    debtRemainingValue(left)
  );
  if (debtComparison !== 0) {
    return debtComparison;
  }

  const kickTimeComparison = left.kickTime - right.kickTime;
  if (kickTimeComparison !== 0) {
    return kickTimeComparison;
  }

  return compareCandidateIdentity(left, right);
}

function compareSettlementCandidates(
  left: DiscoveredAuctionCandidate,
  right: DiscoveredAuctionCandidate
): number {
  const debtComparison = compareDecimalValues(
    debtRemainingValue(right),
    debtRemainingValue(left)
  );
  if (debtComparison !== 0) {
    return debtComparison;
  }

  const kickTimeComparison = left.kickTime - right.kickTime;
  if (kickTimeComparison !== 0) {
    return kickTimeComparison;
  }

  return compareCandidateIdentity(left, right);
}

function hydrateCandidate(candidate: ChainwideLiquidationAuction): DiscoveredAuctionCandidate {
  return {
    poolAddress: candidate.pool.id,
    borrower: candidate.borrower,
    kickTime: Number(candidate.kickTime || '0') * 1000,
    debtRemaining: candidate.debtRemaining,
    collateralRemaining: candidate.collateralRemaining,
    neutralPrice: candidate.neutralPrice,
    debt: candidate.debt,
    collateral: candidate.collateral,
    // Retained for compatibility with existing tests/fixtures.
    heuristicScore: 0,
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

function compareCandidateGroups(
  leftCandidates: DiscoveredAuctionCandidate[],
  rightCandidates: DiscoveredAuctionCandidate[],
  compareCandidates: (
    left: DiscoveredAuctionCandidate,
    right: DiscoveredAuctionCandidate
  ) => number
): number {
  return compareCandidates(leftCandidates[0], rightCandidates[0]);
}

function discoveryCacheKey(subgraph: SubgraphReader): string {
  return `${subgraph.cacheKey}|${DISCOVERY_PAGE_SIZE}|${DISCOVERY_MAX_PAGES}`;
}

export function clearSharedDiscoveryScans(): void {
  sharedDiscoveryScans.clear();
}

export async function getChainwideLiquidationAuctionsShared(
  config: SubgraphTransportConfig,
  subgraphReader: SubgraphReader = createSubgraphReader(config)
): Promise<ChainwideLiquidationAuction[]> {
  const cacheKey = discoveryCacheKey(subgraphReader);
  const now = Date.now();
  const existing = sharedDiscoveryScans.get(cacheKey);

  if (
    existing?.liquidationAuctions !== undefined &&
    existing.fetchedAt !== undefined &&
    now - existing.fetchedAt <= DISCOVERY_SCAN_CACHE_WINDOW_MS
  ) {
    return existing.liquidationAuctions;
  }

  if (existing?.promise) {
    return existing.promise;
  }

  const promise = subgraphReader
    .getChainwideLiquidationAuctions(
      DISCOVERY_PAGE_SIZE,
      DISCOVERY_MAX_PAGES
    )
    .then(({ liquidationAuctions }) => {
      sharedDiscoveryScans.set(cacheKey, {
        liquidationAuctions,
        fetchedAt: Date.now(),
      });
      return liquidationAuctions;
    })
    .finally(() => {
      const current = sharedDiscoveryScans.get(cacheKey);
      if (current?.promise === promise) {
        if (current.liquidationAuctions !== undefined) {
          sharedDiscoveryScans.set(cacheKey, {
            liquidationAuctions: current.liquidationAuctions,
            fetchedAt: current.fetchedAt,
          });
        } else {
          sharedDiscoveryScans.delete(cacheKey);
        }
      }
    });

  sharedDiscoveryScans.set(cacheKey, {
    promise,
    fetchedAt: existing?.fetchedAt,
    liquidationAuctions: existing?.liquidationAuctions,
  });

  return promise;
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
  config: KeeperConfig,
  liquidationAuctionsInput?: ChainwideLiquidationAuction[],
  subgraphReader: SubgraphReader = createSubgraphReader(config)
): Promise<ResolvedTakeTarget[]> {
  const autoDiscover = config.autoDiscover;
  const takePolicy = getAutoDiscoverTakePolicy(autoDiscover);
  if (!autoDiscover?.enabled || !takePolicy) {
    return [];
  }

  const poolIndex = buildPoolIndex(config);
  const manualTakePools = new Set(
    config.pools
      .filter((poolConfig) => !!poolConfig.take)
      .map((poolConfig) => normalizeAddress(poolConfig.address))
  );

  const liquidationAuctions =
    liquidationAuctionsInput ??
    (await getChainwideLiquidationAuctionsShared(config, subgraphReader));

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
      .map((candidate) => hydrateCandidate(candidate))
  );

  takeCandidates.sort(compareTakeCandidates);

  const discoveredTakeDefaults = config.discoveredDefaults?.take;
  const appliesQuoteBudget =
    discoveredTakeDefaults !== undefined &&
    hasExternalTakeSettings(discoveredTakeDefaults);
  const quoteBudget = appliesQuoteBudget
    ? takePolicy.takeQuoteBudgetPerRun ?? takeCandidates.length
    : takeCandidates.length;
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
      compareCandidateGroups(leftCandidates, rightCandidates, compareTakeCandidates)
  );
  const maxPoolsPerRun = takePolicy.maxPoolsPerRun ?? groupedEntries.length;

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
  config: KeeperConfig,
  liquidationAuctionsInput?: ChainwideLiquidationAuction[],
  subgraphReader: SubgraphReader = createSubgraphReader(config)
): Promise<ResolvedSettlementTarget[]> {
  const autoDiscover = config.autoDiscover;
  const settlementPolicy = getAutoDiscoverSettlementPolicy(autoDiscover);
  if (!autoDiscover?.enabled || !settlementPolicy) {
    return [];
  }

  const poolIndex = buildPoolIndex(config);
  const manualSettlementPools = new Set(
    config.pools
      .filter((poolConfig) => !!poolConfig.settlement?.enabled)
      .map((poolConfig) => normalizeAddress(poolConfig.address))
  );

  const liquidationAuctions =
    liquidationAuctionsInput ??
    (await getChainwideLiquidationAuctionsShared(config, subgraphReader));

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
      .map((candidate) => hydrateCandidate(candidate))
  );

  settlementCandidates.sort(compareSettlementCandidates);

  const grouped = groupCandidatesByPool(settlementCandidates);
  const groupedEntries = Array.from(grouped.entries()).sort(
    ([, leftCandidates], [, rightCandidates]) =>
      compareCandidateGroups(
        leftCandidates,
        rightCandidates,
        compareSettlementCandidates
      )
  );
  const maxPoolsPerRun =
    settlementPolicy.maxPoolsPerRun ?? groupedEntries.length;

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
