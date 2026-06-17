import {
  CalldataAggregatorProviderId,
  ExternalTakePathKind,
  LiquiditySource,
} from '../../config';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import {
  resolveExternalTakePathFromEvaluation,
  resolveExternalTakeRouteIdentity,
} from '../../take/external-take/route-binding';
import type { ExternalTakeRouteIdentity } from '../../take/external-take/route-binding';

export interface ExternalTakePathCounters {
  approved: number;
  executed: number;
  dryRun: number;
  preBroadcastFailures: number;
  postSubmissionFailures: number;
}

export interface CalldataAggregatorProviderCounters
  extends ExternalTakePathCounters {
  quoteFailures: number;
}

export interface DiscoveredTakeTargetStats {
  candidateCount: number;
  approvedTakeDecisions: number;
  approvedArbTakeDecisions: number;
  approvedUniswapV3TakeDecisions: number;
  approvedCurveTakeDecisions: number;
  evaluationSkips: number;
  revalidationSkips: number;
  executionSkips: number;
  gasPolicyRejects: number;
  profitFloorRejects: number;
  arbProfitUnavailableRejects: number;
  // Real successful external executions. Dry-run "would execute" outcomes are
  // tracked separately so production counters are not inflated by rehearsals.
  executedExternalTakes: number;
  executedArbTakes: number;
  executedUniswapV3Takes: number;
  executedCurveTakes: number;
  dryRunExternalTakes: number;
  dryRunArbTakes: number;
  dryRunUniswapV3Takes: number;
  dryRunCurveTakes: number;
  externalTakeByPath: Partial<
    Record<ExternalTakePathKind, ExternalTakePathCounters>
  >;
  externalTakeByProvider: Partial<
    Record<CalldataAggregatorProviderId, CalldataAggregatorProviderCounters>
  >;
  hybridFallbackAttempts: number;
  hybridFallbackSuccesses: number;
  hybridGasQuoteFallbackAttempts: number;
  hybridGasQuoteFallbackSuccesses: number;
  hotAuctionCandidateRemovals: number;
}

export type ExternalTakeRouteStatKey =
  | 'approvedUniswapV3TakeDecisions'
  | 'approvedCurveTakeDecisions'
  | 'executedUniswapV3Takes'
  | 'executedCurveTakes'
  | 'dryRunUniswapV3Takes'
  | 'dryRunCurveTakes';

export interface ExternalTakeRouteStatKeys {
  uniswapV3: ExternalTakeRouteStatKey;
  curve: ExternalTakeRouteStatKey;
}

export type ExternalTakeRouteCounterStats = Pick<
  DiscoveredTakeTargetStats,
  ExternalTakeRouteStatKey | 'externalTakeByPath' | 'externalTakeByProvider'
>;

export type ExternalTakePathCounterField = keyof ExternalTakePathCounters;

export const APPROVED_EXTERNAL_TAKE_ROUTE_STAT_KEYS: ExternalTakeRouteStatKeys =
  {
    uniswapV3: 'approvedUniswapV3TakeDecisions',
    curve: 'approvedCurveTakeDecisions',
  };

const EXECUTED_EXTERNAL_TAKE_ROUTE_STAT_KEYS: ExternalTakeRouteStatKeys = {
  uniswapV3: 'executedUniswapV3Takes',
  curve: 'executedCurveTakes',
};

const DRY_RUN_EXTERNAL_TAKE_ROUTE_STAT_KEYS: ExternalTakeRouteStatKeys = {
  uniswapV3: 'dryRunUniswapV3Takes',
  curve: 'dryRunCurveTakes',
};

export function getExternalTakePathCounters(
  stats: Pick<DiscoveredTakeTargetStats, 'externalTakeByPath'>,
  path: ExternalTakePathKind
): ExternalTakePathCounters {
  stats.externalTakeByPath[path] ??= {
    approved: 0,
    executed: 0,
    dryRun: 0,
    preBroadcastFailures: 0,
    postSubmissionFailures: 0,
  };
  return stats.externalTakeByPath[path]!;
}

export function getCalldataAggregatorProviderCounters(
  stats: Pick<DiscoveredTakeTargetStats, 'externalTakeByProvider'>,
  providerId: CalldataAggregatorProviderId
): CalldataAggregatorProviderCounters {
  stats.externalTakeByProvider[providerId] ??= {
    approved: 0,
    executed: 0,
    dryRun: 0,
    preBroadcastFailures: 0,
    postSubmissionFailures: 0,
    quoteFailures: 0,
  };
  return stats.externalTakeByProvider[providerId]!;
}

