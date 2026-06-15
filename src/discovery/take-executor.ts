import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  CALLDATA_AGGREGATOR_PROVIDER_IDS,
  ExternalTakePathKind,
  LiquiditySource,
  LiquiditySourceMap,
  TakeWriteTransportMode,
  formatLiquiditySource,
  getAutoDiscoverTakePolicy,
  resolveExternalTakePolicy,
} from '../config';
import { ResolvedTakeTarget } from './targets';
import {
  DiscoveryExternalExecutionConfig,
  withTakeLiquiditySource,
} from './external-take/provider';
import { logger } from '../logging';
import {
  createDiscoveryTransportsForConfig,
  evaluateGasPolicy,
  getDiscoveryGasPriceFreshnessTtlMs,
  getEffectiveL2GasCostBufferBasisPoints,
  logDiscoveryDecision,
} from './gas-policy';
import {
  DiscoveryExecutionConfig,
  DiscoveryExecutionTransportConfig,
  DiscoveryRpcCache,
} from './types';
import { DiscoveryReadTransports } from '../read-transports';
import { createArbTakeStrategy } from '../take/arb-strategy';
import { processTakeCandidates, TAKE_SKIP_REASONS } from '../take/engine';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../take/external-take/execution-plan';
import { TakeWriteTransport } from '../take/write-transport';
import { DirectDexRouteProfitabilityContext } from '../take/direct-dex';
import {
  prewarmDirectDexRouteAvailability,
  withDirectDexRuntimeStats,
} from '../take/direct-dex/route-selection';
import {
  AsyncOperationLimiter,
  RouteProbeLimiter,
  decimaledToWei,
  getErrorMessage,
  withTimeout,
} from '../utils';
import { getDecimalsErc20 } from '../erc20';
import { createTakeAuctionStatusReader } from '../take/liquidation-status';
import type { TakeDecision } from '../take/types';
import { createDiscoveryRpcCache } from './rpc-cache';
import { getOneInchQuoteTimeoutMs } from './external-take/one-inch-circuit';
import { reapproveDiscoveryExternalTakeForAuction } from './external-take/final-approval';
import { createDiscoveredTakeTargetRuntime } from './discovered-take-target-runtime';
import { AutoDiscoverTakePolicyRuntime } from './external-take/quotes';
import {
  APPROVED_EXTERNAL_TAKE_ROUTE_STAT_KEYS,
  type CalldataAggregatorProviderCounters,
  type DiscoveredTakeTargetStats,
  type ExternalTakePathCounterField,
  getCalldataAggregatorProviderCounter,
  getExternalTakePathCounter,
  incrementExternalTakeRouteStats,
} from './external-take/stats';
import { ZERO_BN } from '../constants';
import {
  getExternalTakeGasLimit,
  refreshDiscoveryGasPriceIfStale,
} from './external-take/approval-policy';
import { DiscoveryExternalTakeApprovalContext } from './external-take/approval';

export type { DiscoveredTakeTargetStats } from './external-take/stats';
export { refreshDiscoveryGasPriceIfStale } from './external-take/approval-policy';

const ARB_TAKE_GAS_LIMIT = BigNumber.from(450000);
const ZERO = ZERO_BN;
const DEFAULT_EXTERNAL_TAKE_PROBE_RPC_BUDGET_MS = 1_000;
const MAX_DEFAULT_EXTERNAL_TAKE_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_IN_FLIGHT_ROUTE_PROBES = 3;
const MIN_ROUTE_PROBE_HARD_CAP_EXTRA_MS = 1_000;

function getExternalTakeProbeTimeoutMs(
  takePolicy: AutoDiscoverTakePolicyRuntime
): number {
  if (takePolicy?.externalTakeProbeTimeoutMs !== undefined) {
    return takePolicy.externalTakeProbeTimeoutMs;
  }
  return Math.min(
    getOneInchQuoteTimeoutMs(takePolicy) +
      DEFAULT_EXTERNAL_TAKE_PROBE_RPC_BUDGET_MS,
    MAX_DEFAULT_EXTERNAL_TAKE_PROBE_TIMEOUT_MS
  );
}

