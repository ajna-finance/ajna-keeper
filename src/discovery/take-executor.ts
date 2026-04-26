import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  ExternalTakePathKind,
  ExternalTakeRouteSelectionMode,
  LiquiditySource,
  LiquiditySourceMap,
  TakeWriteTransportMode,
  getAutoDiscoverTakePolicy,
} from '../config';
import { ResolvedTakeTarget } from './targets';
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
import * as takeModule from '../take';
import * as takeFactoryModule from '../take/factory';
import { ExternalTakeAdapter, processTakeCandidates } from '../take/engine';
import { ExternalTakeQuoteEvaluation } from '../take/types';
import { TakeWriteTransport } from '../take/write-transport';
import { FactoryRouteProfitabilityContext } from '../take/factory';
import {
  applyFactoryRouteProfitabilityPolicy,
  deriveApprovedMinOutRaw,
  maxBigNumber,
} from '../take/factory/shared';
import { decimaledToWei, withTimeout } from '../utils';
import { getDecimalsErc20 } from '../erc20';
import { createDiscoveryRpcCache } from './rpc-cache';
import {
  getOneInchCircuitOpenReason,
  getOneInchQuoteTimeoutMs,
  recordOneInchQuoteFailure,
  recordOneInchQuoteSuccess,
} from './one-inch-circuit';

// Conservative per-route execution limits used for profitability screening.
// Operators can override these with autoDiscover.take.dexGasOverrides.
const EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(900000);
const CURVE_EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(1_500_000);
const ARB_TAKE_GAS_LIMIT = BigNumber.from(450000);
const WAD = ethers.constants.WeiPerEther;
const ZERO = BigNumber.from(0);
const BASIS_POINTS_DENOMINATOR = BigNumber.from(10_000);
const DEFAULT_EXTERNAL_TAKE_ROUTE_SELECTION_MODE: ExternalTakeRouteSelectionMode =
  'maximize_profit';

type AutoDiscoverTakePolicyRuntime = ReturnType<
  typeof getAutoDiscoverTakePolicy
>;
type OneInchCircuitOutcome = 'success' | 'failure';

function isDynamicFactorySource(
  source: LiquiditySource | undefined
): source is
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.SUSHISWAP
  | LiquiditySource.CURVE {
  return (
    source === LiquiditySource.UNISWAPV3 ||
    source === LiquiditySource.SUSHISWAP ||
    source === LiquiditySource.CURVE
  );
}

function getFactoryRouteSelectionSources(
  defaultLiquiditySource: LiquiditySource | undefined,
  allowedLiquiditySources?: LiquiditySource[]
): LiquiditySource[] {
  if (allowedLiquiditySources?.length) {
    return Array.from(new Set(allowedLiquiditySources)).filter(
      isDynamicFactorySource
    );
  }

  return isDynamicFactorySource(defaultLiquiditySource)
    ? [defaultLiquiditySource]
    : [];
}

function getExternalTakePaths(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  allowedExternalTakePaths?: ExternalTakePathKind[];
}): ExternalTakePathKind[] {
  if (params.allowedExternalTakePaths?.length) {
    return Array.from(new Set(params.allowedExternalTakePaths));
  }
  if (params.defaultLiquiditySource === LiquiditySource.ONEINCH) {
    return ['oneinch'];
  }
  if (isDynamicFactorySource(params.defaultLiquiditySource)) {
    return ['factory'];
  }
  return [];
}

function getDefaultFactoryLiquiditySource(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  configuredDefaultFactoryLiquiditySource?: LiquiditySource;
}): LiquiditySource | undefined {
  if (isDynamicFactorySource(params.defaultLiquiditySource)) {
    return params.defaultLiquiditySource;
  }
  return isDynamicFactorySource(params.configuredDefaultFactoryLiquiditySource)
    ? params.configuredDefaultFactoryLiquiditySource
    : undefined;
}

function withTakeLiquiditySource<T extends ResolvedTakeTarget>(
  target: T,
  liquiditySource: LiquiditySource
): T {
  return {
    ...target,
    take: {
      ...target.take,
      liquiditySource,
    },
  };
}

function rankExternalTakeQuote(
  evaluation: ExternalTakeQuoteEvaluation
): BigNumber | undefined {
  return (
    evaluation.routeProfitability?.expectedNetProfitQuoteRaw ??
    evaluation.quoteAmountRaw
  );
}

function compareBigNumberDescending(
  left: BigNumber | undefined,
  right: BigNumber | undefined
): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  return left.eq(right) ? 0 : left.gt(right) ? -1 : 1;
}

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
  return delta.mul(BASIS_POINTS_DENOMINATOR).div(evaluatedGasPrice).toNumber();
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

