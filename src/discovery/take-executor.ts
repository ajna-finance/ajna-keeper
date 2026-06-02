import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  ExternalTakePathKind,
  LiquiditySource,
  LiquiditySourceMap,
  TakeWriteTransportMode,
  formatLiquiditySource,
  getAutoDiscoverTakePolicy,
  resolveFactoryRouteSelectionSources,
} from '../config';
import { ResolvedTakeTarget } from './targets';
import {
  DiscoveryExternalExecutionConfig,
  withTakeLiquiditySource,
} from './external-take-provider';
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
import { TakeWriteTransport } from '../take/write-transport';
import { FactoryRouteProfitabilityContext } from '../take/factory';
import {
  prewarmFactoryRouteAvailability,
  withFactoryRuntimeStats,
} from '../take/factory/shared';
import {
  AsyncOperationLimiter,
  RouteProbeLimiter,
  decimaledToWei,
  getErrorMessage,
  withTimeout,
} from '../utils';
import { getDecimalsErc20 } from '../erc20';
import { createTakeAuctionStatusReader } from '../take/liquidation-status';
import { createDiscoveryRpcCache } from './rpc-cache';
import { getOneInchQuoteTimeoutMs } from './one-inch-circuit';
import { withExternalTakeApprovalContext } from './external-take-evaluation';
import { createDiscoveredTakeTargetRuntime } from './discovered-take-target-runtime';
import { AutoDiscoverTakePolicyRuntime } from './external-take-quotes';
import {
  APPROVED_EXTERNAL_TAKE_ROUTE_STAT_KEYS,
  type DiscoveredTakeTargetStats,
  type ExternalTakePathCounterField,
  getExternalTakePathCounter,
  incrementExternalTakeRouteStats,
} from './external-take-stats';
import { ZERO_BN } from '../constants';
import {
  getExternalTakeGasLimit,
  refreshDiscoveryGasPriceIfStale,
} from './external-take-approval-policy';

export type { DiscoveredTakeTargetStats } from './external-take-stats';
export { refreshDiscoveryGasPriceIfStale } from './external-take-approval-policy';

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
  if (!rpcCache?.factoryQuoteProviders) {
    return undefined;
  }
  rpcCache.factoryQuoteProviders.tokenDecimals ??= new Map();
  return rpcCache.factoryQuoteProviders.tokenDecimals;
}