function getMaxConcurrentCandidateEvaluations(
  takePolicy: AutoDiscoverTakePolicyRuntime
): number {
  const configured = takePolicy?.maxConcurrentCandidateEvaluations;
  return configured !== undefined && Number.isFinite(configured)
    ? Math.max(1, Math.floor(configured))
    : 1;
}

function getMaxExecutionsPerPoolPerRun(
  takePolicy: AutoDiscoverTakePolicyRuntime
): number {
  const configured = takePolicy?.maxExecutionsPerPoolPerRun;
  return configured !== undefined && Number.isFinite(configured)
    ? Math.max(1, Math.floor(configured))
    : 1;
}

function getMaxInFlightRouteProbes(
  takePolicy: AutoDiscoverTakePolicyRuntime
): number {
  const configured = takePolicy?.maxInFlightRouteProbes;
  return configured !== undefined && Number.isFinite(configured)
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_MAX_IN_FLIGHT_ROUTE_PROBES;
}

function incrementDiscoveryRouteProbeAbandonedCount(
  rpcCache?: DiscoveryRpcCache
): void {
  if (!rpcCache?.stats) {
    return;
  }
  rpcCache.stats.routeProbeAbandonedCount =
    (rpcCache.stats.routeProbeAbandonedCount ?? 0) + 1;
}

function createDiscoveryRouteProbeLimiter(params: {
  takePolicy: AutoDiscoverTakePolicyRuntime;
  rpcCache?: DiscoveryRpcCache;
  candidateEvaluationConcurrency: number;
}): AsyncOperationLimiter | undefined {
  if (params.candidateEvaluationConcurrency <= 1) {
    return undefined;
  }
  const maxInFlightRouteProbes = getMaxInFlightRouteProbes(params.takePolicy);
  const probeTimeoutMs = getExternalTakeProbeTimeoutMs(params.takePolicy);
  const hardPermitHoldMs = Math.max(
    probeTimeoutMs * 2,
    probeTimeoutMs + MIN_ROUTE_PROBE_HARD_CAP_EXTRA_MS
  );
  return new RouteProbeLimiter({
    maxConcurrent: maxInFlightRouteProbes,
    maxAbandoned: maxInFlightRouteProbes * 2,
    hardPermitHoldMs,
    onAbandoned: (label, error) => {
      incrementDiscoveryRouteProbeAbandonedCount(params.rpcCache);
      logger.debug(
        `Discovery route probe limiter abandoned ${label}: ${error.message}`
      );
    },
  });
}

function getDiscoveryTokenDecimalsCache(
  rpcCache?: DiscoveryRpcCache
): Map<string, number> | undefined {
  if (!rpcCache?.directDexQuoteProviders) {
    return undefined;
  }
  rpcCache.directDexQuoteProviders.tokenDecimals ??= new Map();
  return rpcCache.directDexQuoteProviders.tokenDecimals;
}

