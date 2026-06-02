import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  ExternalTakePathKind,
  LiquiditySource,
  LiquiditySourceMap,
  TakeWriteTransportMode,
  ActiveExternalTakeRouteSelectionMode,
  formatLiquiditySource,
  getAutoDiscoverTakePolicy,
  isFactoryDynamicSource,
  normalizeExternalTakeRouteSelectionMode,
  resolveDefaultFactoryLiquiditySource,
  resolveExternalTakePaths,
  resolveFactoryRouteSelectionSources,
} from '../config';
import { ResolvedTakeTarget } from './targets';
import {
  DiscoveryExternalExecutionConfig,
  withTakeLiquiditySource,
} from './external-take-provider';
import { createDiscoveryExternalTakeProviderRegistry } from './external-take-providers';
import { logger } from '../logging';
import {
  createDiscoveryTransportsForConfig,
  evaluateGasPolicy,
  GasPolicyResult,
  getDiscoveryGasPriceFreshnessTtlMs,
  getEffectiveL2GasCostBufferBasisPoints,
  logDiscoveryDecision,
} from './gas-policy';
import {
  DiscoveryExecutionConfig,
  DiscoveryExecutionTransportConfig,
  DiscoveryRpcCache,
  LifiCircuitPurpose,
  OneInchQuoteCircuitPurpose,
} from './types';
import { DiscoveryReadTransports } from '../read-transports';
import * as lifiExecutionModule from '../take/lifi-execution';
import * as oneInchAdapterModule from '../take/one-inch-adapter';
import { createArbTakeStrategy } from '../take/arb-strategy';
import {
  ExternalTakeAdapter,
  processTakeCandidates,
  TAKE_SKIP_REASONS,
} from '../take/engine';
import {
  ExternalTakeQuoteEvaluation,
  RouteProfitabilityBreakdown,
} from '../take/types';
import { TakeWriteTransport } from '../take/write-transport';
import { FactoryRouteProfitabilityContext } from '../take/factory';
import {
  applyFactoryRouteProfitabilityPolicy,
  ceilDiv,
  getMarketPriceFactorUnits,
  MARKET_FACTOR_SCALE,
  prewarmFactoryRouteAvailability,
  withFactoryRuntimeStats,
} from '../take/factory/shared';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
  isSubsidizedExternalTakeQuote,
  mergeRoutePolicyIntoEvaluation,
} from '../take/external-take-policy';
import {
  AsyncOperationLimiter,
  RouteProbeLimiter,
  decimaledToWei,
  getErrorMessage,
  withTimeout,
} from '../utils';
import { convertWadToTokenDecimalsCeil, getDecimalsErc20 } from '../erc20';
import { createTakeAuctionStatusReader } from '../take/liquidation-status';
import { createDiscoveryRpcCache } from './rpc-cache';
import { getOneInchQuoteTimeoutMs } from './one-inch-circuit';
import { resolveHybridExternalTakeExecutionSelection } from './external-take-selection';
import {
  DiscoveryExternalTakeApprovalMode,
  DiscoveryExternalTakeApprover,
  ExternalTakeApprovalInput,
  ExternalTakeApprovalResult,
} from './external-take-approval';
import {
  cloneExternalTakeQuoteEvaluation,
  isFactoryExternalTakeRoute,
  isOneInchExternalTakeRoute,
  resolveExternalTakePathFromEvaluation,
} from './external-take-evaluation';
import {
  AutoDiscoverTakePolicyRuntime,
  FactoryPathQuoteFn,
  LifiCircuitOutcome,
  LifiPathQuoteFn,
  OneInchCircuitOutcome,
  OneInchPathQuoteFn,
  quoteFactoryPathForDiscovery,
  quoteKeeperTakerOneInchTakeForDiscovery,
  quoteLifiPathForDiscovery,
  quoteOneInchPathForDiscovery,
  recordLifiCircuitOutcomeForDiscovery,
  recordOneInchCircuitOutcomeForDiscovery,
} from './external-take-quotes';
import { evaluateHybridExternalTakeForDiscovery } from './hybrid-external-take';
import { BASIS_POINTS_DENOMINATOR_BN, WAD, ZERO_BN } from '../constants';

export {
  resolveHybridExternalTakeExecutionSelection,
  selectBestExternalTakeQuoteEvaluation,
  sortExternalTakeQuoteEvaluationsForSelection,
} from './external-take-selection';

// Conservative per-route execution limits used for profitability screening.
// Operators can override these with autoDiscover.take.dexGasOverrides.
const EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(900000);
const CURVE_EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(1_500_000);
const ARB_TAKE_GAS_LIMIT = BigNumber.from(450000);
const ZERO = ZERO_BN;
const DEFAULT_EXTERNAL_TAKE_PROBE_RPC_BUDGET_MS = 1_000;
const MAX_DEFAULT_EXTERNAL_TAKE_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_IN_FLIGHT_ROUTE_PROBES = 3;
const MIN_ROUTE_PROBE_HARD_CAP_EXTRA_MS = 1_000;

function getGasPriceDriftBasisPoints(params: {
  evaluatedGasPrice: BigNumber;
  currentGasPrice: BigNumber;
}): number {
  const { evaluatedGasPrice, currentGasPrice } = params;
  if (evaluatedGasPrice.isZero()) {
    return currentGasPrice.isZero() ? 0 : Number.POSITIVE_INFINITY;
  }
  if (!currentGasPrice.gt(evaluatedGasPrice)) {
    return 0;
  }
  const delta = currentGasPrice.sub(evaluatedGasPrice);
  return delta
    .mul(BASIS_POINTS_DENOMINATOR_BN)
    .div(evaluatedGasPrice)
    .toNumber();
}

function getGasPriceAgeMs(rpcCache?: DiscoveryRpcCache): number | undefined {
  return rpcCache?.gasPriceFetchedAt !== undefined
    ? Date.now() - rpcCache.gasPriceFetchedAt
    : undefined;
}

function getWriteTransportMode(
  takeWriteTransport?: TakeWriteTransport
): string {
  return takeWriteTransport?.mode ?? TakeWriteTransportMode.PUBLIC_RPC;
}