function formatLiquiditySource(source: LiquiditySource | undefined): string {
  return source !== undefined
    ? (LiquiditySource[source] ?? String(source))
    : 'n/a';
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
  return (
    `pool=${params.poolAddress}` +
    ` borrower=${params.borrower ?? 'n/a'}` +
    ` path=${params.path ?? 'n/a'}` +
    ` source=${formatLiquiditySource(params.source)}` +
    ` evaluatedGasGwei=${routeProfitability?.gasPriceGwei ?? 'n/a'}` +
    ` currentGasWei=${currentGasPrice?.toString() ?? 'n/a'}` +
    ` gasAgeMs=${gasAgeMs ?? 'n/a'}` +
    ` gasTtlMs=${routeProfitability?.gasPriceFreshnessTtlMs ?? ttlMs}` +
    ` gasDriftBps=${driftBps ?? 'n/a'}` +
    ` l2BufferBps=${routeProfitability?.l2GasCostBufferBasisPoints ?? getEffectiveL2GasCostBufferBasisPoints(params.takePolicy, chainId) ?? 'n/a'}` +
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
    paths?.includes('oneinch') &&
    paths.includes('factory') &&
    getExternalTakeRouteSelectionMode(takePolicy) === 'maximize_profit'
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
  if (params.quoteTokenDecimals === 18) {
    return quoteDueWad;
  }
  if (params.quoteTokenDecimals < 18) {
    const scale = BigNumber.from(10).pow(18 - params.quoteTokenDecimals);
    return quoteDueWad.add(scale.sub(1)).div(scale);
  }
  return quoteDueWad.mul(
    BigNumber.from(10).pow(params.quoteTokenDecimals - 18)
  );
}

function formatSignedQuoteAmount(params: {
  rawAmount: BigNumber;
  quoteTokenDecimals: number;
  negative?: boolean;
}): string {
  const formatted = ethers.utils.formatUnits(
    params.rawAmount,
    params.quoteTokenDecimals
  );
  return params.negative ? `-${formatted}` : formatted;
}

function getExternalTakeProbeTimeoutMs(
  takePolicy: AutoDiscoverTakePolicyRuntime
): number {
  return (
    takePolicy?.externalTakeProbeTimeoutMs ??
    getOneInchQuoteTimeoutMs(takePolicy)
  );
}

function getExternalTakeRouteSelectionMode(
  takePolicy: AutoDiscoverTakePolicyRuntime
): ExternalTakeRouteSelectionMode {
  return (
    takePolicy?.externalTakeRouteSelectionMode ??
    DEFAULT_EXTERNAL_TAKE_ROUTE_SELECTION_MODE
  );
}

function applySimpleQuoteProfitability(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  auctionCostQuoteRaw: BigNumber;
  routeGasLimit: BigNumber;
  gasCostQuoteRaw?: BigNumber;
  gasPriceRaw?: BigNumber;
  gasPriceGwei?: number;
  gasPriceAgeMs?: number;
  gasPriceFreshnessTtlMs?: number;
  l2GasCostBufferBasisPoints?: number;
}): void {
  const quoteAmountRaw = params.quoteEvaluation.quoteAmountRaw;
  if (!quoteAmountRaw) {
    return;
  }

  const routeExecutionCostQuoteRaw = params.gasCostQuoteRaw ?? ZERO;
  const breakEvenQuoteAmountRaw = params.auctionCostQuoteRaw.add(
    routeExecutionCostQuoteRaw
  );
  params.quoteEvaluation.routeProfitability = {
    ...params.quoteEvaluation.routeProfitability,
    auctionRepayRequirementQuoteRaw:
      params.quoteEvaluation.routeProfitability
        ?.auctionRepayRequirementQuoteRaw ?? params.auctionCostQuoteRaw,
    routeExecutionCostQuoteRaw,
    expectedNetProfitQuoteRaw: quoteAmountRaw.gte(breakEvenQuoteAmountRaw)
      ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
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
        `Shared discovery gas price fetch failed: ${error instanceof Error ? error.message : String(error)}`
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
    logger.warn(
      `Discovery gas price fetch failed: ${error instanceof Error ? error.message : String(error)}`
    );
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
  takePolicy: ReturnType<typeof getAutoDiscoverTakePolicy>;
}): Promise<FactoryRouteProfitabilityContext | undefined> {
  const sources =
    params.sources ??
    getFactoryRouteSelectionSources(
      params.defaultLiquiditySource,
      params.takePolicy?.allowedLiquiditySources
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
    params.pool.quoteAddress
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
          `Rejecting route source ${LiquiditySource[source] ?? source} because quote-denominated gas conversion failed: ${gasPolicy.reason ?? 'route gas policy rejected source'}`
        );
      }
      routeRejectionReasonsBySource[source] =
        gasPolicy.reason ?? 'route gas policy rejected source';
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
    routeRejectionReasonsBySource,
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

interface DiscoveredTakeTargetStats {
  candidateCount: number;
  approvedTakeDecisions: number;
  approvedArbTakeDecisions: number;
  evaluationSkips: number;
  revalidationSkips: number;
  executionSkips: number;
  gasPolicyRejects: number;
  profitFloorRejects: number;
  arbProfitUnavailableRejects: number;
  executedExternalTakes: number;
  executedArbTakes: number;
}

interface ExternalTakeApprovalInput {
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  countStats?: boolean;
  forceGasRefresh?: boolean;
}

type ExternalTakeApprovalRejectCategory = 'gasPolicy' | 'profitFloor';

interface ExternalTakeApprovalResult {
  approved: boolean;
  reason?: string;
  rejectCategory?: ExternalTakeApprovalRejectCategory;
}

interface FactoryPathQuoteInput {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  auctionPrice: BigNumber;
  collateral: BigNumber;
}

interface OneInchPathQuoteInput extends FactoryPathQuoteInput {
  price: number;
}

type DiscoveryExternalTakeApprover = (
  approvalParams: ExternalTakeApprovalInput
) => Promise<ExternalTakeApprovalResult>;