async function buildDirectDexRouteProfitabilityContext(params: {
  pool: FungiblePool;
  signer: Signer;
  config: DiscoveryExecutionConfig;
  transports: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
  defaultLiquiditySource: LiquiditySource | undefined;
  sources?: LiquiditySource[];
  allowSubsidy?: boolean;
  takePolicy: ReturnType<typeof getAutoDiscoverTakePolicy>;
}): Promise<DirectDexRouteProfitabilityContext | undefined> {
  const sources =
    params.sources ??
    Array.from(
      resolveExternalTakePolicy({
        defaultLiquiditySource: params.defaultLiquiditySource,
        takePolicy: params.takePolicy,
      }).directDexRouteSources
    );
  const requiresRouteGasRanking = sources.length > 1;
  const requiresQuoteProfitability =
    params.takePolicy?.minExpectedProfitQuote !== undefined ||
    params.takePolicy?.minProfitNative !== undefined;

  if (!requiresRouteGasRanking && !requiresQuoteProfitability) {
    return undefined;
  }

  await refreshDiscoveryGasPriceIfStale({
    rpcCache: params.rpcCache,
    transports: params.transports,
    maxAgeMs: getDiscoveryGasPriceFreshnessTtlMs(
      params.takePolicy,
      params.rpcCache?.chainId
    ),
  });

  const quoteTokenDecimals = await getDecimalsErc20(
    params.signer,
    params.pool.quoteAddress,
    params.rpcCache?.chainId
  );
  const configuredProfitFloorQuoteRaw =
    params.takePolicy?.minExpectedProfitQuote !== undefined
      ? decimaledToWei(
          params.takePolicy.minExpectedProfitQuote,
          quoteTokenDecimals
        )
      : ZERO;
  const routeExecutionCostQuoteRawBySource: LiquiditySourceMap<BigNumber> = {};
  const routeGasLimitBySource: LiquiditySourceMap<BigNumber> = {};
  const nativeProfitFloorQuoteRawBySource: LiquiditySourceMap<BigNumber> = {};
  const routeRejectionReasonsBySource: LiquiditySourceMap<string> = {};
  const gasPolicyRejectCodeBySource: DirectDexRouteProfitabilityContext['gasPolicyRejectCodeBySource'] =
    {};
  const gasQuoteAttemptsBySource: DirectDexRouteProfitabilityContext['gasQuoteAttemptsBySource'] =
    {};
  const gasPriceFetchedAt = params.rpcCache?.gasPriceFetchedAt;
  const gasPriceAgeMs =
    gasPriceFetchedAt !== undefined
      ? Date.now() - gasPriceFetchedAt
      : undefined;
  const gasPriceFreshnessTtlMs = getDiscoveryGasPriceFreshnessTtlMs(
    params.takePolicy,
    params.rpcCache?.chainId
  );
  const gasPolicyEvaluatedAt = Date.now();

  for (const source of sources) {
    const routeGasLimit = getExternalTakeGasLimit(params.takePolicy, source);
    const gasPolicy = await evaluateGasPolicy({
      signer: params.signer,
      config: params.config,
      transports: params.transports,
      policy: {
        ...params.takePolicy,
        minExpectedProfitQuote:
          params.takePolicy?.minExpectedProfitQuote ??
          (requiresRouteGasRanking ? 0 : undefined),
      },
      gasLimit: routeGasLimit,
      quoteTokenAddress: params.pool.quoteAddress,
      preferredLiquiditySource: source,
      useProfitFloor: true,
      gasPrice: params.rpcCache?.gasPrice,
      chainId: params.rpcCache?.chainId,
      rpcCache: params.rpcCache,
    });

    if (!gasPolicy.approved) {
      if (requiresRouteGasRanking) {
        logger.warn(
          `Rejecting route source ${formatLiquiditySource(source)} because quote-denominated gas conversion failed: ${gasPolicy.reason ?? 'route gas policy rejected source'}`
        );
      }
      routeRejectionReasonsBySource[source] =
        gasPolicy.reason ?? 'route gas policy rejected source';
      if (gasPolicy.rejectCode) {
        gasPolicyRejectCodeBySource[source] = gasPolicy.rejectCode;
      }
      if (gasPolicy.gasQuoteAttempts) {
        gasQuoteAttemptsBySource[source] = gasPolicy.gasQuoteAttempts;
      }
      continue;
    }

    routeExecutionCostQuoteRawBySource[source] =
      gasPolicy.gasCostQuoteRaw ?? ZERO;
    routeGasLimitBySource[source] = routeGasLimit;
    if (gasPolicy.minProfitNativeQuoteRaw) {
      nativeProfitFloorQuoteRawBySource[source] =
        gasPolicy.minProfitNativeQuoteRaw;
    }
  }

  return {
    routeExecutionCostQuoteRawBySource,
    routeGasLimitBySource,
    nativeProfitFloorQuoteRawBySource,
    configuredProfitFloorQuoteRaw,
    allowSubsidy: params.allowSubsidy === true,
    routeRejectionReasonsBySource,
    gasPolicyRejectCodeBySource,
    gasQuoteAttemptsBySource,
    gasPriceWei: params.rpcCache?.gasPrice,
    gasPriceGwei:
      params.rpcCache?.gasPrice !== undefined
        ? Number(ethers.utils.formatUnits(params.rpcCache.gasPrice, 'gwei'))
        : undefined,
    gasPriceAgeMs,
    gasPriceFreshnessTtlMs,
    l2GasCostBufferBasisPoints: getEffectiveL2GasCostBufferBasisPoints(
      params.takePolicy,
      params.rpcCache?.chainId
    ),
    gasPolicyEvaluatedAt,
  };
}