function formatExternalTakeGasTelemetry(params: {
  poolAddress: string;
  borrower?: string;
  path?: ExternalTakePathKind;
  source?: LiquiditySource;
  routeProfitability?: ExternalTakeQuoteEvaluation['routeProfitability'];
  rpcCache?: DiscoveryRpcCache;
  takePolicy: ReturnType<typeof getAutoDiscoverTakePolicy>;
  writeTransport?: TakeWriteTransport;
}): string {
  const routeProfitability = params.routeProfitability;
  const chainId = params.rpcCache?.chainId;
  const ttlMs = getDiscoveryGasPriceFreshnessTtlMs(params.takePolicy, chainId);
  const gasAgeMs =
    getGasPriceAgeMs(params.rpcCache) ?? routeProfitability?.gasPriceAgeMs;
  const currentGasPrice = params.rpcCache?.gasPrice;
  const evaluatedGasPrice = routeProfitability?.gasPriceWei;
  const driftBps =
    evaluatedGasPrice && currentGasPrice
      ? getGasPriceDriftBasisPoints({
          evaluatedGasPrice,
          currentGasPrice,
        })
      : undefined;
  const configuredDexGasOverride =
    params.source !== undefined
      ? params.takePolicy?.dexGasOverrides?.[params.source]
      : undefined;
  const routeGasLimit =
    routeProfitability?.routeGasLimit ??
    (params.source !== undefined
      ? getExternalTakeGasLimit(params.takePolicy, params.source)
      : undefined);
  const routeGasModel =
    params.source === undefined
      ? 'n/a'
      : configuredDexGasOverride !== undefined
        ? 'dexGasOverrides'
        : 'default';
  return (
    `pool=${params.poolAddress}` +
    ` borrower=${params.borrower ?? 'n/a'}` +
    ` path=${params.path ?? 'n/a'}` +
    ` source=${formatLiquiditySource(params.source)}` +
    ` routeGasModel=${routeGasModel}` +
    ` configuredDexGasOverrideRaw=${configuredDexGasOverride ?? 'none'}` +
    ` routeGasLimit=${routeGasLimit?.toString() ?? 'n/a'}` +
    ` evaluatedGasGwei=${routeProfitability?.gasPriceGwei ?? 'n/a'}` +
    ` currentGasWei=${currentGasPrice?.toString() ?? 'n/a'}` +
    ` gasAgeMs=${gasAgeMs ?? 'n/a'}` +
    ` gasTtlMs=${routeProfitability?.gasPriceFreshnessTtlMs ?? ttlMs}` +
    ` gasDriftBps=${driftBps ?? 'n/a'}` +
    ` l2BufferBps=${routeProfitability?.l2GasCostBufferBasisPoints ?? getEffectiveL2GasCostBufferBasisPoints(params.takePolicy, chainId) ?? 'n/a'}` +
    ` configuredMarketPriceFactor=${routeProfitability?.configuredMarketPriceFactor ?? 'n/a'}` +
    ` routeBreakEvenMarketPriceFactor=${routeProfitability?.routeBreakEvenMarketPriceFactor ?? 'n/a'}` +
    ` effectiveMarketPriceFactor=${routeProfitability?.effectiveMarketPriceFactor ?? 'n/a'}` +
    ` allowSubsidy=${routeProfitability?.subsidyAllowed ?? false}` +
    ` quoteDueRaw=${routeProfitability?.auctionRepayRequirementQuoteRaw?.toString() ?? 'n/a'}` +
    ` requiredNonSubsidizedOutputRaw=${routeProfitability?.requiredNonSubsidizedOutputRaw?.toString() ?? 'n/a'}` +
    ` expectedShortfallQuoteRaw=${routeProfitability?.expectedShortfallQuoteRaw?.toString() ?? 'n/a'}` +
    ` expectedSubsidyQuoteRaw=${routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'}` +
    ` writeTransport=${getWriteTransportMode(params.writeTransport)}`
  );
}

function getExternalTakeGasLimit(
  policy: ReturnType<typeof getAutoDiscoverTakePolicy>,
  source: LiquiditySource
): BigNumber {
  const override = policy?.dexGasOverrides?.[source];
  if (override) {
    return BigNumber.from(override);
  }
  return source === LiquiditySource.CURVE
    ? CURVE_EXTERNAL_TAKE_GAS_LIMIT
    : EXTERNAL_TAKE_GAS_LIMIT;
}

function requiresHybridNetProfitRanking(
  takePolicy: AutoDiscoverTakePolicyRuntime
): boolean {
  const paths = takePolicy?.allowedExternalTakePaths;
  return !!(
    paths !== undefined &&
    paths.length > 1 &&
    normalizeExternalTakeRouteSelectionMode(
      takePolicy?.externalTakeRouteSelectionMode
    ) === 'maximize_profit'
  );
}

function getAuctionCostQuoteRaw(params: {
  price: BigNumber;
  collateral: BigNumber;
  quoteTokenDecimals: number;
}): BigNumber {
  const quoteDueWad = params.collateral
    .mul(params.price)
    .add(WAD.sub(1))
    .div(WAD);
  return convertWadToTokenDecimalsCeil(quoteDueWad, params.quoteTokenDecimals);
}

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

function buildSimpleQuoteProfitability(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  auctionCostQuoteRaw: BigNumber;
  routeGasLimit: BigNumber;
  gasCostQuoteRaw?: BigNumber;
  gasPriceRaw?: BigNumber;
  gasPriceGwei?: number;
  gasPriceAgeMs?: number;
  gasPriceFreshnessTtlMs?: number;
  l2GasCostBufferBasisPoints?: number;
}): RouteProfitabilityBreakdown | undefined {
  const quoteAmountRaw = params.quoteEvaluation.quoteAmountRaw;
  if (!quoteAmountRaw) {
    return undefined;
  }

  const routeExecutionCostQuoteRaw = params.gasCostQuoteRaw ?? ZERO;
  const breakEvenQuoteAmountRaw = params.auctionCostQuoteRaw.add(
    routeExecutionCostQuoteRaw
  );
  return {
    ...params.quoteEvaluation.routeProfitability,
    auctionRepayRequirementQuoteRaw:
      params.quoteEvaluation.routeProfitability
        ?.auctionRepayRequirementQuoteRaw ?? params.auctionCostQuoteRaw,
    routeExecutionCostQuoteRaw,
    expectedNetProfitQuoteRaw: quoteAmountRaw.gte(breakEvenQuoteAmountRaw)
      ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
      : ZERO,
    expectedShortfallQuoteRaw: quoteAmountRaw.lt(breakEvenQuoteAmountRaw)
      ? breakEvenQuoteAmountRaw.sub(quoteAmountRaw)
      : ZERO,
    routeGasLimit: params.routeGasLimit,
    gasPriceWei: params.gasPriceRaw,
    gasPriceGwei: params.gasPriceGwei,
    gasPriceAgeMs: params.gasPriceAgeMs,
    gasPriceFreshnessTtlMs: params.gasPriceFreshnessTtlMs,
    l2GasCostBufferBasisPoints: params.l2GasCostBufferBasisPoints,
    gasPolicyEvaluatedAt: Date.now(),
  };
}

function getApprovalGasTelemetryFields(params: {
  routeGasLimit: BigNumber;
  gasPolicy: GasPolicyResult;
  rpcCache?: DiscoveryRpcCache;
  takePolicy: AutoDiscoverTakePolicyRuntime;
}): Pick<
  RouteProfitabilityBreakdown,
  | 'routeGasLimit'
  | 'gasPriceWei'
  | 'gasPriceGwei'
  | 'gasPriceAgeMs'
  | 'gasPriceFreshnessTtlMs'
  | 'l2GasCostBufferBasisPoints'
  | 'gasPolicyEvaluatedAt'
> {
  return {
    routeGasLimit: params.routeGasLimit,
    gasPriceWei: params.gasPolicy.gasPriceRaw,
    gasPriceGwei: params.gasPolicy.gasPriceGwei,
    gasPriceAgeMs: getGasPriceAgeMs(params.rpcCache),
    gasPriceFreshnessTtlMs: getDiscoveryGasPriceFreshnessTtlMs(
      params.takePolicy,
      params.rpcCache?.chainId
    ),
    l2GasCostBufferBasisPoints: params.gasPolicy.l2GasCostBufferBasisPoints,
    gasPolicyEvaluatedAt: Date.now(),
  };
}