function incrementExternalTakePathCounter(params: {
  stats: Pick<DiscoveredTakeTargetStats, 'externalTakeByPath'>;
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined;
  field: ExternalTakePathCounterField;
}): void {
  const path = resolveExternalTakePathFromEvaluation(params.quoteEvaluation);
  if (!path) {
    return;
  }
  const counters = getExternalTakePathCounters(params.stats, path);
  counters[params.field] += 1;
}

export function getExternalTakePathCounter(params: {
  stats: Pick<DiscoveredTakeTargetStats, 'externalTakeByPath'>;
  path: ExternalTakePathKind;
  field: ExternalTakePathCounterField;
}): number {
  return params.stats.externalTakeByPath[params.path]?.[params.field] ?? 0;
}

export function getCalldataAggregatorProviderCounter(params: {
  stats: Pick<DiscoveredTakeTargetStats, 'externalTakeByProvider'>;
  providerId: CalldataAggregatorProviderId;
  field: keyof CalldataAggregatorProviderCounters;
}): number {
  return (
    params.stats.externalTakeByProvider[params.providerId]?.[params.field] ?? 0
  );
}

export function recordExternalTakeRouteFailureStats(params: {
  stats: Pick<
    DiscoveredTakeTargetStats,
    'externalTakeByPath' | 'externalTakeByProvider'
  >;
  routeIdentity: ExternalTakeRouteIdentity;
  preBroadcast: boolean;
}): void {
  const field = params.preBroadcast
    ? 'preBroadcastFailures'
    : 'postSubmissionFailures';
  const pathCounters = getExternalTakePathCounters(
    params.stats,
    params.routeIdentity.path
  );
  pathCounters[field] += 1;

  if (params.routeIdentity.path === 'calldata_aggregator') {
    const providerCounters = getCalldataAggregatorProviderCounters(
      params.stats,
      params.routeIdentity.providerId
    );
    providerCounters[field] += 1;
  }
}

export function recordCalldataAggregatorProviderQuoteFailureStats(params: {
  stats: Pick<DiscoveredTakeTargetStats, 'externalTakeByProvider'>;
  routeIdentity: ExternalTakeRouteIdentity;
}): void {
  if (params.routeIdentity.path !== 'calldata_aggregator') {
    return;
  }
  const providerCounters = getCalldataAggregatorProviderCounters(
    params.stats,
    params.routeIdentity.providerId
  );
  providerCounters.quoteFailures += 1;
}

export function incrementExternalTakeRouteStats(params: {
  stats: ExternalTakeRouteCounterStats;
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined;
  keys: ExternalTakeRouteStatKeys;
  pathCounter?: ExternalTakePathCounterField;
}): void {
  const { stats, quoteEvaluation, keys } = params;
  const routeIdentity = resolveExternalTakeRouteIdentity(quoteEvaluation);
  if (params.pathCounter !== undefined) {
    incrementExternalTakePathCounter({
      stats,
      quoteEvaluation,
      field: params.pathCounter,
    });
  }
  if (routeIdentity?.path === 'calldata_aggregator') {
    const providerCounters = getCalldataAggregatorProviderCounters(
      stats,
      routeIdentity.providerId
    );
    if (params.pathCounter !== undefined) {
      providerCounters[params.pathCounter] += 1;
    }
  }

  switch (routeIdentity?.source) {
    case LiquiditySource.UNISWAPV3:
      stats[keys.uniswapV3] += 1;
      break;
    case LiquiditySource.CURVE:
      stats[keys.curve] += 1;
      break;
  }
}

export function recordSuccessfulExternalTakeRouteStats(
  stats: ExternalTakeRouteCounterStats,
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined,
  dryRun: boolean
): void {
  incrementExternalTakeRouteStats({
    stats,
    quoteEvaluation,
    keys: dryRun
      ? DRY_RUN_EXTERNAL_TAKE_ROUTE_STAT_KEYS
      : EXECUTED_EXTERNAL_TAKE_ROUTE_STAT_KEYS,
    pathCounter: dryRun ? 'dryRun' : 'executed',
  });
}