interface HandleDiscoveredTakeTargetParamsBase {
  pool: FungiblePool;
  signer: Signer;
  takeWriteTransport?: TakeWriteTransport;
  target: ResolvedTakeTarget;
  rpcCache?: DiscoveryRpcCache;
  onExecutionAttempt?: (
    decision: TakeDecision<DiscoveryExternalTakeApprovalContext>
  ) => void;
  onExecuted?: (params: {
    decision: TakeDecision<DiscoveryExternalTakeApprovalContext>;
    executedTake: boolean;
    executedArbTake: boolean;
  }) => void;
  onSkip?: (params: {
    candidate: {
      poolAddress: string;
      borrower: string;
    };
    stage: 'evaluation' | 'revalidation' | 'execution';
    reason: string;
    decision?: TakeDecision<DiscoveryExternalTakeApprovalContext>;
  }) => void;
  onCandidateInactive?: (candidate: {
    poolAddress: string;
    borrower: string;
  }) => boolean | void;
}

export type HandleDiscoveredTakeTargetParams =
  | (HandleDiscoveredTakeTargetParamsBase & {
      config: DiscoveryExecutionTransportConfig;
      transports?: DiscoveryReadTransports;
    })
  | (HandleDiscoveredTakeTargetParamsBase & {
      config: DiscoveryExecutionConfig;
      transports: DiscoveryReadTransports;
    });

function hasDiscoveryTransportConfig(
  config: DiscoveryExecutionConfig | DiscoveryExecutionTransportConfig
): config is DiscoveryExecutionTransportConfig {
  return (
    'ethRpcUrl' in config &&
    typeof config.ethRpcUrl === 'string' &&
    'subgraphUrl' in config &&
    typeof config.subgraphUrl === 'string'
  );
}

