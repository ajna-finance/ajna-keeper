import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  LiquiditySource,
  isFactoryDynamicSource,
  normalizeExternalTakeRouteSelectionMode,
  resolveExternalTakePaths,
  resolveHybridGasQuoteFallbackPolicy,
} from '../../config';
import { ZERO_BN } from '../../constants';
import { getDecimalsErc20 } from '../../erc20';
import { logger } from '../../logging';
import { DiscoveryReadTransports } from '../../read-transports';
import { isSubsidizedExternalTakeQuote } from '../../take/external-take/policy';
import { bindExternalTakeRouteForDiscovery } from '../../take/external-take/quote-approval';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import { TakeWriteTransport } from '../../take/write-transport';
import { decimaledToWei } from '../../utils';
import {
  ExternalTakeApprovalInput,
  ExternalTakeApprovalResult,
  HYBRID_GAS_QUOTE_FALLBACK_KIND,
} from './approval';
import {
  evaluateGasPolicy,
  getDiscoveryGasPriceFreshnessTtlMs,
} from '../gas-policy';
import { DiscoveryRpcCache, DiscoveryExecutionConfig } from '../types';
import { ResolvedTakeTarget } from '../targets';
import type { AutoDiscoverTakePolicyRuntime } from './quotes';
import type { DiscoveredTakeTargetStats } from './stats';
import { cloneExternalTakeQuoteEvaluation } from './evaluation';
import {
  EXTERNAL_TAKE_GAS_LIMIT,
  formatExternalTakeGasTelemetry,
  getExternalTakeGasLimit,
  getGasPriceAgeMs,
  hasFreshExternalTakeGasPolicy,
  refreshDiscoveryGasPriceIfStale,
} from './gas-policy';
import {
  applyDiscoveryApprovalProfitabilityPolicy,
  buildSimpleQuoteProfitability,
  getAuctionCostQuoteRaw,
} from './profitability-policy';

export { getExternalTakeGasLimit, refreshDiscoveryGasPriceIfStale };

const ZERO = ZERO_BN;

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
  if (
    params.quoteEvaluation.externalTakePath === 'factory' &&
    selectedLiquiditySource === undefined
  ) {
    return {
      approved: false,
      reason: 'selected factory path without a concrete factory source',
    };
  }
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

function bindDiscoveryExecutionRoute(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource: LiquiditySource;
  target: ResolvedTakeTarget;
}): ExternalTakeApprovalResult {
  const binding = bindExternalTakeRouteForDiscovery({
    quoteEvaluation: params.quoteEvaluation,
    selectedLiquiditySource: params.selectedLiquiditySource,
    poolName: params.target.name,
    borrower: 'discovery',
  });
  if (!binding.bound) {
    return {
      approved: false,
      reason: binding.reason,
    };
  }
  return {
    approved: true,
    quoteEvaluation: binding.quoteEvaluation,
  };
}

export async function approveExternalTakeForDiscovery(
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
  let candidateQuoteEvaluation =
    cloneExternalTakeQuoteEvaluation(quoteEvaluation);
  const approvalMode = params.approvalMode ?? 'strict_hybrid';

  if (approvalMode === HYBRID_GAS_QUOTE_FALLBACK_KIND) {
    const fallbackEligibility = resolveHybridGasQuoteFallbackPolicy({
      fallbackMode: takePolicy?.hybridGasQuoteFailureFallbackMode,
      routeSelectionMode: normalizeExternalTakeRouteSelectionMode(
        takePolicy?.externalTakeRouteSelectionMode
      ),
      externalTakePaths: resolveExternalTakePaths({
        defaultLiquiditySource: target.take.liquiditySource,
        allowedExternalTakePaths: takePolicy?.allowedExternalTakePaths,
      }),
      maxGasCostNative: takePolicy?.maxGasCostNative,
      maxGasCostQuote: takePolicy?.maxGasCostQuote,
      minExpectedProfitQuote: takePolicy?.minExpectedProfitQuote,
      minProfitNative: takePolicy?.minProfitNative,
    });
    if (!fallbackEligibility.eligible) {
      return {
        approved: false,
        reason: `hybrid gas quote fallback ineligible because ${fallbackEligibility.reason}`,
        rejectCategory: 'gasPolicy',
      };
    }
  }

  const sourceSelection = resolveApprovedExternalTakeSource({
    target,
    quoteEvaluation: candidateQuoteEvaluation,
  });
  if (!sourceSelection.approved) {
    return {
      approved: false,
      reason: sourceSelection.reason,
    };
  }
  const selectedLiquiditySource = sourceSelection.selectedLiquiditySource;
  if (selectedLiquiditySource === undefined) {
    return {
      approved: false,
      reason: 'external take route approval missing selected liquidity source',
    };
  }
  const selectedFactoryLiquiditySource =
    sourceSelection.selectedFactoryLiquiditySource;
  const executableApproval = bindDiscoveryExecutionRoute({
    quoteEvaluation: candidateQuoteEvaluation,
    selectedLiquiditySource,
    target,
  });
  if (!executableApproval.approved) {
    return executableApproval;
  }
  let approvedQuoteEvaluation = executableApproval.quoteEvaluation;
  const fallbackInputWasSubsidized =
    approvalMode === HYBRID_GAS_QUOTE_FALLBACK_KIND &&
    isSubsidizedExternalTakeQuote(approvedQuoteEvaluation);
  if (selectedLiquiditySource !== undefined && !params.forceGasRefresh) {
    const freshness = hasFreshExternalTakeGasPolicy({
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
    const refreshedFreshness = hasFreshExternalTakeGasPolicy({
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
      approvalMode === HYBRID_GAS_QUOTE_FALLBACK_KIND
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
  // Pair the auction cost with the collateral size the route quote is
  // denominated in (the debt-clamped size for aggregator paths), so absolute
  // profit-vs-gas checks reflect what the take can actually realize.
  const auctionCostQuoteRaw =
    quoteTokenDecimals !== undefined
      ? getAuctionCostQuoteRaw({
          price: auctionPrice,
          collateral: approvedQuoteEvaluation.quotedCollateralWad ?? collateral,
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
    selectedLiquiditySource,
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
    bindExecutionRoute: (quoteEvaluation) =>
      bindDiscoveryExecutionRoute({
        quoteEvaluation,
        selectedLiquiditySource,
        target,
      }),
  });
  if (!profitabilityApproval.approved) {
    return profitabilityApproval;
  }
  approvedQuoteEvaluation = profitabilityApproval.quoteEvaluation;

  if (
    approvalMode === HYBRID_GAS_QUOTE_FALLBACK_KIND &&
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