function hasFreshFactoryRouteGasPolicy(params: {
  quoteEvaluation: {
    routeProfitability?: {
      gasPriceWei?: BigNumber;
      gasPolicyEvaluatedAt?: number;
    };
  };
  currentGasPrice?: BigNumber;
  chainId?: number;
  takePolicy?: ReturnType<typeof getAutoDiscoverTakePolicy>;
  now?: number;
}): { fresh: boolean; reason?: string } {
  const evaluatedAt =
    params.quoteEvaluation.routeProfitability?.gasPolicyEvaluatedAt;
  if (evaluatedAt === undefined) {
    return { fresh: false, reason: 'missing gas policy timestamp' };
  }

  const ageMs = (params.now ?? Date.now()) - evaluatedAt;
  const ttlMs = getDiscoveryGasPriceFreshnessTtlMs(
    params.takePolicy,
    params.chainId
  );
  if (ageMs > ttlMs) {
    return {
      fresh: false,
      reason: `gas policy age ${ageMs}ms exceeds ${ttlMs}ms TTL`,
    };
  }

  const driftToleranceBps =
    params.takePolicy?.gasPriceDriftToleranceBasisPoints;
  if (driftToleranceBps === undefined) {
    return { fresh: true };
  }

  const evaluatedGasPrice =
    params.quoteEvaluation.routeProfitability?.gasPriceWei;
  if (!evaluatedGasPrice || !params.currentGasPrice) {
    return {
      fresh: false,
      reason: 'missing gas price snapshot for drift check',
    };
  }

  const driftBps = getGasPriceDriftBasisPoints({
    evaluatedGasPrice,
    currentGasPrice: params.currentGasPrice,
  });
  if (driftBps > driftToleranceBps) {
    return {
      fresh: false,
      reason: `gas price drift ${driftBps}bps exceeds tolerance ${driftToleranceBps}bps`,
    };
  }

  return { fresh: true };
}