function logDiscoveredTakeTargetSummary(params: {
  pool: FungiblePool;
  target: ResolvedTakeTarget;
  stats: DiscoveredTakeTargetStats;
}): void {
  const stats = params.stats;
  const appendNonZeroField = (
    fields: string[],
    name: string,
    value: number
  ): void => {
    if (value !== 0) {
      fields.push(`${name}=${value}`);
    }
  };
  const appendNonZeroGroup = (
    fields: string[],
    name: string,
    entries: Array<{ label: string; value: number }>
  ): void => {
    const nonZeroEntries = entries.filter((entry) => entry.value !== 0);
    if (nonZeroEntries.length === 0) {
      return;
    }
    fields.push(
      `${name}=${nonZeroEntries
        .map((entry) => `${entry.label}:${entry.value}`)
        .join(',')}`
    );
  };
  const getPathStat = (
    path: ExternalTakePathKind,
    field: ExternalTakePathCounterField
  ): number =>
    getExternalTakePathCounter({
      stats,
      path,
      field,
    });
  const getProviderStat = (
    providerId: (typeof CALLDATA_AGGREGATOR_PROVIDER_IDS)[number],
    field: keyof CalldataAggregatorProviderCounters
  ): number =>
    getCalldataAggregatorProviderCounter({
      stats,
      providerId,
      field,
    });
  const getProviderGroup = (field: keyof CalldataAggregatorProviderCounters) =>
    CALLDATA_AGGREGATOR_PROVIDER_IDS.map((providerId) => ({
      label: providerId,
      value: getProviderStat(providerId, field),
    }));
  const fields = [
    `pool=${params.pool.poolAddress}`,
    `name="${params.target.name}"`,
    `source=${params.target.take.liquiditySource ?? 'none'}`,
    `dryRun=${params.target.dryRun}`,
    `candidates=${stats.candidateCount}`,
    `approvedTakeDecisions=${stats.approvedTakeDecisions}`,
    `approvedArbTakeDecisions=${stats.approvedArbTakeDecisions}`,
    `evaluationSkips=${stats.evaluationSkips}`,
    `revalidationSkips=${stats.revalidationSkips}`,
    `executionSkips=${stats.executionSkips}`,
    `gasPolicyRejects=${stats.gasPolicyRejects}`,
    `profitFloorRejects=${stats.profitFloorRejects}`,
    `arbProfitUnavailableRejects=${stats.arbProfitUnavailableRejects}`,
    `executedExternalTakes=${stats.executedExternalTakes}`,
    `executedArbTakes=${stats.executedArbTakes}`,
  ];
  appendNonZeroField(fields, 'dryRunExternalTakes', stats.dryRunExternalTakes);
  appendNonZeroField(fields, 'dryRunArbTakes', stats.dryRunArbTakes);
  appendNonZeroGroup(fields, 'approvedRoutes', [
    { label: 'direct_dex', value: getPathStat('direct_dex', 'approved') },
    {
      label: 'calldata_aggregator',
      value: getPathStat('calldata_aggregator', 'approved'),
    },
  ]);
  appendNonZeroGroup(fields, 'approvedDirectDexSources', [
    { label: 'uniswapV3', value: stats.approvedUniswapV3TakeDecisions },
    { label: 'curve', value: stats.approvedCurveTakeDecisions },
  ]);
  appendNonZeroGroup(
    fields,
    'approvedCalldataAggregatorProviders',
    getProviderGroup('approved')
  );
  appendNonZeroGroup(fields, 'executedRoutes', [
    { label: 'direct_dex', value: getPathStat('direct_dex', 'executed') },
    {
      label: 'calldata_aggregator',
      value: getPathStat('calldata_aggregator', 'executed'),
    },
  ]);
  appendNonZeroGroup(fields, 'executedDirectDexSources', [
    { label: 'uniswapV3', value: stats.executedUniswapV3Takes },
    { label: 'curve', value: stats.executedCurveTakes },
  ]);
  appendNonZeroGroup(
    fields,
    'executedCalldataAggregatorProviders',
    getProviderGroup('executed')
  );
  appendNonZeroGroup(fields, 'dryRunRoutes', [
    { label: 'direct_dex', value: getPathStat('direct_dex', 'dryRun') },
    {
      label: 'calldata_aggregator',
      value: getPathStat('calldata_aggregator', 'dryRun'),
    },
  ]);
  appendNonZeroGroup(fields, 'dryRunDirectDexSources', [
    { label: 'uniswapV3', value: stats.dryRunUniswapV3Takes },
    { label: 'curve', value: stats.dryRunCurveTakes },
  ]);
  appendNonZeroGroup(
    fields,
    'dryRunCalldataAggregatorProviders',
    getProviderGroup('dryRun')
  );
  appendNonZeroGroup(fields, 'directDexFailures', [
    { label: 'preBroadcast', value: getPathStat('direct_dex', 'preBroadcastFailures') },
    { label: 'postSubmission', value: getPathStat('direct_dex', 'postSubmissionFailures') },
  ]);
  appendNonZeroGroup(fields, 'calldataAggregatorFailures', [
    {
      label: 'preBroadcast',
      value: getPathStat('calldata_aggregator', 'preBroadcastFailures'),
    },
    {
      label: 'postSubmission',
      value: getPathStat('calldata_aggregator', 'postSubmissionFailures'),
    },
  ]);
  appendNonZeroGroup(
    fields,
    'calldataAggregatorProviderFailures',
    CALLDATA_AGGREGATOR_PROVIDER_IDS.flatMap((providerId) => [
      {
        label: `${providerId}.quote`,
        value: getProviderStat(providerId, 'quoteFailures'),
      },
      {
        label: `${providerId}.preBroadcast`,
        value: getProviderStat(providerId, 'preBroadcastFailures'),
      },
      {
        label: `${providerId}.postSubmission`,
        value: getProviderStat(providerId, 'postSubmissionFailures'),
      },
    ])
  );
  appendNonZeroField(
    fields,
    'hybridFallbackAttempts',
    stats.hybridFallbackAttempts
  );
  appendNonZeroField(
    fields,
    'hybridFallbackSuccesses',
    stats.hybridFallbackSuccesses
  );
  appendNonZeroField(
    fields,
    'hybridGasQuoteFallbackAttempts',
    stats.hybridGasQuoteFallbackAttempts
  );
  appendNonZeroField(
    fields,
    'hybridGasQuoteFallbackSuccesses',
    stats.hybridGasQuoteFallbackSuccesses
  );
  appendNonZeroField(
    fields,
    'hotAuctionCandidateRemovals',
    stats.hotAuctionCandidateRemovals
  );
  logger.info(`Discovered take target summary: ${fields.join(' ')}`);
}