async function buildFactoryRouteProfitabilityContext(params: {
  pool: FungiblePool;
  signer: Signer;
  config: DiscoveryExecutionConfig;
  transports: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
  defaultLiquiditySource: LiquiditySource | undefined;
  sources?: LiquiditySource[];
  allowSubsidy?: boolean;
  takePolicy: ReturnType<typeof getAutoDiscoverTakePolicy>;
}): Promise<FactoryRouteProfitabilityContext | undefined> {
  const sources =
    params.sources ??
    resolveFactoryRouteSelectionSources({
      defaultLiquiditySource: params.defaultLiquiditySource,
      allowedLiquiditySources: params.takePolicy?.allowedLiquiditySources,
    });
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
  const gasPolicyRejectCodeBySource: FactoryRouteProfitabilityContext['gasPolicyRejectCodeBySource'] =
    {};
  const gasQuoteAttemptsBySource: FactoryRouteProfitabilityContext['gasQuoteAttemptsBySource'] =
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
    { label: 'oneinch', value: getPathStat('oneinch', 'approved') },
    { label: 'factory', value: getPathStat('factory', 'approved') },
    { label: 'lifi', value: getPathStat('lifi', 'approved') },
  ]);
  appendNonZeroGroup(fields, 'approvedFactorySources', [
    { label: 'uniswapV3', value: stats.approvedUniswapV3TakeDecisions },
    { label: 'sushiswap', value: stats.approvedSushiswapTakeDecisions },
    { label: 'curve', value: stats.approvedCurveTakeDecisions },
  ]);
  appendNonZeroGroup(fields, 'executedRoutes', [
    { label: 'oneinch', value: getPathStat('oneinch', 'executed') },
    { label: 'factory', value: getPathStat('factory', 'executed') },
    { label: 'lifi', value: getPathStat('lifi', 'executed') },
  ]);
  appendNonZeroGroup(fields, 'executedFactorySources', [
    { label: 'uniswapV3', value: stats.executedUniswapV3Takes },
    { label: 'sushiswap', value: stats.executedSushiswapTakes },
    { label: 'curve', value: stats.executedCurveTakes },
  ]);
  appendNonZeroGroup(fields, 'dryRunRoutes', [
    { label: 'oneinch', value: getPathStat('oneinch', 'dryRun') },
    { label: 'factory', value: getPathStat('factory', 'dryRun') },
    { label: 'lifi', value: getPathStat('lifi', 'dryRun') },
  ]);
  appendNonZeroGroup(fields, 'dryRunFactorySources', [
    { label: 'uniswapV3', value: stats.dryRunUniswapV3Takes },
    { label: 'sushiswap', value: stats.dryRunSushiswapTakes },
    { label: 'curve', value: stats.dryRunCurveTakes },
  ]);
  appendNonZeroGroup(fields, 'oneInchFailures', [
    { label: 'swapData', value: stats.oneInchSwapDataFailures },
    { label: 'preBroadcast', value: stats.oneInchPreBroadcastFailures },
    { label: 'postSubmission', value: stats.oneInchPostSubmissionFailures },
  ]);
  appendNonZeroGroup(fields, 'factoryFailures', [
    { label: 'preBroadcast', value: stats.factoryPreBroadcastFailures },
    { label: 'postSubmission', value: stats.factoryPostSubmissionFailures },
  ]);
  appendNonZeroGroup(fields, 'lifiFailures', [
    {
      label: 'preBroadcast',
      value: getPathStat('lifi', 'preBroadcastFailures'),
    },
    {
      label: 'postSubmission',
      value: getPathStat('lifi', 'postSubmissionFailures'),
    },
  ]);
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
    approvedOneInchTakeDecisions: 0,
    approvedFactoryTakeDecisions: 0,
    approvedUniswapV3TakeDecisions: 0,
    approvedSushiswapTakeDecisions: 0,
    approvedCurveTakeDecisions: 0,
    evaluationSkips: 0,
    revalidationSkips: 0,
    executionSkips: 0,
    gasPolicyRejects: 0,
    profitFloorRejects: 0,
    arbProfitUnavailableRejects: 0,
    executedExternalTakes: 0,
    executedArbTakes: 0,
    executedOneInchTakes: 0,
    executedFactoryTakes: 0,
    executedUniswapV3Takes: 0,
    executedSushiswapTakes: 0,
    executedCurveTakes: 0,
    dryRunExternalTakes: 0,
    dryRunArbTakes: 0,
    dryRunOneInchTakes: 0,
    dryRunFactoryTakes: 0,
    dryRunUniswapV3Takes: 0,
    dryRunSushiswapTakes: 0,
    dryRunCurveTakes: 0,
    oneInchSwapDataFailures: 0,
    oneInchPreBroadcastFailures: 0,
    oneInchPostSubmissionFailures: 0,
    factoryPreBroadcastFailures: 0,
    factoryPostSubmissionFailures: 0,
    externalTakeByPath: {},
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
      includeFactoryQuoteProviders: true,
    }));
  if (rpcCache) {
    rpcCache.stats ??= {};
    rpcCache.stats.factory ??= {};
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
    externalTakeProbeTimeoutMs,
    buildFactoryRouteProfitabilityContext,
  });
  const {
    externalTakePaths,
    defaultFactoryLiquiditySource,
    factoryQuoteConfig,
    externalTakeAdapter,
    externalExecutionConfig,
    approveExternalTake,
  } = runtime;

  try {
    const candidates = params.target.candidates.map(({ borrower }) => ({
      borrower,
    }));
    const takeAuctionStatusReader = createTakeAuctionStatusReader({
      stats: rpcCache?.stats,
    });
    await withFactoryRuntimeStats(
      rpcCache?.factoryQuoteProviders,
      rpcCache?.stats?.factory,
      async () => {
        const prewarmFactoryRoutes =
          externalTakePaths.includes('factory') &&
          defaultFactoryLiquiditySource !== undefined &&
          candidates.length > 0
            ? prewarmFactoryRouteAvailability({
                pool: params.pool,
                signer: params.signer,
                poolConfig: withTakeLiquiditySource(
                  params.target,
                  defaultFactoryLiquiditySource
                ),
                quoteConfig: factoryQuoteConfig,
                routeSelection: {
                  allowedLiquiditySources: takePolicy?.allowedLiquiditySources,
                  routeQuoteBudgetPerCandidate:
                    takePolicy?.takeRouteQuoteBudgetPerCandidate,
                  routeProbeLimiter,
                },
                runtimeCache: rpcCache?.factoryQuoteProviders,
                timeoutMs: Math.min(1_000, externalTakeProbeTimeoutMs),
              })
            : undefined;
        if (prewarmFactoryRoutes) {
          await prewarmFactoryRoutes;
        }
        await processTakeCandidates<
          ResolvedTakeTarget,
          DiscoveryExternalExecutionConfig
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
            quoteEvaluation,
          }) =>
            approveExternalTake({
              price,
              auctionPrice,
              collateral,
              quoteEvaluation,
            }),
          reapproveExternalTakeBeforeExecution: async ({
            price,
            auctionPrice,
            collateral,
            quoteEvaluation,
          }) => {
            const approval = await approveExternalTake({
              price,
              auctionPrice,
              collateral,
              quoteEvaluation,
              forceGasRefresh: true,
            });
            if (!approval.approved) {
              return approval;
            }
            return {
              ...approval,
              quoteEvaluation: withExternalTakeApprovalContext({
                quoteEvaluation: approval.quoteEvaluation,
                auctionPrice,
                collateral,
              }),
            };
          },
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
                quoteEvaluation: decision.quoteEvaluation,
                keys: APPROVED_EXTERNAL_TAKE_ROUTE_STAT_KEYS,
                pathCounter: 'approved',
              });
            }
            if (decision.approvedArbTake) {
              stats.approvedArbTakeDecisions += 1;
            }
          },
          onSkip: ({ candidate, stage, reason }) => {
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
          onExecuted: ({ executedTake, executedArbTake }) => {
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