export async function refreshDiscoveryGasPriceIfStale(params: {
  rpcCache?: DiscoveryRpcCache;
  transports: DiscoveryReadTransports;
  maxAgeMs?: number;
  force?: boolean;
}): Promise<void> {
  const rpcCache = params.rpcCache;
  if (!rpcCache) {
    return;
  }

  const fetchedAt = rpcCache.gasPriceFetchedAt;
  const hasFreshGasPrice =
    !params.force &&
    rpcCache.gasPrice !== undefined &&
    fetchedAt !== undefined &&
    Date.now() - fetchedAt <=
      (params.maxAgeMs ??
        getDiscoveryGasPriceFreshnessTtlMs(undefined, rpcCache.chainId));
  if (hasFreshGasPrice) {
    return;
  }

  if (rpcCache.gasPriceInflight) {
    try {
      rpcCache.gasPrice = await rpcCache.gasPriceInflight;
      rpcCache.gasPriceFetchedAt = Date.now();
    } catch (error) {
      logger.warn(
        `Shared discovery gas price fetch failed: ${getErrorMessage(error)}`
      );
      throw error;
    }
    return;
  }

  const gasPriceInflight = params.transports.readRpc.getGasPrice();
  rpcCache.gasPriceInflight = gasPriceInflight;
  try {
    rpcCache.gasPrice = await gasPriceInflight;
    rpcCache.gasPriceFetchedAt = Date.now();
  } catch (error) {
    logger.warn(`Discovery gas price fetch failed: ${getErrorMessage(error)}`);
    throw error;
  } finally {
    if (rpcCache.gasPriceInflight === gasPriceInflight) {
      rpcCache.gasPriceInflight = undefined;
    }
  }
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

interface ExternalTakePathCounters {
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

type ExternalTakeRouteStatKey =
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

interface ExternalTakeRouteStatKeys {
  oneInch: ExternalTakeRouteStatKey;
  factory: ExternalTakeRouteStatKey;
  uniswapV3: ExternalTakeRouteStatKey;
  sushiswap: ExternalTakeRouteStatKey;
  curve: ExternalTakeRouteStatKey;
}

type ExternalTakeRouteCounterStats = Pick<
  DiscoveredTakeTargetStats,
  ExternalTakeRouteStatKey | 'externalTakeByPath'
>;

const APPROVED_EXTERNAL_TAKE_ROUTE_STAT_KEYS: ExternalTakeRouteStatKeys = {
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
    { label: 'oneinch', value: stats.approvedOneInchTakeDecisions },
    { label: 'factory', value: stats.approvedFactoryTakeDecisions },
    {
      label: 'lifi',
      value: getExternalTakePathCounter({
        stats,
        path: 'lifi',
        field: 'approved',
      }),
    },
  ]);
  appendNonZeroGroup(fields, 'approvedFactorySources', [
    { label: 'uniswapV3', value: stats.approvedUniswapV3TakeDecisions },
    { label: 'sushiswap', value: stats.approvedSushiswapTakeDecisions },
    { label: 'curve', value: stats.approvedCurveTakeDecisions },
  ]);
  appendNonZeroGroup(fields, 'executedRoutes', [
    { label: 'oneinch', value: stats.executedOneInchTakes },
    { label: 'factory', value: stats.executedFactoryTakes },
    {
      label: 'lifi',
      value: getExternalTakePathCounter({
        stats,
        path: 'lifi',
        field: 'executed',
      }),
    },
  ]);
  appendNonZeroGroup(fields, 'executedFactorySources', [
    { label: 'uniswapV3', value: stats.executedUniswapV3Takes },
    { label: 'sushiswap', value: stats.executedSushiswapTakes },
    { label: 'curve', value: stats.executedCurveTakes },
  ]);
  appendNonZeroGroup(fields, 'dryRunRoutes', [
    { label: 'oneinch', value: stats.dryRunOneInchTakes },
    { label: 'factory', value: stats.dryRunFactoryTakes },
    {
      label: 'lifi',
      value: getExternalTakePathCounter({
        stats,
        path: 'lifi',
        field: 'dryRun',
      }),
    },
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
      value: getExternalTakePathCounter({
        stats,
        path: 'lifi',
        field: 'preBroadcastFailures',
      }),
    },
    {
      label: 'postSubmission',
      value: getExternalTakePathCounter({
        stats,
        path: 'lifi',
        field: 'postSubmissionFailures',
      }),
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

function withExternalTakeApprovalContext(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  auctionPrice: BigNumber;
  collateral: BigNumber;
}): ExternalTakeQuoteEvaluation {
  return {
    ...params.quoteEvaluation,
    quotedAuctionPriceWad: params.auctionPrice,
    quotedCollateralWad: params.collateral,
  };
}

type ExternalTakePathCounterField = keyof ExternalTakePathCounters;

function getExternalTakePathCounters(
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

function getExternalTakePathCounter(params: {
  stats: Pick<DiscoveredTakeTargetStats, 'externalTakeByPath'>;
  path: ExternalTakePathKind;
  field: ExternalTakePathCounterField;
}): number {
  return params.stats.externalTakeByPath[params.path]?.[params.field] ?? 0;
}

function incrementExternalTakeRouteStats(params: {
  stats: ExternalTakeRouteCounterStats;
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined;
  keys: ExternalTakeRouteStatKeys;
  pathCounter?: ExternalTakePathCounterField;
}): void {
  const { stats, quoteEvaluation, keys } = params;
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

  switch (quoteEvaluation?.selectedLiquiditySource) {
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

function recordSuccessfulExternalTakeRouteStats(
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

function resolveApprovedExternalTakeSource(params: {
  target: ResolvedTakeTarget;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
}): {
  approved: boolean;
  selectedLiquiditySource?: LiquiditySource;
  selectedFactoryLiquiditySource?: LiquiditySource;
  reason?: string;
} {
  let selectedLiquiditySource = params.quoteEvaluation.selectedLiquiditySource;
  if (selectedLiquiditySource === undefined) {
    const configuredLiquiditySource = params.target.take.liquiditySource;
    if (
      configuredLiquiditySource !== LiquiditySource.ONEINCH &&
      isFactoryDynamicSource(configuredLiquiditySource)
    ) {
      return {
        approved: false,
        reason: 'factory route approval missing selected liquidity source',
      };
    }
    selectedLiquiditySource = configuredLiquiditySource;
  }

  const selectedFactoryLiquiditySource =
    selectedLiquiditySource !== undefined &&
    isFactoryDynamicSource(selectedLiquiditySource)
      ? selectedLiquiditySource
      : undefined;

  return {
    approved: true,
    selectedLiquiditySource,
    selectedFactoryLiquiditySource,
  };
}

function rejectDiscoveryProfitFloor(params: {
  reason: string;
  countStats: boolean;
  stats: Pick<DiscoveredTakeTargetStats, 'profitFloorRejects'>;
}): ExternalTakeApprovalResult {
  if (params.countStats) {
    params.stats.profitFloorRejects += 1;
  }
  return {
    approved: false,
    reason: params.reason,
    rejectCategory: 'profitFloor',
  };
}

function applyDiscoveryApprovalProfitabilityPolicy(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedFactoryLiquiditySource?: LiquiditySource;
  target: ResolvedTakeTarget;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  gasPolicy: GasPolicyResult;
  auctionCostQuoteRaw?: BigNumber;
  routeGasLimit: BigNumber;
  minExpectedProfitQuoteRaw: BigNumber;
  gasCostQuoteRaw?: BigNumber;
  quoteAmountRaw?: BigNumber;
  price: number;
  rpcCache?: DiscoveryRpcCache;
  approvalMode: DiscoveryExternalTakeApprovalMode;
  countStats: boolean;
  stats: Pick<DiscoveredTakeTargetStats, 'profitFloorRejects'>;
}): ExternalTakeApprovalResult {
  const configuredMarketPriceFactor = params.target.take.marketPriceFactor;
  const canApplyRawRoutePolicy =
    params.quoteAmountRaw !== undefined &&
    (params.gasCostQuoteRaw !== undefined ||
      params.approvalMode === 'factory_gas_quote_fallback') &&
    params.auctionCostQuoteRaw !== undefined &&
    configuredMarketPriceFactor !== undefined;
  const gasTelemetryFields = getApprovalGasTelemetryFields({
    routeGasLimit: params.routeGasLimit,
    gasPolicy: params.gasPolicy,
    rpcCache: params.rpcCache,
    takePolicy: params.takePolicy,
  });

  if (
    params.selectedFactoryLiquiditySource !== undefined &&
    canApplyRawRoutePolicy
  ) {
    const auctionRepayRequirementQuoteRaw = params.auctionCostQuoteRaw;
    const marketPriceFactor = configuredMarketPriceFactor;
    if (
      auctionRepayRequirementQuoteRaw === undefined ||
      marketPriceFactor === undefined
    ) {
      return rejectDiscoveryProfitFloor({
        reason: 'route profitability context missing raw policy inputs',
        countStats: params.countStats,
        stats: params.stats,
      });
    }
    const marketFactorFloorQuoteRaw = ceilDiv(
      auctionRepayRequirementQuoteRaw.mul(MARKET_FACTOR_SCALE),
      BigNumber.from(getMarketPriceFactorUnits(marketPriceFactor))
    );
    const refreshedEvaluation = applyFactoryRouteProfitabilityPolicy({
      evaluation: {
        ...params.quoteEvaluation,
        routeProfitability: {
          ...params.quoteEvaluation.routeProfitability,
          auctionRepayRequirementQuoteRaw,
          configuredMarketPriceFactor: marketPriceFactor,
          marketFactorFloorQuoteRaw,
        },
      },
      liquiditySource: params.selectedFactoryLiquiditySource,
      context: {
        routeExecutionCostQuoteRawBySource: {
          [params.selectedFactoryLiquiditySource]: params.gasCostQuoteRaw,
        },
        nativeProfitFloorQuoteRawBySource: {
          [params.selectedFactoryLiquiditySource]:
            params.gasPolicy.minProfitNativeQuoteRaw ?? ZERO,
        },
        configuredProfitFloorQuoteRaw: params.minExpectedProfitQuoteRaw,
        allowSubsidy: params.target.take.allowSubsidy === true,
        routeGasLimitBySource: {
          [params.selectedFactoryLiquiditySource]: params.routeGasLimit,
        },
        gasPriceWei: gasTelemetryFields.gasPriceWei,
        gasPriceGwei: gasTelemetryFields.gasPriceGwei,
        gasPriceAgeMs: gasTelemetryFields.gasPriceAgeMs,
        gasPriceFreshnessTtlMs: gasTelemetryFields.gasPriceFreshnessTtlMs,
        l2GasCostBufferBasisPoints:
          gasTelemetryFields.l2GasCostBufferBasisPoints,
        gasPolicyEvaluatedAt: gasTelemetryFields.gasPolicyEvaluatedAt,
      },
    });
    if (!refreshedEvaluation.isTakeable) {
      return rejectDiscoveryProfitFloor({
        reason:
          refreshedEvaluation.reason ??
          EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor,
        countStats: params.countStats,
        stats: params.stats,
      });
    }
    return { approved: true, quoteEvaluation: refreshedEvaluation };
  }

  if (canApplyRawRoutePolicy && configuredMarketPriceFactor !== undefined) {
    const quoteAmountRaw = params.quoteAmountRaw;
    const gasCostQuoteRaw = params.gasCostQuoteRaw;
    const auctionCostQuoteRaw = params.auctionCostQuoteRaw;
    if (
      quoteAmountRaw === undefined ||
      gasCostQuoteRaw === undefined ||
      auctionCostQuoteRaw === undefined
    ) {
      return rejectDiscoveryProfitFloor({
        reason: 'route profitability context missing raw policy inputs',
        countStats: params.countStats,
        stats: params.stats,
      });
    }
    const routeMinOutRaw =
      params.quoteEvaluation.routeMinOutRaw ??
      (params.quoteEvaluation.profitMinOutRaw
        ? undefined
        : params.quoteEvaluation.approvedMinOutRaw);
    const marketFactorFloorQuoteRaw =
      params.quoteEvaluation.routeProfitability?.marketFactorFloorQuoteRaw ??
      ceilDiv(
        auctionCostQuoteRaw.mul(MARKET_FACTOR_SCALE),
        BigNumber.from(getMarketPriceFactorUnits(configuredMarketPriceFactor))
      );
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor,
      allowSubsidy: params.target.take.allowSubsidy === true,
      quoteAmountRaw,
      quoteDueRaw: auctionCostQuoteRaw,
      marketFactorFloorQuoteRaw,
      routeMinOutRaw,
      routeExecutionCostQuoteRaw: gasCostQuoteRaw,
      configuredProfitFloorQuoteRaw: params.minExpectedProfitQuoteRaw,
      nativeProfitFloorQuoteRaw:
        params.gasPolicy.minProfitNativeQuoteRaw ?? ZERO,
    });
    if (!policy.isEconomicallyExecutable) {
      return rejectDiscoveryProfitFloor({
        reason:
          policy.rejectionReason ??
          EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor,
        countStats: params.countStats,
        stats: params.stats,
      });
    }
    const approvedQuoteEvaluation = mergeRoutePolicyIntoEvaluation({
      evaluation: params.quoteEvaluation,
      policy,
      auctionRepayRequirementQuoteRaw: auctionCostQuoteRaw,
      configuredMarketPriceFactor,
      marketFactorFloorQuoteRaw,
      routeProfitabilityExtras: gasTelemetryFields,
    });
    return { approved: true, quoteEvaluation: approvedQuoteEvaluation };
  }

  const hasQuoteProfitFloor =
    params.takePolicy?.minExpectedProfitQuote !== undefined ||
    params.takePolicy?.minProfitNative !== undefined;
  if (!hasQuoteProfitFloor) {
    return { approved: true, quoteEvaluation: params.quoteEvaluation };
  }

  if (params.takePolicy?.minProfitNative !== undefined) {
    return rejectDiscoveryProfitFloor({
      reason: 'quote-normalized minProfitNative floor is not available',
      countStats: params.countStats,
      stats: params.stats,
    });
  }

  const auctionCostQuote =
    params.price * (params.quoteEvaluation.collateralAmount ?? 0);
  const expectedProfit =
    (params.quoteEvaluation.quoteAmount ?? 0) -
    auctionCostQuote -
    params.gasPolicy.gasCostQuote;
  if (
    params.takePolicy?.minExpectedProfitQuote !== undefined &&
    expectedProfit < params.takePolicy.minExpectedProfitQuote
  ) {
    return rejectDiscoveryProfitFloor({
      reason: `expected take profit ${expectedProfit.toFixed(6)} below minExpectedProfitQuote ${params.takePolicy.minExpectedProfitQuote}`,
      countStats: params.countStats,
      stats: params.stats,
    });
  }

  return { approved: true, quoteEvaluation: params.quoteEvaluation };
}

async function approveExternalTakeForDiscovery(
  params: {
    pool: FungiblePool;
    signer: Signer;
    config: DiscoveryExecutionConfig;
    transports: DiscoveryReadTransports;
    target: ResolvedTakeTarget;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    takeWriteTransport?: TakeWriteTransport;
    stats: Pick<
      DiscoveredTakeTargetStats,
      'gasPolicyRejects' | 'profitFloorRejects'
    >;
  } & ExternalTakeApprovalInput
): Promise<ExternalTakeApprovalResult> {
  const {
    pool,
    signer,
    config,
    transports,
    target,
    rpcCache,
    takePolicy,
    takeWriteTransport,
    stats,
    price,
    auctionPrice,
    collateral,
    quoteEvaluation,
  } = params;
  const countStats = params.countStats ?? true;
  let approvedQuoteEvaluation =
    cloneExternalTakeQuoteEvaluation(quoteEvaluation);
  const approvalMode =
    params.approvalMode ??
    approvedQuoteEvaluation.approvalMode ??
    'strict_hybrid';

  if (approvalMode === 'factory_gas_quote_fallback') {
    if (
      takePolicy?.maxGasCostQuote !== undefined ||
      takePolicy?.minExpectedProfitQuote !== undefined ||
      takePolicy?.minProfitNative !== undefined
    ) {
      return {
        approved: false,
        reason:
          'hybrid gas quote fallback ineligible because quote-denominated gas/profit policy is configured',
        rejectCategory: 'gasPolicy',
      };
    }
    if (takePolicy?.maxGasCostNative === undefined) {
      return {
        approved: false,
        reason:
          'hybrid gas quote fallback ineligible because maxGasCostNative is not configured',
        rejectCategory: 'gasPolicy',
      };
    }
  }

  const sourceSelection = resolveApprovedExternalTakeSource({
    target,
    quoteEvaluation: approvedQuoteEvaluation,
  });
  if (!sourceSelection.approved) {
    return {
      approved: false,
      reason: sourceSelection.reason,
    };
  }
  const selectedLiquiditySource = sourceSelection.selectedLiquiditySource;
  const selectedFactoryLiquiditySource =
    sourceSelection.selectedFactoryLiquiditySource;
  const fallbackInputWasSubsidized =
    approvalMode === 'factory_gas_quote_fallback' &&
    isSubsidizedExternalTakeQuote(approvedQuoteEvaluation);
  if (selectedLiquiditySource !== undefined && !params.forceGasRefresh) {
    const freshness = hasFreshFactoryRouteGasPolicy({
      quoteEvaluation: approvedQuoteEvaluation,
      currentGasPrice: rpcCache?.gasPrice,
      chainId: rpcCache?.chainId,
      takePolicy,
    });
    if (freshness.fresh) {
      logger.debug(
        `Discovered external take using fresh gas policy: ${formatExternalTakeGasTelemetry(
          {
            poolAddress: target.poolAddress,
            path: approvedQuoteEvaluation.externalTakePath,
            source: selectedLiquiditySource,
            routeProfitability: approvedQuoteEvaluation.routeProfitability,
            rpcCache,
            takePolicy,
            writeTransport: takeWriteTransport,
          }
        )}`
      );
      return { approved: true, quoteEvaluation: approvedQuoteEvaluation };
    }
  }

  await refreshDiscoveryGasPriceIfStale({
    rpcCache,
    transports,
    maxAgeMs: getDiscoveryGasPriceFreshnessTtlMs(takePolicy, rpcCache?.chainId),
    force: params.forceGasRefresh,
  });

  if (selectedLiquiditySource !== undefined && !params.forceGasRefresh) {
    const refreshedFreshness = hasFreshFactoryRouteGasPolicy({
      quoteEvaluation: approvedQuoteEvaluation,
      currentGasPrice: rpcCache?.gasPrice,
      chainId: rpcCache?.chainId,
      takePolicy,
    });
    if (refreshedFreshness.fresh) {
      logger.debug(
        `Discovered external take gas drift check passed: ${formatExternalTakeGasTelemetry(
          {
            poolAddress: target.poolAddress,
            path: approvedQuoteEvaluation.externalTakePath,
            source: selectedLiquiditySource,
            routeProfitability: approvedQuoteEvaluation.routeProfitability,
            rpcCache,
            takePolicy,
            writeTransport: takeWriteTransport,
          }
        )}`
      );
      return { approved: true, quoteEvaluation: approvedQuoteEvaluation };
    }
    if (refreshedFreshness.reason) {
      logger.debug(
        `Refreshing discovered external take gas policy because ${refreshedFreshness.reason}: ${formatExternalTakeGasTelemetry(
          {
            poolAddress: target.poolAddress,
            path: approvedQuoteEvaluation.externalTakePath,
            source: selectedLiquiditySource,
            routeProfitability: approvedQuoteEvaluation.routeProfitability,
            rpcCache,
            takePolicy,
            writeTransport: takeWriteTransport,
          }
        )}`
      );
    }
  }

  const routeGasLimit =
    selectedLiquiditySource !== undefined
      ? getExternalTakeGasLimit(takePolicy, selectedLiquiditySource)
      : EXTERNAL_TAKE_GAS_LIMIT;
  const gasPolicy = await evaluateGasPolicy({
    signer,
    config,
    transports,
    policy: takePolicy,
    gasLimit: routeGasLimit,
    quoteTokenAddress: pool.quoteAddress,
    preferredLiquiditySource: selectedLiquiditySource,
    useProfitFloor: true,
    requireGasCostQuote:
      approvalMode === 'factory_gas_quote_fallback'
        ? false
        : requiresHybridNetProfitRanking(takePolicy),
    gasPrice: rpcCache?.gasPrice,
    chainId: rpcCache?.chainId,
    rpcCache,
  });
  if (!gasPolicy.approved) {
    if (countStats) {
      stats.gasPolicyRejects += 1;
    }
    logger.warn(
      `Discovered external take gas policy rejected: ${gasPolicy.reason ?? 'unknown reason'} ${formatExternalTakeGasTelemetry(
        {
          poolAddress: target.poolAddress,
          path: approvedQuoteEvaluation.externalTakePath,
          source: selectedLiquiditySource,
          routeProfitability: approvedQuoteEvaluation.routeProfitability,
          rpcCache,
          takePolicy,
          writeTransport: takeWriteTransport,
        }
      )}`
    );
    return {
      approved: false,
      reason: gasPolicy.reason,
      rejectCategory: 'gasPolicy',
      gasPolicyRejectCode: gasPolicy.rejectCode,
      gasQuoteAttempts: gasPolicy.gasQuoteAttempts,
    };
  }

  const quoteAmountRaw = approvedQuoteEvaluation.quoteAmountRaw;
  const gasCostQuoteRaw = gasPolicy.gasCostQuoteRaw;
  const minExpectedProfitQuote = takePolicy?.minExpectedProfitQuote;
  const hasQuoteProfitFloor =
    minExpectedProfitQuote !== undefined ||
    takePolicy?.minProfitNative !== undefined;
  const needsSimpleProfitability =
    quoteAmountRaw !== undefined &&
    (takePolicy?.allowedExternalTakePaths !== undefined ||
      hasQuoteProfitFloor ||
      gasCostQuoteRaw !== undefined);
  let quoteTokenDecimals = gasPolicy.quoteTokenDecimals;
  if (quoteTokenDecimals === undefined && needsSimpleProfitability) {
    quoteTokenDecimals = await getDecimalsErc20(
      signer,
      pool.quoteAddress,
      rpcCache?.chainId
    );
  }
  const auctionCostQuoteRaw =
    quoteTokenDecimals !== undefined
      ? getAuctionCostQuoteRaw({
          price: auctionPrice,
          collateral,
          quoteTokenDecimals,
        })
      : undefined;
  if (quoteAmountRaw && auctionCostQuoteRaw) {
    const routeProfitability = buildSimpleQuoteProfitability({
      quoteEvaluation: approvedQuoteEvaluation,
      auctionCostQuoteRaw,
      routeGasLimit,
      gasCostQuoteRaw,
      gasPriceRaw: gasPolicy.gasPriceRaw,
      gasPriceGwei: gasPolicy.gasPriceGwei,
      gasPriceAgeMs: getGasPriceAgeMs(rpcCache),
      gasPriceFreshnessTtlMs: getDiscoveryGasPriceFreshnessTtlMs(
        takePolicy,
        rpcCache?.chainId
      ),
      l2GasCostBufferBasisPoints: gasPolicy.l2GasCostBufferBasisPoints,
    });
    if (routeProfitability) {
      approvedQuoteEvaluation = {
        ...approvedQuoteEvaluation,
        routeProfitability,
      };
    }
  } else if (quoteAmountRaw) {
    approvedQuoteEvaluation = {
      ...approvedQuoteEvaluation,
      routeProfitability: {
        ...approvedQuoteEvaluation.routeProfitability,
        routeGasLimit,
        gasPriceWei: gasPolicy.gasPriceRaw,
        gasPriceGwei: gasPolicy.gasPriceGwei,
        gasPriceAgeMs: getGasPriceAgeMs(rpcCache),
        gasPriceFreshnessTtlMs: getDiscoveryGasPriceFreshnessTtlMs(
          takePolicy,
          rpcCache?.chainId
        ),
        l2GasCostBufferBasisPoints: gasPolicy.l2GasCostBufferBasisPoints,
        gasPolicyEvaluatedAt: Date.now(),
      },
    };
  }

  const minExpectedProfitQuoteRaw =
    quoteTokenDecimals !== undefined && minExpectedProfitQuote !== undefined
      ? decimaledToWei(minExpectedProfitQuote, quoteTokenDecimals)
      : ZERO;
  const profitabilityApproval = applyDiscoveryApprovalProfitabilityPolicy({
    quoteEvaluation: approvedQuoteEvaluation,
    selectedFactoryLiquiditySource,
    target,
    takePolicy,
    gasPolicy,
    auctionCostQuoteRaw,
    routeGasLimit,
    minExpectedProfitQuoteRaw,
    gasCostQuoteRaw,
    quoteAmountRaw,
    price,
    rpcCache,
    approvalMode,
    countStats,
    stats,
  });
  if (!profitabilityApproval.approved) {
    return profitabilityApproval;
  }
  approvedQuoteEvaluation =
    profitabilityApproval.quoteEvaluation ?? approvedQuoteEvaluation;

  if (
    approvalMode === 'factory_gas_quote_fallback' &&
    (fallbackInputWasSubsidized ||
      isSubsidizedExternalTakeQuote(approvedQuoteEvaluation))
  ) {
    return {
      approved: false,
      reason: 'hybrid gas quote fallback rejected subsidized factory route',
      rejectCategory: 'profitFloor',
    };
  }

  logger.debug(
    `Discovered external take approved after gas/profit policy: ${formatExternalTakeGasTelemetry(
      {
        poolAddress: target.poolAddress,
        path: approvedQuoteEvaluation.externalTakePath,
        source: selectedLiquiditySource,
        routeProfitability: approvedQuoteEvaluation.routeProfitability,
        rpcCache,
        takePolicy,
        writeTransport: takeWriteTransport,
      }
    )}`
  );
  return { approved: true, quoteEvaluation: approvedQuoteEvaluation };
}

function createExternalTakeAdapterForDiscovery(params: {
  target: ResolvedTakeTarget;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  probeTimeoutMs: number;
  quoteOneInchPath: OneInchPathQuoteFn;
  quoteKeeperTakerOneInchTake: OneInchPathQuoteFn;
  quoteFactoryPath: FactoryPathQuoteFn;
  quoteLifiPath: LifiPathQuoteFn;
  approveExternalTake: DiscoveryExternalTakeApprover;
  recordOneInchCircuitOutcome: (outcome: OneInchCircuitOutcome) => void;
  recordLifiCircuitOutcome: (outcome: LifiCircuitOutcome) => void;
  stats: DiscoveredTakeTargetStats;
  config: DiscoveryExecutionConfig;
  rpcCache?: DiscoveryRpcCache;
}): ExternalTakeAdapter<ResolvedTakeTarget, DiscoveryExternalExecutionConfig> {
  const providerRegistry = createDiscoveryExternalTakeProviderRegistry({
    config: params.config,
    rpcCache: params.rpcCache,
  });

  const PROVIDER_WARN_LABEL: Record<ExternalTakePathKind, string> = {
    oneinch: '1inch',
    lifi: 'LI.FI',
    factory: 'factory',
  };

  if (params.takePolicy?.allowedExternalTakePaths !== undefined) {
    return {
      kind: 'hybrid',
      evaluateExternalTake: async ({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
      }) =>
        evaluateHybridExternalTakeForDiscovery({
          pool,
          signer,
          poolConfig,
          takePolicy: params.takePolicy,
          externalTakePaths: params.externalTakePaths,
          routeSelectionMode: params.routeSelectionMode,
          probeTimeoutMs: params.probeTimeoutMs,
          price,
          auctionPrice,
          collateral,
          quoteOneInchPath: params.quoteOneInchPath,
          quoteFactoryPath: params.quoteFactoryPath,
          quoteLifiPath: params.quoteLifiPath,
          approveExternalTake: params.approveExternalTake,
          recordOneInchCircuitOutcome: params.recordOneInchCircuitOutcome,
          recordLifiCircuitOutcome: params.recordLifiCircuitOutcome,
          stats: params.stats,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) => {
        const primaryEvaluation = liquidation.externalTakeQuoteEvaluation;
        const executionCandidates = [
          primaryEvaluation,
          ...(primaryEvaluation?.fallbackExternalTakeQuoteEvaluations ?? []),
        ].filter(
          (evaluation): evaluation is ExternalTakeQuoteEvaluation =>
            evaluation !== undefined
        );

        for (let index = 0; index < executionCandidates.length; index += 1) {
          const candidateEvaluation = executionCandidates[index];
          const selection = resolveHybridExternalTakeExecutionSelection({
            quoteEvaluation: candidateEvaluation,
            allowedExternalTakePaths: params.externalTakePaths,
          });
          if (!selection.approved) {
            logger.error(
              `Hybrid external take ${selection.reason}; refusing execution for ${pool.name}/${liquidation.borrower}`
            );
            if (index === 0) {
              return false;
            }
            continue;
          }

          const isExecutionFallbackCandidate = index > 0;
          const isGasQuoteFallbackCandidate =
            candidateEvaluation.approvalMode === 'factory_gas_quote_fallback';
          const requiresFallbackReapproval =
            isExecutionFallbackCandidate || isGasQuoteFallbackCandidate;
          if (isExecutionFallbackCandidate) {
            params.stats.hybridFallbackAttempts += 1;
          }
          if (isGasQuoteFallbackCandidate) {
            params.stats.hybridGasQuoteFallbackAttempts += 1;
          }

          let approvedEvaluation = candidateEvaluation;
          let executionLiquidation = liquidation;
          if (requiresFallbackReapproval) {
            // The primary path already passed the engine's final approval hook.
            // Fallbacks are selected inside this executor, so refresh and
            // reapprove them immediately before attempting execution.
            let refreshedStatus;
            try {
              refreshedStatus = await pool
                .getLiquidation(liquidation.borrower)
                .getStatus();
            } catch (error) {
              logger.warn(
                `Hybrid fallback path could not refresh auction state for ${pool.name}/${liquidation.borrower}: ${getErrorMessage(error)}`
              );
              continue;
            }
            executionLiquidation = {
              ...liquidation,
              auctionPrice: refreshedStatus.price,
              collateral: refreshedStatus.collateral,
            };
            const fallbackApproval = await params.approveExternalTake({
              price: Number(
                ethers.utils.formatEther(executionLiquidation.auctionPrice)
              ),
              auctionPrice: executionLiquidation.auctionPrice,
              collateral: executionLiquidation.collateral,
              quoteEvaluation: candidateEvaluation,
              countStats: false,
              forceGasRefresh: true,
            });
            if (!fallbackApproval.approved) {
              logger.debug(
                `Hybrid fallback path rejected during final approval for ${pool.name}/${liquidation.borrower}: ${
                  fallbackApproval.reason ?? 'policy rejected fallback path'
                }`
              );
              continue;
            }
            approvedEvaluation = withExternalTakeApprovalContext({
              quoteEvaluation:
                fallbackApproval.quoteEvaluation ?? candidateEvaluation,
              auctionPrice: executionLiquidation.auctionPrice,
              collateral: executionLiquidation.collateral,
            });
          }

          const selectedPath = selection.effectiveSelectedPath;
          const selectedSource = selection.selectedSource;
          const liquidationForCandidate = {
            ...executionLiquidation,
            externalTakeQuoteEvaluation: approvedEvaluation,
          };

          const provider = providerRegistry.selectExternalTakeProvider({
            selectedPath,
            selectedSource,
          });
          const attempt = await provider.execute({
            pool,
            signer,
            poolConfig,
            liquidation: liquidationForCandidate,
            config,
            selectedSource,
          });
          if (attempt.succeeded) {
            recordSuccessfulExternalTakeRouteStats(
              params.stats,
              approvedEvaluation,
              config.dryRun === true
            );
            if (isExecutionFallbackCandidate) {
              params.stats.hybridFallbackSuccesses += 1;
            }
            if (isGasQuoteFallbackCandidate) {
              params.stats.hybridGasQuoteFallbackSuccesses += 1;
            }
            return true;
          }
          if (
            attempt.preBroadcastFailed &&
            index < executionCandidates.length - 1
          ) {
            logger.warn(
              `Hybrid ${PROVIDER_WARN_LABEL[provider.path]} path failed before submission for ${pool.name}/${liquidation.borrower}; trying next approved fallback path`
            );
            continue;
          }
          return false;
        }

        logger.error(
          `Hybrid external take had no executable approved path for ${pool.name}/${liquidation.borrower}`
        );
        return false;
      },
    };
  }

  if (params.target.take.liquiditySource === LiquiditySource.ONEINCH) {
    return {
      kind: 'oneinch',
      evaluateExternalTake: async ({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
      }) =>
        params.quoteKeeperTakerOneInchTake({
          pool,
          signer,
          poolConfig,
          price,
          auctionPrice,
          collateral,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) => {
        const attempt = await providerRegistry.oneInchProvider.execute({
          pool,
          signer,
          poolConfig,
          liquidation,
          config,
        });
        if (attempt.succeeded) {
          recordSuccessfulExternalTakeRouteStats(
            params.stats,
            liquidation.externalTakeQuoteEvaluation,
            config.dryRun === true
          );
        }
        return attempt.succeeded;
      },
    };
  }

  if (params.target.take.liquiditySource === LiquiditySource.LIFI) {
    return {
      kind: 'hybrid',
      evaluateExternalTake: async ({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
      }) =>
        params.quoteLifiPath({
          pool,
          signer,
          poolConfig,
          price,
          auctionPrice,
          collateral,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) => {
        const attempt = await providerRegistry.lifiProvider.execute({
          pool,
          signer,
          poolConfig,
          liquidation,
          config,
        });
        if (attempt.succeeded) {
          recordSuccessfulExternalTakeRouteStats(
            params.stats,
            liquidation.externalTakeQuoteEvaluation,
            config.dryRun === true
          );
        } else if (attempt.circuitOpenReason) {
          logger.warn(
            `LI.FI execution refresh circuit is open for ${pool.name}/${liquidation.borrower}; skipping direct LI.FI external take`
          );
        }
        return attempt.succeeded;
      },
    };
  }

  if (params.target.take.liquiditySource !== undefined) {
    return {
      kind: 'factory',
      evaluateExternalTake: async ({
        pool,
        signer,
        poolConfig,
        auctionPrice,
        collateral,
      }) =>
        params.quoteFactoryPath({
          pool,
          signer,
          poolConfig,
          auctionPrice,
          collateral,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) => {
        const attempt = await providerRegistry.factoryProvider.execute({
          pool,
          signer,
          poolConfig,
          liquidation,
          config,
        });
        if (attempt.succeeded) {
          recordSuccessfulExternalTakeRouteStats(
            params.stats,
            liquidation.externalTakeQuoteEvaluation,
            config.dryRun === true
          );
        }
        return attempt.succeeded;
      },
    };
  }

  return oneInchAdapterModule.createNoExternalTakeAdapter();
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
  const approveExternalTake: DiscoveryExternalTakeApprover = async ({
    price,
    auctionPrice,
    collateral,
    quoteEvaluation,
    approvalMode,
    countStats = true,
    forceGasRefresh = false,
  }) =>
    approveExternalTakeForDiscovery({
      pool: params.pool,
      signer: params.signer,
      config: params.config,
      transports,
      target: params.target,
      rpcCache,
      takePolicy,
      takeWriteTransport: params.takeWriteTransport,
      stats,
      price,
      auctionPrice,
      collateral,
      quoteEvaluation,
      approvalMode,
      countStats,
      forceGasRefresh,
    });
  const externalTakePaths = resolveExternalTakePaths({
    defaultLiquiditySource: params.target.take.liquiditySource,
    allowedExternalTakePaths: takePolicy?.allowedExternalTakePaths,
  });
  const defaultFactoryLiquiditySource = resolveDefaultFactoryLiquiditySource({
    defaultLiquiditySource: params.target.take.liquiditySource,
    configuredDefaultFactoryLiquiditySource:
      takePolicy?.defaultFactoryLiquiditySource,
  });
  const factoryQuoteConfig = {
    uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
    sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
    curveRouterOverrides: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
  };
  const externalTakeProbeTimeoutMs = getExternalTakeProbeTimeoutMs(takePolicy);
  const quoteFactoryPath: FactoryPathQuoteFn = (quoteParams) =>
    quoteFactoryPathForDiscovery({
      ...quoteParams,
      config: params.config,
      transports,
      rpcCache,
      takePolicy,
      defaultFactoryLiquiditySource,
      routeProbeLimiter,
      factoryQuoteConfig,
      buildFactoryRouteProfitabilityContext,
    });
  const quoteOneInchPath: OneInchPathQuoteFn = (quoteParams) =>
    quoteOneInchPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache,
      takePolicy,
      recordCircuitOutcome: false,
      routeProbeLimiter,
      probeTimeoutMs: externalTakeProbeTimeoutMs,
      getTokenDecimalsCache: getDiscoveryTokenDecimalsCache,
    });
  const quoteKeeperTakerOneInchTake: OneInchPathQuoteFn = (quoteParams) =>
    quoteKeeperTakerOneInchTakeForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache,
      takePolicy,
      routeProbeLimiter,
      probeTimeoutMs: externalTakeProbeTimeoutMs,
      getTokenDecimalsCache: getDiscoveryTokenDecimalsCache,
    });
  const quoteLifiPath: LifiPathQuoteFn = (quoteParams) =>
    quoteLifiPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache,
      takePolicy,
      recordCircuitOutcome: quoteParams.recordCircuitOutcome,
      routeProbeLimiter,
      probeTimeoutMs: externalTakeProbeTimeoutMs,
      getTokenDecimalsCache: getDiscoveryTokenDecimalsCache,
    });
  const recordOneInchCircuitOutcome = (
    outcome: OneInchCircuitOutcome,
    purpose?: OneInchQuoteCircuitPurpose
  ): void => {
    recordOneInchCircuitOutcomeForDiscovery({
      rpcCache,
      takePolicy,
      outcome,
      purpose,
    });
  };
  const recordLifiCircuitOutcome = (
    outcome: LifiCircuitOutcome,
    purpose?: LifiCircuitPurpose
  ): void => {
    recordLifiCircuitOutcomeForDiscovery({
      rpcCache,
      config: params.config,
      outcome,
      purpose,
    });
  };
  let externalTakeAttemptedSubmission = false;
  const recordExternalTakeExecutionFailure =
    (path: 'oneinch' | 'factory' | 'lifi') =>
    (result: { preBroadcast: boolean; error?: string }): void => {
      const pathCounters = getExternalTakePathCounters(
        stats,
        path as ExternalTakePathKind
      );
      if (result.preBroadcast) {
        pathCounters.preBroadcastFailures += 1;
      } else {
        pathCounters.postSubmissionFailures += 1;
      }

      if (path === 'oneinch') {
        if (result.preBroadcast) {
          stats.oneInchPreBroadcastFailures += 1;
        } else {
          stats.oneInchPostSubmissionFailures += 1;
        }
      } else if (path === 'factory' && result.preBroadcast) {
        stats.factoryPreBroadcastFailures += 1;
      } else if (path === 'factory') {
        stats.factoryPostSubmissionFailures += 1;
      }

      if (!result.preBroadcast) {
        externalTakeAttemptedSubmission = true;
      }
    };
  const externalTakeAdapter = createExternalTakeAdapterForDiscovery({
    target: params.target,
    takePolicy,
    externalTakePaths,
    routeSelectionMode: normalizeExternalTakeRouteSelectionMode(
      takePolicy?.externalTakeRouteSelectionMode
    ),
    probeTimeoutMs: externalTakeProbeTimeoutMs,
    quoteOneInchPath,
    quoteKeeperTakerOneInchTake,
    quoteFactoryPath,
    quoteLifiPath,
    approveExternalTake,
    recordOneInchCircuitOutcome,
    recordLifiCircuitOutcome,
    stats,
    config: params.config,
    rpcCache,
  });

  const externalExecutionConfig = {
    dryRun: params.target.dryRun,
    connectorTokens: params.config.connectorTokens,
    oneInchAggregationExecutorAllowlist:
      params.config.oneInchAggregationExecutorAllowlist,
    oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
    oneInchRouters: params.config.oneInchRouters,
    keeperTaker: params.config.keeperTaker,
    keeperTakerFactory: params.config.keeperTakerFactory,
    lifi: params.config.lifi,
    lifiTaker:
      params.config.lifiTaker ??
      lifiExecutionModule.getLifiTakerAddress(params.config.takerContracts),
    uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
    sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
    curveRouterOverrides: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
    takeWriteTransport: params.takeWriteTransport,
    runtimeCache: rpcCache?.factoryQuoteProviders,
    oneInchRequestTimeoutMs: getOneInchQuoteTimeoutMs(takePolicy),
    chainId: rpcCache?.chainId,
    tokenDecimalsCache: getDiscoveryTokenDecimalsCache(rpcCache),
    onOneInchSwapDataResult: (result: {
      success: boolean;
      retryable?: boolean;
      errorCode?: number | string;
      error?: string;
    }) => {
      if (result.success) {
        recordOneInchCircuitOutcome('success', 'swap_data');
        return;
      }
      stats.oneInchSwapDataFailures += 1;
      if (result.retryable !== false) {
        recordOneInchCircuitOutcome('failure', 'swap_data');
      }
    },
    onOneInchExecutionFailure: recordExternalTakeExecutionFailure('oneinch'),
    onFactoryExecutionFailure: recordExternalTakeExecutionFailure('factory'),
    onLifiQuoteResult: (result: {
      success: boolean;
      retryable?: boolean;
      errorCode?: number | string;
      error?: string;
    }) => {
      recordLifiCircuitOutcome(
        result.success
          ? 'success'
          : result.retryable === true
            ? 'failure'
            : 'neutral',
        'execution_refresh'
      );
      if (!result.success) {
        logger.debug(
          `LI.FI execution quote refresh failed: ${result.error ?? result.errorCode ?? 'unknown error'}`
        );
      }
    },
    onLifiExecutionFailure: recordExternalTakeExecutionFailure('lifi'),
  };

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
          resetExternalTakeAttemptSubmission: () => {
            externalTakeAttemptedSubmission = false;
          },
          didExternalTakeAttemptSubmission: () =>
            externalTakeAttemptedSubmission,
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
                quoteEvaluation: approval.quoteEvaluation ?? quoteEvaluation,
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