const INACTIVE_AUCTION_SKIP_REASONS = new Set<string>([
  TAKE_SKIP_REASONS.auctionInactive,
  TAKE_SKIP_REASONS.auctionStateChanged,
  TAKE_SKIP_REASONS.quoteCollateralMismatch,
  TAKE_SKIP_REASONS.quoteAuctionPriceStale,
]);

function isInactiveAuctionSkipReason(reason: string): boolean {
  return INACTIVE_AUCTION_SKIP_REASONS.has(reason);
}

function isPrivateOrRelayTakeWriteTransport(
  transport: TakeWriteTransport | undefined
): boolean {
  return (
    transport?.mode === TakeWriteTransportMode.PRIVATE_RPC ||
    transport?.mode === TakeWriteTransportMode.RELAY
  );
}

function enforceExternalTakeTransportPolicy(params: {
  target: ResolvedTakeTarget;
  takeWriteTransport?: TakeWriteTransport;
  takePolicy: ReturnType<typeof getAutoDiscoverTakePolicy>;
}): boolean {
  if (
    params.target.dryRun ||
    params.target.take.marketPriceFactor === undefined
  ) {
    return true;
  }

  const policy =
    params.takePolicy?.externalTakeTransportPolicy ?? 'allow_public';
  if (policy === 'allow_public') {
    return true;
  }

  const hasPrivateOrRelay = isPrivateOrRelayTakeWriteTransport(
    params.takeWriteTransport
  );
  if (hasPrivateOrRelay) {
    return true;
  }

  const message = `Discovered external take target ${params.target.poolAddress} is using public RPC write fallback while externalTakeTransportPolicy=${policy}`;
  if (policy === 'require_private_or_relay') {
    logger.warn(`${message}; skipping target`);
    return false;
  }

  logger.warn(
    `${message}; continuing because policy only prefers private/relay`
  );
  return true;
}