type FactoryPathQuoteFn = (
  quoteParams: FactoryPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

type OneInchPathQuoteFn = (
  quoteParams: OneInchPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

interface HandleDiscoveredTakeTargetParamsBase {
  pool: FungiblePool;
  signer: Signer;
  takeWriteTransport?: TakeWriteTransport;
  target: ResolvedTakeTarget;
  rpcCache?: DiscoveryRpcCache;
  onCandidateInactive?: (candidate: {
    poolAddress: string;
    borrower: string;
  }) => void;
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

type DiscoveryExternalExecutionConfig = Pick<
  DiscoveryExecutionConfig,
  | 'connectorTokens'
  | 'curveRouterOverrides'
  | 'delayBetweenActions'
  | 'dryRun'
  | 'keeperTaker'
  | 'keeperTakerFactory'
  | 'oneInchRouters'
  | 'sushiswapRouterOverrides'
  | 'tokenAddresses'
  | 'universalRouterOverrides'
> & {
  takeWriteTransport?: TakeWriteTransport;
  runtimeCache?: DiscoveryRpcCache['factoryQuoteProviders'];
  oneInchRequestTimeoutMs?: number;
  skipOneInchRateLimitDelay?: boolean;
};

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
  logger.info(
    `Discovered take target summary: pool=${params.pool.poolAddress} name="${params.target.name}" source=${params.target.take.liquiditySource ?? 'none'} dryRun=${params.target.dryRun} candidates=${params.stats.candidateCount} approvedTakeDecisions=${params.stats.approvedTakeDecisions} approvedArbTakeDecisions=${params.stats.approvedArbTakeDecisions} evaluationSkips=${params.stats.evaluationSkips} revalidationSkips=${params.stats.revalidationSkips} executionSkips=${params.stats.executionSkips} gasPolicyRejects=${params.stats.gasPolicyRejects} profitFloorRejects=${params.stats.profitFloorRejects} arbProfitUnavailableRejects=${params.stats.arbProfitUnavailableRejects} executedExternalTakes=${params.stats.executedExternalTakes} executedArbTakes=${params.stats.executedArbTakes}`
  );
}

function isInactiveAuctionSkipReason(reason: string): boolean {
  return (
    reason.includes('auction no longer has collateral onchain') ||
    reason.includes(
      'approved external take quote no longer matches collateral'
    ) ||
    reason.includes(
      'approved external take quote is stale after auction price increased'
    ) ||
    reason.includes('onchain revalidation changed the auction state')
  );
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

  let selectedLiquiditySource = quoteEvaluation.selectedLiquiditySource;
  if (selectedLiquiditySource === undefined) {
    const configuredLiquiditySource = target.take.liquiditySource;
    if (
      configuredLiquiditySource !== LiquiditySource.ONEINCH &&
      isDynamicFactorySource(configuredLiquiditySource)
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
    isDynamicFactorySource(selectedLiquiditySource)
      ? selectedLiquiditySource
      : undefined;
  if (selectedLiquiditySource !== undefined && !params.forceGasRefresh) {
    const freshness = hasFreshFactoryRouteGasPolicy({
      quoteEvaluation,
      currentGasPrice: rpcCache?.gasPrice,
      chainId: rpcCache?.chainId,
      takePolicy,
    });
    if (freshness.fresh) {
      logger.debug(
        `Discovered external take using fresh gas policy: ${formatExternalTakeGasTelemetry(
          {
            poolAddress: target.poolAddress,
            path: quoteEvaluation.externalTakePath,
            source: selectedLiquiditySource,
            routeProfitability: quoteEvaluation.routeProfitability,
            rpcCache,
            takePolicy,
            writeTransport: takeWriteTransport,
          }
        )}`
      );
      return { approved: true };
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
      quoteEvaluation,
      currentGasPrice: rpcCache?.gasPrice,
      chainId: rpcCache?.chainId,
      takePolicy,
    });
    if (refreshedFreshness.fresh) {
      logger.debug(
        `Discovered external take gas drift check passed: ${formatExternalTakeGasTelemetry(
          {
            poolAddress: target.poolAddress,
            path: quoteEvaluation.externalTakePath,
            source: selectedLiquiditySource,
            routeProfitability: quoteEvaluation.routeProfitability,
            rpcCache,
            takePolicy,
            writeTransport: takeWriteTransport,
          }
        )}`
      );
      return { approved: true };
    }
    if (refreshedFreshness.reason) {
      logger.debug(
        `Refreshing discovered external take gas policy because ${refreshedFreshness.reason}: ${formatExternalTakeGasTelemetry(
          {
            poolAddress: target.poolAddress,
            path: quoteEvaluation.externalTakePath,
            source: selectedLiquiditySource,
            routeProfitability: quoteEvaluation.routeProfitability,
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
    requireGasCostQuote: requiresHybridNetProfitRanking(takePolicy),
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
          path: quoteEvaluation.externalTakePath,
          source: selectedLiquiditySource,
          routeProfitability: quoteEvaluation.routeProfitability,
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
    };
  }

  const quoteAmountRaw = quoteEvaluation.quoteAmountRaw;
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
    quoteTokenDecimals = await getDecimalsErc20(signer, pool.quoteAddress);
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
    applySimpleQuoteProfitability({
      quoteEvaluation,
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
  } else if (quoteAmountRaw) {
    quoteEvaluation.routeProfitability = {
      ...quoteEvaluation.routeProfitability,
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
    };
  }

  if (hasQuoteProfitFloor) {
    const minExpectedProfitQuoteRaw =
      quoteTokenDecimals !== undefined && minExpectedProfitQuote !== undefined
        ? decimaledToWei(minExpectedProfitQuote, quoteTokenDecimals)
        : ZERO;
    const canApplyFactoryProfitability =
      selectedFactoryLiquiditySource !== undefined &&
      quoteAmountRaw !== undefined &&
      gasCostQuoteRaw !== undefined &&
      quoteTokenDecimals !== undefined;

    if (canApplyFactoryProfitability) {
      const refreshedEvaluation = applyFactoryRouteProfitabilityPolicy({
        evaluation: quoteEvaluation,
        liquiditySource: selectedFactoryLiquiditySource,
        context: {
          routeExecutionCostQuoteRawBySource: {
            [selectedFactoryLiquiditySource]: gasCostQuoteRaw,
          },
          nativeProfitFloorQuoteRawBySource: {
            [selectedFactoryLiquiditySource]:
              gasPolicy.minProfitNativeQuoteRaw ?? ZERO,
          },
          configuredProfitFloorQuoteRaw: minExpectedProfitQuoteRaw,
          routeGasLimitBySource: {
            [selectedFactoryLiquiditySource]: routeGasLimit,
          },
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
      });
      Object.assign(quoteEvaluation, refreshedEvaluation);
      if (!refreshedEvaluation.isTakeable) {
        if (countStats) {
          stats.profitFloorRejects += 1;
        }
        return {
          approved: false,
          reason:
            refreshedEvaluation.reason ??
            'route quote below required output floor',
          rejectCategory: 'profitFloor',
        };
      }
    } else {
      if (
        quoteAmountRaw &&
        gasCostQuoteRaw &&
        quoteTokenDecimals !== undefined &&
        auctionCostQuoteRaw
      ) {
        const breakEvenQuoteAmountRaw =
          auctionCostQuoteRaw.add(gasCostQuoteRaw);
        const minProfitNativeQuoteRaw =
          gasPolicy.minProfitNativeQuoteRaw ?? ZERO;
        const requiredProfitFloorRaw = maxBigNumber(
          minExpectedProfitQuoteRaw,
          minProfitNativeQuoteRaw
        );
        const requiredQuoteAmountRaw = breakEvenQuoteAmountRaw.add(
          requiredProfitFloorRaw
        );
        const routeMinOutRaw =
          quoteEvaluation.routeMinOutRaw ??
          (quoteEvaluation.profitMinOutRaw
            ? undefined
            : quoteEvaluation.approvedMinOutRaw);
        quoteEvaluation.routeMinOutRaw = routeMinOutRaw;
        quoteEvaluation.profitMinOutRaw = requiredQuoteAmountRaw;
        quoteEvaluation.approvedMinOutRaw =
          deriveApprovedMinOutRaw({
            routeMinOutRaw,
            profitMinOutRaw: requiredQuoteAmountRaw,
          }) ?? requiredQuoteAmountRaw;
        quoteEvaluation.routeProfitability = {
          ...quoteEvaluation.routeProfitability,
          routeExecutionCostQuoteRaw: gasCostQuoteRaw,
          configuredProfitFloorQuoteRaw: minExpectedProfitQuoteRaw,
          nativeProfitFloorQuoteRaw: minProfitNativeQuoteRaw,
          requiredProfitFloorQuoteRaw: requiredProfitFloorRaw,
          requiredOutputFloorQuoteRaw: requiredQuoteAmountRaw,
          expectedNetProfitQuoteRaw: quoteAmountRaw.gte(breakEvenQuoteAmountRaw)
            ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
            : ZERO,
          surplusOverFloorQuoteRaw: quoteAmountRaw.gte(requiredQuoteAmountRaw)
            ? quoteAmountRaw.sub(requiredQuoteAmountRaw)
            : ZERO,
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
        };
        if (quoteAmountRaw.lt(requiredQuoteAmountRaw)) {
          const expectedProfitRaw = quoteAmountRaw.gte(breakEvenQuoteAmountRaw)
            ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
            : breakEvenQuoteAmountRaw.sub(quoteAmountRaw);
          if (countStats) {
            stats.profitFloorRejects += 1;
          }
          return {
            approved: false,
            reason: `expected take profit ${formatSignedQuoteAmount({
              rawAmount: expectedProfitRaw,
              quoteTokenDecimals,
              negative: quoteAmountRaw.lt(breakEvenQuoteAmountRaw),
            })} below required profit floor`,
            rejectCategory: 'profitFloor',
          };
        }
      } else {
        if (takePolicy?.minProfitNative !== undefined) {
          if (countStats) {
            stats.profitFloorRejects += 1;
          }
          return {
            approved: false,
            reason: 'quote-normalized minProfitNative floor is not available',
            rejectCategory: 'profitFloor',
          };
        }
        const auctionCostQuote =
          price * (quoteEvaluation.collateralAmount ?? 0);
        const expectedProfit =
          (quoteEvaluation.quoteAmount ?? 0) -
          auctionCostQuote -
          gasPolicy.gasCostQuote;
        if (
          minExpectedProfitQuote !== undefined &&
          expectedProfit < minExpectedProfitQuote
        ) {
          if (countStats) {
            stats.profitFloorRejects += 1;
          }
          return {
            approved: false,
            reason: `expected take profit ${expectedProfit.toFixed(6)} below minExpectedProfitQuote ${minExpectedProfitQuote}`,
            rejectCategory: 'profitFloor',
          };
        }
      }
    }
  }

  logger.debug(
    `Discovered external take approved after gas/profit policy: ${formatExternalTakeGasTelemetry(
      {
        poolAddress: target.poolAddress,
        path: quoteEvaluation.externalTakePath,
        source: selectedLiquiditySource,
        routeProfitability: quoteEvaluation.routeProfitability,
        rpcCache,
        takePolicy,
        writeTransport: takeWriteTransport,
      }
    )}`
  );
  return { approved: true };
}

async function quoteFactoryPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    transports: DiscoveryReadTransports;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    defaultFactoryLiquiditySource: LiquiditySource | undefined;
    factoryQuoteConfig: {
      universalRouterOverrides: DiscoveryExecutionConfig['universalRouterOverrides'];
      sushiswapRouterOverrides: DiscoveryExecutionConfig['sushiswapRouterOverrides'];
      curveRouterOverrides: DiscoveryExecutionConfig['curveRouterOverrides'];
      tokenAddresses: DiscoveryExecutionConfig['tokenAddresses'];
    };
  } & FactoryPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  if (params.defaultFactoryLiquiditySource === undefined) {
    return {
      isTakeable: false,
      externalTakePath: 'factory',
      reason: 'factory external take path is not configured',
    };
  }
  const factoryPoolConfig = withTakeLiquiditySource(
    params.poolConfig,
    params.defaultFactoryLiquiditySource
  );
  const routeProfitabilityContextFactory = async (sources: LiquiditySource[]) =>
    await buildFactoryRouteProfitabilityContext({
      pool: params.pool,
      signer: params.signer,
      config: params.config,
      transports: params.transports,
      rpcCache: params.rpcCache,
      defaultLiquiditySource: params.defaultFactoryLiquiditySource,
      sources,
      takePolicy: params.takePolicy,
    });

  const evaluation = await takeFactoryModule.getFactoryTakeQuoteEvaluation(
    params.pool,
    params.auctionPrice,
    params.collateral,
    factoryPoolConfig,
    params.factoryQuoteConfig,
    params.signer,
    params.rpcCache?.factoryQuoteProviders,
    {
      allowedLiquiditySources: params.takePolicy?.allowedLiquiditySources,
      routeQuoteBudgetPerCandidate:
        params.takePolicy?.takeRouteQuoteBudgetPerCandidate,
      routeProfitabilityContextFactory,
    }
  );
  return {
    ...evaluation,
    externalTakePath: 'factory',
    quotedAuctionPriceWad:
      evaluation.quotedAuctionPriceWad ?? params.auctionPrice,
    quotedCollateralWad: evaluation.quotedCollateralWad ?? params.collateral,
  };
}

async function quoteOneInchPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    recordCircuitOutcome?: boolean;
  } & OneInchPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  const circuitOpenReason = getOneInchCircuitOpenReason({
    rpcCache: params.rpcCache,
    takePolicy: params.takePolicy,
  });
  if (circuitOpenReason) {
    return {
      isTakeable: false,
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: circuitOpenReason,
    };
  }

  let evaluation: ExternalTakeQuoteEvaluation;
  const oneInchRequestTimeoutMs = getOneInchQuoteTimeoutMs(params.takePolicy);
  try {
    evaluation = await withTimeout(
      takeModule.getOneInchPathQuoteEvaluation(
        params.pool,
        params.price,
        params.collateral,
        params.poolConfig,
        {
          delayBetweenActions: params.config.delayBetweenActions,
          oneInchRequestTimeoutMs,
          skipOneInchRateLimitDelay: true,
        },
        params.signer,
        params.config.oneInchRouters,
        params.config.connectorTokens
      ),
      getExternalTakeProbeTimeoutMs(params.takePolicy),
      '1inch external take quote'
    );
  } catch (error) {
    if (params.recordCircuitOutcome !== false) {
      recordOneInchQuoteFailure({
        rpcCache: params.rpcCache,
        takePolicy: params.takePolicy,
      });
    }
    return {
      isTakeable: false,
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: error instanceof Error ? error.message : String(error),
      quoteFailureRetryable: true,
      quoteFailureCode: 'exception',
    };
  }

  if (params.recordCircuitOutcome !== false) {
    if (evaluation.quoteFailureRetryable) {
      recordOneInchQuoteFailure({
        rpcCache: params.rpcCache,
        takePolicy: params.takePolicy,
      });
    } else {
      recordOneInchQuoteSuccess(params.rpcCache);
    }
  }

  return {
    ...evaluation,
    externalTakePath: 'oneinch',
    selectedLiquiditySource:
      evaluation.selectedLiquiditySource ?? LiquiditySource.ONEINCH,
    quotedAuctionPriceWad: params.auctionPrice,
    quotedCollateralWad: params.collateral,
  };
}

async function quoteLegacyOneInchTakeForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
  } & OneInchPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  const circuitOpenReason = getOneInchCircuitOpenReason({
    rpcCache: params.rpcCache,
    takePolicy: params.takePolicy,
  });
  if (circuitOpenReason) {
    return {
      isTakeable: false,
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: circuitOpenReason,
    };
  }

  let evaluation: ExternalTakeQuoteEvaluation;
  const oneInchRequestTimeoutMs = getOneInchQuoteTimeoutMs(params.takePolicy);
  try {
    evaluation = await withTimeout(
      takeModule.getOneInchTakeQuoteEvaluation(
        params.pool,
        params.price,
        params.collateral,
        params.poolConfig,
        {
          delayBetweenActions: params.config.delayBetweenActions,
          oneInchRequestTimeoutMs,
          skipOneInchRateLimitDelay: true,
        },
        params.signer,
        params.config.oneInchRouters,
        params.config.connectorTokens
      ),
      getExternalTakeProbeTimeoutMs(params.takePolicy),
      '1inch external take quote'
    );
  } catch (error) {
    recordOneInchQuoteFailure({
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
    });
    return {
      isTakeable: false,
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: error instanceof Error ? error.message : String(error),
      quoteFailureRetryable: true,
      quoteFailureCode: 'exception',
    };
  }

  if (evaluation.quoteFailureRetryable) {
    recordOneInchQuoteFailure({
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
    });
  } else {
    recordOneInchQuoteSuccess(params.rpcCache);
  }

  return {
    ...evaluation,
    externalTakePath: 'oneinch',
    selectedLiquiditySource:
      evaluation.selectedLiquiditySource ?? LiquiditySource.ONEINCH,
    quotedAuctionPriceWad: params.auctionPrice,
    quotedCollateralWad: params.collateral,
  };
}

async function evaluateHybridExternalTakeForDiscovery(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ExternalTakeRouteSelectionMode;
  probeTimeoutMs: number;
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  quoteOneInchPath: OneInchPathQuoteFn;
  quoteFactoryPath: FactoryPathQuoteFn;
  approveExternalTake: DiscoveryExternalTakeApprover;
  recordOneInchCircuitOutcome: (outcome: OneInchCircuitOutcome) => void;
  stats: Pick<
    DiscoveredTakeTargetStats,
    'gasPolicyRejects' | 'profitFloorRejects'
  >;
}): Promise<ExternalTakeQuoteEvaluation> {
  const pathOrder = new Map<ExternalTakePathKind, number>(
    params.externalTakePaths.map((path, index) => [path, index])
  );
  const getProbeOrder = (): ExternalTakePathKind[] => {
    if (params.routeSelectionMode !== 'factory_first') {
      return params.externalTakePaths;
    }
    return [...params.externalTakePaths].sort((left, right) => {
      if (left === right) {
        return 0;
      }
      if (left === 'factory') {
        return -1;
      }
      if (right === 'factory') {
        return 1;
      }
      return (pathOrder.get(left) ?? 0) - (pathOrder.get(right) ?? 0);
    });
  };
  type ProbeResult = {
    path: ExternalTakePathKind;
    durationMs: number;
    evaluation?: ExternalTakeQuoteEvaluation;
    reason?: string;
    rejectCategory?: ExternalTakeApprovalRejectCategory;
    oneInchCircuitOutcome?: OneInchCircuitOutcome;
  };
  const getOneInchCircuitOutcome = (
    evaluation: ExternalTakeQuoteEvaluation
  ): OneInchCircuitOutcome | undefined => {
    if (evaluation.reason?.startsWith('1inch quote circuit open')) {
      return undefined;
    }
    return evaluation.quoteFailureRetryable ? 'failure' : 'success';
  };
  const probeExternalTakePath = async (
    path: ExternalTakePathKind
  ): Promise<ProbeResult> => {
    const startedAt = Date.now();
    let oneInchCircuitOutcome: OneInchCircuitOutcome | undefined;
    try {
      const evaluation =
        path === 'oneinch'
          ? await params.quoteOneInchPath({
              pool: params.pool,
              signer: params.signer,
              poolConfig: params.poolConfig,
              price: params.price,
              auctionPrice: params.auctionPrice,
              collateral: params.collateral,
            })
          : await params.quoteFactoryPath({
              pool: params.pool,
              signer: params.signer,
              poolConfig: params.poolConfig,
              auctionPrice: params.auctionPrice,
              collateral: params.collateral,
            });
      oneInchCircuitOutcome =
        path === 'oneinch' ? getOneInchCircuitOutcome(evaluation) : undefined;
      if (!evaluation.isTakeable) {
        return {
          path,
          durationMs: Date.now() - startedAt,
          reason: evaluation.reason ?? 'not takeable',
          oneInchCircuitOutcome,
        };
      }

      const approval = await params.approveExternalTake({
        price: params.price,
        auctionPrice: params.auctionPrice,
        collateral: params.collateral,
        quoteEvaluation: evaluation,
        countStats: false,
      });
      if (!approval.approved) {
        return {
          path,
          durationMs: Date.now() - startedAt,
          reason: approval.reason ?? 'policy rejected path',
          rejectCategory: approval.rejectCategory,
          oneInchCircuitOutcome,
        };
      }
      return {
        path,
        durationMs: Date.now() - startedAt,
        evaluation,
        oneInchCircuitOutcome,
      };
    } catch (error) {
      return {
        path,
        durationMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : String(error),
        oneInchCircuitOutcome:
          path === 'oneinch' ? (oneInchCircuitOutcome ?? 'failure') : undefined,
      };
    }
  };
  const recordProbeCircuitOutcome = (result: ProbeResult): void => {
    if (result.oneInchCircuitOutcome) {
      params.recordOneInchCircuitOutcome(result.oneInchCircuitOutcome);
    }
  };

  const withProbeTimeout = async (
    path: ExternalTakePathKind
  ): Promise<ProbeResult> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        probeExternalTakePath(path),
        new Promise<ProbeResult>((resolve) => {
          timeout = setTimeout(() => {
            resolve({
              path,
              durationMs: params.probeTimeoutMs,
              reason: `probe timed out after ${params.probeTimeoutMs}ms`,
              oneInchCircuitOutcome: path === 'oneinch' ? 'failure' : undefined,
            });
          }, params.probeTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };

  const probeOrder = getProbeOrder();
  const probeResults: ProbeResult[] =
    params.routeSelectionMode === 'factory_first'
      ? []
      : await Promise.all(probeOrder.map(withProbeTimeout));
  if (params.routeSelectionMode !== 'factory_first') {
    probeResults.forEach(recordProbeCircuitOutcome);
  }
  if (params.routeSelectionMode === 'factory_first') {
    for (const path of probeOrder) {
      const result = await withProbeTimeout(path);
      probeResults.push(result);
      recordProbeCircuitOutcome(result);
      if (result.evaluation) {
        logger.debug(
          `Hybrid external take factory-first selected path=${result.evaluation.externalTakePath} source=${formatLiquiditySource(result.evaluation.selectedLiquiditySource)} expectedNetProfitRaw=${result.evaluation.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} approvedMinOutRaw=${result.evaluation.approvedMinOutRaw?.toString() ?? 'n/a'} priorRejectedPaths=${
            probeResults
              .filter((probeResult) => !probeResult.evaluation)
              .map(
                (probeResult) =>
                  `${probeResult.path}=${probeResult.reason ?? 'not takeable'} (${probeResult.durationMs}ms)`
              )
              .join(', ') || 'none'
          } for pool ${params.pool.name}`
        );
        return result.evaluation;
      }
    }
  }
  const approvedEvaluations = probeResults
    .map((result) => result.evaluation)
    .filter(
      (evaluation): evaluation is ExternalTakeQuoteEvaluation =>
        evaluation !== undefined
    );
  const rejectedReasons = probeResults
    .filter((result) => !result.evaluation)
    .map(
      (result) =>
        `${result.path}=${result.reason ?? 'not takeable'} (${result.durationMs}ms)`
    );

  const selected = approvedEvaluations.sort((left, right) => {
    const profitCompare = compareBigNumberDescending(
      rankExternalTakeQuote(left),
      rankExternalTakeQuote(right)
    );
    if (profitCompare !== 0) {
      return profitCompare;
    }

    const orderCompare =
      (pathOrder.get(left.externalTakePath ?? 'factory') ??
        Number.MAX_SAFE_INTEGER) -
      (pathOrder.get(right.externalTakePath ?? 'factory') ??
        Number.MAX_SAFE_INTEGER);
    if (orderCompare !== 0) {
      return orderCompare;
    }

    return compareBigNumberDescending(
      left.quoteAmountRaw,
      right.quoteAmountRaw
    );
  })[0];
  if (selected) {
    logger.debug(
      `Hybrid external take selected path=${selected.externalTakePath} source=${formatLiquiditySource(selected.selectedLiquiditySource)} expectedNetProfitRaw=${selected.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} approvedMinOutRaw=${selected.approvedMinOutRaw?.toString() ?? 'n/a'} rejectedPaths=${rejectedReasons.join(', ') || 'none'} for pool ${params.pool.name}`
    );
    return selected;
  }

  const hasGasPolicyReject = probeResults.some(
    (result) => result.rejectCategory === 'gasPolicy'
  );
  const hasProfitFloorReject = probeResults.some(
    (result) => result.rejectCategory === 'profitFloor'
  );
  if (hasGasPolicyReject) {
    params.stats.gasPolicyRejects += 1;
  }
  if (hasProfitFloorReject) {
    params.stats.profitFloorRejects += 1;
  }

  return {
    isTakeable: false,
    reason: rejectedReasons.length
      ? `no viable external take path: ${rejectedReasons.join('; ')}`
      : 'no external take paths configured',
  };
}

function createExternalTakeAdapterForDiscovery(params: {
  target: ResolvedTakeTarget;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ExternalTakeRouteSelectionMode;
  probeTimeoutMs: number;
  quoteOneInchPath: OneInchPathQuoteFn;
  quoteOneInchTake: OneInchPathQuoteFn;
  quoteFactoryPath: FactoryPathQuoteFn;
  approveExternalTake: DiscoveryExternalTakeApprover;
  recordOneInchCircuitOutcome: (outcome: OneInchCircuitOutcome) => void;
  stats: Pick<
    DiscoveredTakeTargetStats,
    'gasPolicyRejects' | 'profitFloorRejects'
  >;
  config: DiscoveryExecutionConfig;
}): ExternalTakeAdapter<ResolvedTakeTarget, DiscoveryExternalExecutionConfig> {
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
          externalTakePaths: params.externalTakePaths,
          routeSelectionMode: params.routeSelectionMode,
          probeTimeoutMs: params.probeTimeoutMs,
          price,
          auctionPrice,
          collateral,
          quoteOneInchPath: params.quoteOneInchPath,
          quoteFactoryPath: params.quoteFactoryPath,
          approveExternalTake: params.approveExternalTake,
          recordOneInchCircuitOutcome: params.recordOneInchCircuitOutcome,
          stats: params.stats,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) => {
        const selectedPath =
          liquidation.externalTakeQuoteEvaluation?.externalTakePath;
        const selectedSource =
          liquidation.externalTakeQuoteEvaluation?.selectedLiquiditySource;
        const sourceSelectedPath =
          selectedSource === LiquiditySource.ONEINCH
            ? 'oneinch'
            : selectedSource !== undefined &&
                isDynamicFactorySource(selectedSource)
              ? 'factory'
              : undefined;
        if (
          selectedPath !== undefined &&
          sourceSelectedPath !== undefined &&
          selectedPath !== sourceSelectedPath
        ) {
          logger.error(
            `Hybrid external take selected inconsistent path=${selectedPath} source=${formatLiquiditySource(selectedSource)}; refusing execution for ${pool.name}/${liquidation.borrower}`
          );
          return false;
        }
        const effectiveSelectedPath = selectedPath ?? sourceSelectedPath;
        if (
          effectiveSelectedPath !== undefined &&
          !params.externalTakePaths.includes(effectiveSelectedPath)
        ) {
          logger.error(
            `Hybrid external take selected disabled path=${effectiveSelectedPath}; refusing execution for ${pool.name}/${liquidation.borrower}`
          );
          return false;
        }
        if (
          selectedPath === 'oneinch' ||
          selectedSource === LiquiditySource.ONEINCH
        ) {
          return takeModule.takeLiquidation({
            pool,
            signer,
            poolConfig,
            liquidation,
            config,
          });
        }

        const selectedFactorySource = selectedSource;
        const factoryPoolConfig =
          selectedFactorySource !== undefined &&
          isDynamicFactorySource(selectedFactorySource)
            ? withTakeLiquiditySource(poolConfig, selectedFactorySource)
            : poolConfig;
        return takeFactoryModule.takeLiquidationFactory({
          pool,
          signer,
          poolConfig: factoryPoolConfig,
          liquidation,
          config,
        });
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
        params.quoteOneInchTake({
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
      }) =>
        takeModule.takeLiquidation({
          pool,
          signer,
          poolConfig,
          liquidation,
          config,
        }),
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
      }) =>
        takeFactoryModule.takeLiquidationFactory({
          pool,
          signer,
          poolConfig,
          liquidation,
          config,
        }),
    };
  }

  return takeModule.createNoExternalTakeAdapter();
}

export async function handleDiscoveredTakeTarget(
  params: HandleDiscoveredTakeTargetParams
): Promise<void> {
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
    evaluationSkips: 0,
    revalidationSkips: 0,
    executionSkips: 0,
    gasPolicyRejects: 0,
    profitFloorRejects: 0,
    arbProfitUnavailableRejects: 0,
    executedExternalTakes: 0,
    executedArbTakes: 0,
  };
  const rpcCache =
    params.rpcCache ??
    (await createDiscoveryRpcCache({
      signer: params.signer,
      readRpc: transports.readRpc,
      includeFactoryQuoteProviders: true,
    }));
  const takePolicy = getAutoDiscoverTakePolicy(params.config.autoDiscover);
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
    return;
  }
  const approveExternalTake: DiscoveryExternalTakeApprover = async ({
    price,
    auctionPrice,
    collateral,
    quoteEvaluation,
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
      countStats,
      forceGasRefresh,
    });
  const externalTakePaths = getExternalTakePaths({
    defaultLiquiditySource: params.target.take.liquiditySource,
    allowedExternalTakePaths: takePolicy?.allowedExternalTakePaths,
  });
  const defaultFactoryLiquiditySource = getDefaultFactoryLiquiditySource({
    defaultLiquiditySource: params.target.take.liquiditySource,
    configuredDefaultFactoryLiquiditySource:
      takePolicy?.defaultFactoryLiquiditySource,
  });
  const factoryQuoteConfig = {
    universalRouterOverrides: params.config.universalRouterOverrides,
    sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
    curveRouterOverrides: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
  };
  const quoteFactoryPath: FactoryPathQuoteFn = (quoteParams) =>
    quoteFactoryPathForDiscovery({
      ...quoteParams,
      config: params.config,
      transports,
      rpcCache,
      takePolicy,
      defaultFactoryLiquiditySource,
      factoryQuoteConfig,
    });
  const quoteOneInchPath: OneInchPathQuoteFn = (quoteParams) =>
    quoteOneInchPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache,
      takePolicy,
      recordCircuitOutcome: false,
    });
  const quoteOneInchTake: OneInchPathQuoteFn = (quoteParams) =>
    quoteLegacyOneInchTakeForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache,
      takePolicy,
    });
  const externalTakeAdapter = createExternalTakeAdapterForDiscovery({
    target: params.target,
    takePolicy,
    externalTakePaths,
    routeSelectionMode: getExternalTakeRouteSelectionMode(takePolicy),
    probeTimeoutMs: getExternalTakeProbeTimeoutMs(takePolicy),
    quoteOneInchPath,
    quoteOneInchTake,
    quoteFactoryPath,
    approveExternalTake,
    recordOneInchCircuitOutcome: (outcome) => {
      if (outcome === 'failure') {
        recordOneInchQuoteFailure({
          rpcCache,
          takePolicy,
        });
        return;
      }
      recordOneInchQuoteSuccess(rpcCache);
    },
    stats,
    config: params.config,
  });

  const externalExecutionConfig = {
    dryRun: params.target.dryRun,
    delayBetweenActions: params.config.delayBetweenActions,
    connectorTokens: params.config.connectorTokens,
    oneInchRouters: params.config.oneInchRouters,
    keeperTaker: params.config.keeperTaker,
    keeperTakerFactory: params.config.keeperTakerFactory,
    universalRouterOverrides: params.config.universalRouterOverrides,
    sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
    curveRouterOverrides: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
    takeWriteTransport: params.takeWriteTransport,
    runtimeCache: rpcCache?.factoryQuoteProviders,
    oneInchRequestTimeoutMs: getOneInchQuoteTimeoutMs(takePolicy),
    skipOneInchRateLimitDelay: true,
  };

  try {
    await processTakeCandidates<
      ResolvedTakeTarget,
      DiscoveryExternalExecutionConfig
    >({
      pool: params.pool,
      signer: params.signer,
      poolConfig: params.target,
      candidates: params.target.candidates.map(({ borrower }) => ({
        borrower,
      })),
      subgraph: transports.subgraph,
      externalTakeAdapter,
      externalExecutionConfig,
      dryRun: params.target.dryRun,
      delayBetweenActions: params.config.delayBetweenActions,
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
      }) =>
        approveExternalTake({
          price,
          auctionPrice,
          collateral,
          quoteEvaluation,
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
      onFound: (decision) => {
        if (decision.approvedTake) {
          stats.approvedTakeDecisions += 1;
        }
        if (decision.approvedArbTake) {
          stats.approvedArbTakeDecisions += 1;
        }
      },
      onSkip: ({ candidate, stage, reason }) => {
        if (isInactiveAuctionSkipReason(reason)) {
          params.onCandidateInactive?.({
            poolAddress: params.target.poolAddress,
            borrower: candidate.borrower,
          });
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
          stats.executedExternalTakes += 1;
        }
        if (executedArbTake) {
          stats.executedArbTakes += 1;
        }
      },
    });
  } finally {
    logDiscoveredTakeTargetSummary({
      pool: params.pool,
      target: params.target,
      stats,
    });
  }
}
