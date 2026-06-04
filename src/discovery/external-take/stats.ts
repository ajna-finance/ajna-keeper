import { ExternalTakePathKind, LiquiditySource } from '../../config';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import {
  isFactoryExternalTakeRoute,
  isOneInchExternalTakeRoute,
  resolveExternalTakePathFromEvaluation,
  resolveExternalTakeRouteIdentity,
} from '../../take/external-take/route';

export interface ExternalTakePathCounters {
  approved: number;
  executed: number;
  dryRun: number;
  preBroadcastFailures: number;
  postSubmissionFailures: number;
}

export interface DiscoveredTakeTargetStats {
  candidateCount: number;
  approvedTakeDecisions: number;
  approvedArbTakeDecisions: number;
  approvedOneInchTakeDecisions: number;
  approvedFactoryTakeDecisions: number;
  approvedUniswapV3TakeDecisions: number;
  approvedSushiswapTakeDecisions: number;
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
  executedOneInchTakes: number;
  executedFactoryTakes: number;
  executedUniswapV3Takes: number;
  executedSushiswapTakes: number;
  executedCurveTakes: number;
  dryRunExternalTakes: number;
  dryRunArbTakes: number;
  dryRunOneInchTakes: number;
  dryRunFactoryTakes: number;
  dryRunUniswapV3Takes: number;
  dryRunSushiswapTakes: number;
  dryRunCurveTakes: number;
  oneInchSwapDataFailures: number;
  oneInchPreBroadcastFailures: number;
  oneInchPostSubmissionFailures: number;
  factoryPreBroadcastFailures: number;
  factoryPostSubmissionFailures: number;
  externalTakeByPath: Partial<
    Record<ExternalTakePathKind, ExternalTakePathCounters>
  >;
  hybridFallbackAttempts: number;
  hybridFallbackSuccesses: number;
  hybridGasQuoteFallbackAttempts: number;
  hybridGasQuoteFallbackSuccesses: number;
  hotAuctionCandidateRemovals: number;
}

type ExecutedExternalTakeRouteStats = Pick<
  DiscoveredTakeTargetStats,
  | 'executedOneInchTakes'
  | 'executedFactoryTakes'
  | 'executedUniswapV3Takes'
  | 'executedSushiswapTakes'
  | 'executedCurveTakes'
>;

export type ExternalTakeRouteStatKey =
  | 'approvedOneInchTakeDecisions'
  | 'approvedFactoryTakeDecisions'
  | 'approvedUniswapV3TakeDecisions'
  | 'approvedSushiswapTakeDecisions'
  | 'approvedCurveTakeDecisions'
  | keyof ExecutedExternalTakeRouteStats
  | 'dryRunOneInchTakes'
  | 'dryRunFactoryTakes'
  | 'dryRunUniswapV3Takes'
  | 'dryRunSushiswapTakes'
  | 'dryRunCurveTakes';

export interface ExternalTakeRouteStatKeys {
  oneInch: ExternalTakeRouteStatKey;
  factory: ExternalTakeRouteStatKey;
  uniswapV3: ExternalTakeRouteStatKey;
  sushiswap: ExternalTakeRouteStatKey;
  curve: ExternalTakeRouteStatKey;
}

export type ExternalTakeRouteCounterStats = Pick<
  DiscoveredTakeTargetStats,
  ExternalTakeRouteStatKey | 'externalTakeByPath'
>;

export type ExternalTakePathCounterField = keyof ExternalTakePathCounters;

export const APPROVED_EXTERNAL_TAKE_ROUTE_STAT_KEYS: ExternalTakeRouteStatKeys =
  {
    oneInch: 'approvedOneInchTakeDecisions',
    factory: 'approvedFactoryTakeDecisions',
    uniswapV3: 'approvedUniswapV3TakeDecisions',
    sushiswap: 'approvedSushiswapTakeDecisions',
    curve: 'approvedCurveTakeDecisions',
  };

const EXECUTED_EXTERNAL_TAKE_ROUTE_STAT_KEYS: ExternalTakeRouteStatKeys = {
  oneInch: 'executedOneInchTakes',
  factory: 'executedFactoryTakes',
  uniswapV3: 'executedUniswapV3Takes',
  sushiswap: 'executedSushiswapTakes',
  curve: 'executedCurveTakes',
};

const DRY_RUN_EXTERNAL_TAKE_ROUTE_STAT_KEYS: ExternalTakeRouteStatKeys = {
  oneInch: 'dryRunOneInchTakes',
  factory: 'dryRunFactoryTakes',
  uniswapV3: 'dryRunUniswapV3Takes',
  sushiswap: 'dryRunSushiswapTakes',
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

export function recordExternalTakePathFailureStats(params: {
  stats: Pick<
    DiscoveredTakeTargetStats,
    | 'externalTakeByPath'
    | 'oneInchPreBroadcastFailures'
    | 'oneInchPostSubmissionFailures'
    | 'factoryPreBroadcastFailures'
    | 'factoryPostSubmissionFailures'
  >;
  path: ExternalTakePathKind;
  preBroadcast: boolean;
}): void {
  const field = params.preBroadcast
    ? 'preBroadcastFailures'
    : 'postSubmissionFailures';
  const pathCounters = getExternalTakePathCounters(params.stats, params.path);
  pathCounters[field] += 1;

  if (params.path === 'oneinch') {
    if (params.preBroadcast) {
      params.stats.oneInchPreBroadcastFailures += 1;
    } else {
      params.stats.oneInchPostSubmissionFailures += 1;
    }
    return;
  }

  if (params.path === 'factory') {
    if (params.preBroadcast) {
      params.stats.factoryPreBroadcastFailures += 1;
    } else {
      params.stats.factoryPostSubmissionFailures += 1;
    }
  }
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
  if (isOneInchExternalTakeRoute(quoteEvaluation)) {
    stats[keys.oneInch] += 1;
  }
  if (isFactoryExternalTakeRoute(quoteEvaluation)) {
    stats[keys.factory] += 1;
  }

  switch (routeIdentity?.source) {
    case LiquiditySource.UNISWAPV3:
      stats[keys.uniswapV3] += 1;
      break;
    case LiquiditySource.SUSHISWAP:
      stats[keys.sushiswap] += 1;
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