export async function handleDiscoveredTakeTarget(
  params: HandleDiscoveredTakeTargetParams
): Promise<DiscoveredTakeTargetStats> {
  const transports = params.transports
    ? params.transports
    : hasDiscoveryTransportConfig(params.config)
      ? createDiscoveryTransportsForConfig(params.config, params.signer)
      : (() => {
          throw new Error(
            'Discovered take target requires transports when config omits read transport settings'
          );
        })();
  const stats: DiscoveredTakeTargetStats = {
    candidateCount: params.target.candidates.length,
    approvedTakeDecisions: 0,
    approvedArbTakeDecisions: 0,
    approvedUniswapV3TakeDecisions: 0,
    approvedCurveTakeDecisions: 0,
    evaluationSkips: 0,
    revalidationSkips: 0,
    executionSkips: 0,
    gasPolicyRejects: 0,
    profitFloorRejects: 0,
    arbProfitUnavailableRejects: 0,
    executedExternalTakes: 0,
    executedArbTakes: 0,
    executedUniswapV3Takes: 0,
    executedCurveTakes: 0,
    dryRunExternalTakes: 0,
    dryRunArbTakes: 0,
    dryRunUniswapV3Takes: 0,
    dryRunCurveTakes: 0,
    externalTakeByPath: {},
    externalTakeByProvider: {},
    hybridFallbackAttempts: 0,
    hybridFallbackSuccesses: 0,
    hybridGasQuoteFallbackAttempts: 0,
    hybridGasQuoteFallbackSuccesses: 0,
    hotAuctionCandidateRemovals: 0,
  };
  const rpcCache =
    params.rpcCache ??
    (await createDiscoveryRpcCache({
      signer: params.signer,
      readRpc: transports.readRpc,
      includeDirectDexQuoteProviders: true,
    }));
  if (rpcCache) {
    rpcCache.stats ??= {};
    rpcCache.stats.directDex ??= {};
  }
  const takePolicy = getAutoDiscoverTakePolicy(params.config.autoDiscover);
  const maxExecutionsPerPoolPerRun = getMaxExecutionsPerPoolPerRun(takePolicy);
  const maxConcurrentCandidateEvaluations =
    maxExecutionsPerPoolPerRun > 1
      ? 1
      : getMaxConcurrentCandidateEvaluations(takePolicy);
  const routeProbeLimiter = createDiscoveryRouteProbeLimiter({
    takePolicy,
    rpcCache,
    candidateEvaluationConcurrency: maxConcurrentCandidateEvaluations,
  });
  if (
    !enforceExternalTakeTransportPolicy({
      target: params.target,
      takeWriteTransport: params.takeWriteTransport,
      takePolicy,
    })
  ) {
    logDiscoveredTakeTargetSummary({
      pool: params.pool,
      target: params.target,
      stats,
    });
    return stats;
  }
  const externalTakeProbeTimeoutMs = getExternalTakeProbeTimeoutMs(takePolicy);
  const takeAuctionStatusReader = createTakeAuctionStatusReader({
    stats: rpcCache?.stats,
  });
  const runtime = createDiscoveredTakeTargetRuntime({
    pool: params.pool,
    signer: params.signer,
    config: params.config,
    target: params.target,
    transports,
    rpcCache,
    takePolicy,
    takeWriteTransport: params.takeWriteTransport,
    stats,
    routeProbeLimiter,
    takeAuctionStatusReader,
    externalTakeProbeTimeoutMs,
    buildDirectDexRouteProfitabilityContext,
  });
  const {
    externalTakePaths,
    defaultDirectDexLiquiditySource,
    directDexQuoteConfig,
    externalTakeAdapter,
    externalExecutionConfig,
    approveExternalTake,
  } = runtime;

  try {
    const candidates = params.target.candidates.map(({ borrower }) => ({
      borrower,
    }));
    await withDirectDexRuntimeStats(
      rpcCache?.directDexQuoteProviders,
      rpcCache?.stats?.directDex,
      async () => {
        const prewarmDirectDexRoutes =
          externalTakePaths.includes('direct_dex') &&
          defaultDirectDexLiquiditySource !== undefined &&
          candidates.length > 0
            ? prewarmDirectDexRouteAvailability({
                pool: params.pool,
                signer: params.signer,
                poolConfig: withTakeLiquiditySource(
                  params.target,
                  defaultDirectDexLiquiditySource
                ),
                quoteConfig: directDexQuoteConfig,
                routeSelection: {
                  allowedLiquiditySources: takePolicy?.allowedLiquiditySources,
                  routeQuoteBudgetPerCandidate:
                    takePolicy?.takeRouteQuoteBudgetPerCandidate,
                  routeProbeLimiter,
                },
                runtimeCache: rpcCache?.directDexQuoteProviders,
                timeoutMs: Math.min(1_000, externalTakeProbeTimeoutMs),
              })
            : undefined;
        if (prewarmDirectDexRoutes) {
          await prewarmDirectDexRoutes;
        }
        await processTakeCandidates<
          ResolvedTakeTarget,
          DiscoveryExternalExecutionConfig,
          DiscoveryExternalTakeApprovalContext
        >({
          pool: params.pool,
          signer: params.signer,
          poolConfig: params.target,
          candidates,
          stopAfterExecution: maxExecutionsPerPoolPerRun <= 1,
          maxExecutions: maxExecutionsPerPoolPerRun,
          stopAfterAttemptedSubmissionFailure: true,
          maxConcurrentCandidateEvaluations,
          resetExternalTakeAttemptSubmission:
            runtime.resetExternalTakeAttemptSubmission,
          didExternalTakeAttemptSubmission:
            runtime.didExternalTakeAttemptSubmission,
          subgraph: transports.subgraph,
          externalTakeAdapter,
          arbTakeStrategy: createArbTakeStrategy(),
          takeAuctionStatusReader,
          externalExecutionConfig,
          dryRun: params.target.dryRun,
          takeWriteTransport: params.takeWriteTransport,
          revalidateBeforeExecution: true,
          approveExternalTake: async ({
            price,
            auctionPrice,
            collateral,
            debtToCover,
            quoteEvaluation,
            externalTakeApprovalContext,
          }) =>
            approveExternalTake({
              price,
              auctionPrice,
              collateral,
              debtToCover,
              quoteEvaluation,
              externalTakeApprovalContext,
            }),
          reapproveExternalTakeBeforeExecution: async ({
            price,
            auctionPrice,
            collateral,
            debtToCover,
            quoteEvaluation,
            externalTakeApprovalContext,
          }) =>
            await reapproveDiscoveryExternalTakeForAuction({
              approveExternalTake,
              price,
              auctionPrice,
              collateral,
              debtToCover,
              quoteEvaluation,
              externalTakeApprovalContext,
              forceGasRefresh: true,
            }),
          approveArbTake: async () => {
            if (
              takePolicy?.minExpectedProfitQuote !== undefined ||
              takePolicy?.minProfitNative !== undefined
            ) {
              stats.arbProfitUnavailableRejects += 1;
              return {
                approved: false,
                reason:
                  takePolicy?.minProfitNative !== undefined
                    ? `arb-take blocked: minProfitNative=${takePolicy.minProfitNative} requires quote-normalized profit, which is not supported for arb-takes`
                    : `arb-take blocked: minExpectedProfitQuote=${takePolicy?.minExpectedProfitQuote} requires quote-normalized profit, which is not supported for arb-takes`,
              };
            }

            await refreshDiscoveryGasPriceIfStale({
              rpcCache,
              transports,
              maxAgeMs: getDiscoveryGasPriceFreshnessTtlMs(
                takePolicy,
                rpcCache?.chainId
              ),
            });

            const gasPolicy = await evaluateGasPolicy({
              signer: params.signer,
              config: params.config,
              transports,
              policy: takePolicy,
              gasLimit: ARB_TAKE_GAS_LIMIT,
              quoteTokenAddress: params.pool.quoteAddress,
              preferredLiquiditySource: params.target.take.liquiditySource,
              useProfitFloor: false,
              gasPrice: rpcCache?.gasPrice,
              chainId: rpcCache?.chainId,
              rpcCache,
            });
            if (!gasPolicy.approved) {
              stats.gasPolicyRejects += 1;
              return {
                approved: false,
                reason: gasPolicy.reason,
              };
            }

            return { approved: true };
          },
          onExecutionAttempt: (decision) => {
            if (decision.approvedTake) {
              stats.approvedTakeDecisions += 1;
              incrementExternalTakeRouteStats({
                stats,
                quoteEvaluation: getExternalTakeExecutionPlanPrimaryEvaluation(
                  decision.externalTakeExecutionPlan
                ),
                keys: APPROVED_EXTERNAL_TAKE_ROUTE_STAT_KEYS,
                pathCounter: 'approved',
              });
            }
            if (decision.approvedArbTake) {
              stats.approvedArbTakeDecisions += 1;
            }
            params.onExecutionAttempt?.(decision);
          },
          onSkip: ({ candidate, stage, reason, decision }) => {
            params.onSkip?.({
              candidate: {
                poolAddress: params.target.poolAddress,
                borrower: candidate.borrower,
              },
              stage,
              reason,
              decision,
            });
            if (isInactiveAuctionSkipReason(reason)) {
              const removed = params.onCandidateInactive?.({
                poolAddress: params.target.poolAddress,
                borrower: candidate.borrower,
              });
              if (removed === true) {
                stats.hotAuctionCandidateRemovals += 1;
              }
            }
            if (stage === 'revalidation') {
              stats.revalidationSkips += 1;
            } else if (stage === 'execution') {
              stats.executionSkips += 1;
            } else {
              stats.evaluationSkips += 1;
            }
            if (stage === 'revalidation') {
              logDiscoveryDecision(
                params.config,
                `Skipping discovered take execution for ${params.pool.poolAddress}/${candidate.borrower} because ${reason}`
              );
              return;
            }

            logDiscoveryDecision(
              params.config,
              `Skipping discovered take candidate ${params.pool.poolAddress}/${candidate.borrower}: ${reason}`
            );
          },
          onExecuted: ({ decision, executedTake, executedArbTake }) => {
            if (executedTake) {
              if (params.target.dryRun) {
                stats.dryRunExternalTakes += 1;
              } else {
                stats.executedExternalTakes += 1;
              }
            }
            if (executedArbTake) {
              if (params.target.dryRun) {
                stats.dryRunArbTakes += 1;
              } else {
                stats.executedArbTakes += 1;
              }
            }
            params.onExecuted?.({
              decision,
              executedTake,
              executedArbTake,
            });
          },
        });
      }
    );
  } finally {
    logDiscoveredTakeTargetSummary({
      pool: params.pool,
      target: params.target,
      stats,
    });
  }

  return stats;
}
