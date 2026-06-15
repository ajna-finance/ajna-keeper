import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  ActiveExternalTakeRouteSelectionMode,
  CalldataAggregatorProviderId,
  ExternalTakePathKind,
  formatLiquiditySource,
  resolveHybridGasQuoteFallbackPolicy,
} from '../../config';
import { logger } from '../../logging';
import { isSubsidizedExternalTakeQuote } from '../../take/external-take/policy';
import {
  AuctionTakeFacts,
  BoundExternalTakeRouteEvaluation,
  ExternalTakeEvaluationResult,
  ExternalTakeExecutionCandidate,
  TakeLiquidationPlan,
} from '../../take/types';
import {
  createExternalTakeExecutionCandidate,
  createExternalTakeExecutionPlan,
  resolveExternalTakeExecutionCandidates,
} from '../../take/external-take/execution-plan';
import { TakeAuctionStatusReader } from '../../take/liquidation-status';
import { getErrorMessage } from '../../utils';
import {
  DiscoveryExternalTakeApprovalContext,
  DiscoveryExternalTakeApprover,
  ExternalTakeApprovalRejectCategory,
  HYBRID_GAS_QUOTE_FALLBACK_CONTEXT,
  HYBRID_GAS_QUOTE_FALLBACK_KIND,
} from './approval';
import { cloneExternalTakeQuoteEvaluation } from './evaluation';
import { refreshAndReapproveDiscoveryExternalTake } from './final-approval';
import {
  isCalldataAggregatorExternalTakeRoute,
  resolveExternalTakeRouteIdentity,
} from '../../take/external-take/route-binding';
import {
  DiscoveryExternalExecutionConfig,
  ExternalTakeQuoteCircuitOutcome,
} from './provider';
import {
  DiscoveryExternalTakeProviderRegistry,
  DiscoveryExternalTakeRouteProvider,
} from './providers';
import { AutoDiscoverTakePolicyRuntime } from './quotes';
import {
  DiscoveredTakeTargetStats,
  recordSuccessfulExternalTakeRouteStats,
} from './stats';
import {
  resolveHybridExternalTakeExecutionSelection,
  sortExternalTakeQuoteEvaluationsForSelection,
} from './selection';
import { GasPolicyResult } from '../gas-policy';
import { ResolvedTakeTarget } from '../targets';

function formatProviderWarnLabel(
  provider: DiscoveryExternalTakeRouteProvider
): string {
  switch (provider.providerId) {
    case 'oneinch':
      return '1inch';
    case 'lifi':
      return 'LI.FI';
    case 'sushi_aggregator':
      return 'Sushi aggregator';
    default:
      return provider.path === 'direct_dex' ? 'direct DEX' : provider.path;
  }
}

export interface HybridExternalTakeStats {
  gasPolicyRejects: number;
  profitFloorRejects: number;
}

export type HybridExternalTakeProbeResult = {
  path: ExternalTakePathKind;
  providerId?: CalldataAggregatorProviderId;
  durationMs: number;
  evaluation?: BoundExternalTakeRouteEvaluation;
  reason?: string;
  rejectCategory?: ExternalTakeApprovalRejectCategory;
  gasPolicyRejectCode?: GasPolicyResult['rejectCode'];
  gasQuoteAttempts?: GasPolicyResult['gasQuoteAttempts'];
  circuitOutcome?: ExternalTakeQuoteCircuitOutcome;
};

type ProbeControl = {
  abandoned: boolean;
  abortController: AbortController;
};

type HybridProbeUnit = {
  path: ExternalTakePathKind;
  providerId?: CalldataAggregatorProviderId;
};

// One probe unit per executable provider: the calldata_aggregator family
// expands into its enabled providers so LI.FI and Sushi are probed (and
// compete) independently instead of sharing a single path-keyed slot.
function resolveProbeOrder(params: {
  externalTakePaths: ExternalTakePathKind[];
  calldataAggregatorProviders: readonly CalldataAggregatorProviderId[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
}): HybridProbeUnit[] {
  const orderedPaths =
    params.routeSelectionMode !== 'direct_dex_first'
      ? [...params.externalTakePaths]
      : (() => {
          const pathOrder = new Map<ExternalTakePathKind, number>(
            params.externalTakePaths.map((path, index) => [path, index])
          );
          return [...params.externalTakePaths].sort((left, right) => {
            if (left === right) {
              return 0;
            }
            if (left === 'direct_dex') {
              return -1;
            }
            if (right === 'direct_dex') {
              return 1;
            }
            return (pathOrder.get(left) ?? 0) - (pathOrder.get(right) ?? 0);
          });
        })();
  const units: HybridProbeUnit[] = [];
  for (const path of orderedPaths) {
    if (path === 'calldata_aggregator') {
      for (const providerId of params.calldataAggregatorProviders) {
        units.push({ path, providerId });
      }
    } else {
      units.push({ path });
    }
  }
  return units;
}

async function probeExternalTakePath(
  params: AuctionTakeFacts & {
    provider: DiscoveryExternalTakeRouteProvider;
    control: ProbeControl;
    pool: FungiblePool;
    signer: Signer;
    poolConfig: ResolvedTakeTarget;
    price: number;
    approveExternalTake: DiscoveryExternalTakeApprover;
  }
): Promise<HybridExternalTakeProbeResult> {
  const startedAt = Date.now();
  let circuitOutcome: ExternalTakeQuoteCircuitOutcome | undefined;
  try {
    const evaluation = await params.provider.quote({
      pool: params.pool,
      signer: params.signer,
      poolConfig: params.poolConfig,
      price: params.price,
      auctionPrice: params.auctionPrice,
      collateral: params.collateral,
      debtToCover: params.debtToCover,
      intent: {
        kind: 'hybrid_probe',
        abortSignal: params.control.abortController.signal,
      },
    });
    if (params.control.abandoned) {
      return {
        path: params.provider.path,
        providerId: params.provider.providerId,
        durationMs: Date.now() - startedAt,
        reason: 'probe abandoned after timeout',
      };
    }
    circuitOutcome = params.provider.getQuoteCircuitOutcome?.(evaluation);
    if (!evaluation.isTakeable) {
      const gasPolicyRejectCode =
        evaluation.routeProfitability?.gasPolicyRejectCode;
      return {
        path: params.provider.path,
        providerId: params.provider.providerId,
        durationMs: Date.now() - startedAt,
        reason: evaluation.reason ?? 'not takeable',
        rejectCategory:
          gasPolicyRejectCode !== undefined ? 'gasPolicy' : undefined,
        gasPolicyRejectCode,
        gasQuoteAttempts: evaluation.routeProfitability?.gasQuoteAttempts,
        circuitOutcome,
      };
    }

    const approval = await params.approveExternalTake({
      price: params.price,
      auctionPrice: params.auctionPrice,
      collateral: params.collateral,
      debtToCover: params.debtToCover,
      quoteEvaluation: evaluation,
      countStats: false,
    });
    if (!approval.approved) {
      return {
        path: params.provider.path,
        providerId: params.provider.providerId,
        durationMs: Date.now() - startedAt,
        reason: approval.reason ?? 'policy rejected path',
        rejectCategory: approval.rejectCategory,
        gasPolicyRejectCode: approval.gasPolicyRejectCode,
        gasQuoteAttempts: approval.gasQuoteAttempts,
        circuitOutcome,
      };
    }
    return {
      path: params.provider.path,
      providerId: params.provider.providerId,
      durationMs: Date.now() - startedAt,
      evaluation: approval.quoteEvaluation,
      circuitOutcome,
    };
  } catch (error) {
    return {
      path: params.provider.path,
      providerId: params.provider.providerId,
      durationMs: Date.now() - startedAt,
      reason: getErrorMessage(error),
      circuitOutcome:
        params.provider.recordQuoteCircuitOutcome !== undefined
          ? (circuitOutcome ?? 'failure')
          : undefined,
    };
  }
}

function recordProbeCircuitOutcome(params: {
  result: HybridExternalTakeProbeResult;
  providerRegistry: DiscoveryExternalTakeProviderRegistry;
}): void {
  if (params.result.circuitOutcome) {
    params.providerRegistry
      .selectExternalTakeProvider({
        selectedPath: params.result.path,
        providerId: params.result.providerId,
      })
      .recordQuoteCircuitOutcome?.(params.result.circuitOutcome);
  }
}

async function withProbeTimeout(params: {
  provider: DiscoveryExternalTakeRouteProvider;
  probeTimeoutMs: number;
  probe: (
    provider: DiscoveryExternalTakeRouteProvider,
    control: ProbeControl
  ) => Promise<HybridExternalTakeProbeResult>;
}): Promise<HybridExternalTakeProbeResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const control: ProbeControl = {
    abandoned: false,
    abortController: new AbortController(),
  };
  const probe = params.probe(params.provider, control);
  probe.catch(() => undefined);
  try {
    return await Promise.race([
      probe,
      new Promise<HybridExternalTakeProbeResult>((resolve) => {
        timeout = setTimeout(() => {
          // Keep the flag as a backstop for late work that has not reached an
          // abort-aware RPC/API checkpoint yet.
          control.abandoned = true;
          control.abortController.abort(
            new Error(`probe timed out after ${params.probeTimeoutMs}ms`)
          );
          resolve({
            path: params.provider.path,
            durationMs: params.probeTimeoutMs,
            reason: `probe timed out after ${params.probeTimeoutMs}ms`,
            circuitOutcome:
              params.provider.recordQuoteCircuitOutcome !== undefined
                ? 'failure'
                : undefined,
          });
        }, params.probeTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function runHybridExternalTakeProbes(
  params: AuctionTakeFacts & {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: ResolvedTakeTarget;
    externalTakePaths: ExternalTakePathKind[];
    calldataAggregatorProviders: readonly CalldataAggregatorProviderId[];
    routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
    probeTimeoutMs: number;
    price: number;
    providerRegistry: DiscoveryExternalTakeProviderRegistry;
    approveExternalTake: DiscoveryExternalTakeApprover;
  }
): Promise<HybridExternalTakeProbeResult[]> {
  const probeOrder = resolveProbeOrder(params);
  const runProbe = async (
    provider: DiscoveryExternalTakeRouteProvider,
    control: ProbeControl
  ) =>
    await probeExternalTakePath({
      ...params,
      provider,
      control,
    });

  if (params.routeSelectionMode !== 'direct_dex_first') {
    const probeResults = await Promise.all(
      probeOrder.map((unit) =>
        withProbeTimeout({
          provider: params.providerRegistry.selectExternalTakeProvider({
            selectedPath: unit.path,
            providerId: unit.providerId,
          }),
          probeTimeoutMs: params.probeTimeoutMs,
          probe: runProbe,
        })
      )
    );
    probeResults.forEach((result) =>
      recordProbeCircuitOutcome({
        result,
        providerRegistry: params.providerRegistry,
      })
    );
    return probeResults;
  }

  const probeResults: HybridExternalTakeProbeResult[] = [];
  for (const unit of probeOrder) {
    const result = await withProbeTimeout({
      provider: params.providerRegistry.selectExternalTakeProvider({
        selectedPath: unit.path,
        providerId: unit.providerId,
      }),
      probeTimeoutMs: params.probeTimeoutMs,
      probe: runProbe,
    });
    probeResults.push(result);
    recordProbeCircuitOutcome({
      result,
      providerRegistry: params.providerRegistry,
    });
    if (
      result.evaluation &&
      !isSubsidizedExternalTakeQuote(result.evaluation)
    ) {
      return probeResults;
    }
  }
  return probeResults;
}

function formatGasQuoteAttempts(
  attempts: GasPolicyResult['gasQuoteAttempts']
): string {
  if (!attempts?.length) {
    return 'none';
  }
  return attempts
    .map((attempt) => {
      const feeTiers = attempt.feeTiers?.length
        ? ` feeTiers=[${attempt.feeTiers.join(',')}]`
        : '';
      const outcome = attempt.success
        ? `success amountOut=${attempt.amountOut ?? 'n/a'}`
        : `failed reason=${attempt.reason ?? 'unknown'}`;
      return `${formatLiquiditySource(attempt.source)} ${attempt.tokenIn}->${attempt.tokenOut} amountIn=${attempt.amountIn}${feeTiers} ${outcome}`;
    })
    .join('; ');
}

function resolveHybridGasQuoteFallbackTriggerReason(params: {
  directDexNativeToQuoteReject?: HybridExternalTakeProbeResult;
}): string | undefined {
  return params.directDexNativeToQuoteReject === undefined
    ? 'direct_dex path was not rejected only by native-to-quote gas conversion'
    : undefined;
}

async function buildHybridGasQuoteFallbackEvaluation(
  params: AuctionTakeFacts & {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: ResolvedTakeTarget;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    externalTakePaths: ExternalTakePathKind[];
    calldataAggregatorProviders: readonly CalldataAggregatorProviderId[];
    routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
    price: number;
    providerRegistry: DiscoveryExternalTakeProviderRegistry;
    approveExternalTake: DiscoveryExternalTakeApprover;
    probeResults: HybridExternalTakeProbeResult[];
  }
): Promise<
  | ExternalTakeExecutionCandidate<DiscoveryExternalTakeApprovalContext>
  | undefined
> {
  const directDexNativeToQuoteReject = params.probeResults.find(
    (result) =>
      result.path === 'direct_dex' &&
      result.gasPolicyRejectCode === 'native_to_quote_conversion_unavailable'
  );
  const fallbackEligibility = resolveHybridGasQuoteFallbackPolicy({
    fallbackMode: params.takePolicy?.hybridGasQuoteFailureFallbackMode,
    routeSelectionMode: params.routeSelectionMode,
    externalTakePaths: params.externalTakePaths,
    maxGasCostNative: params.takePolicy?.maxGasCostNative,
    maxGasCostQuote: params.takePolicy?.maxGasCostQuote,
    minExpectedProfitQuote: params.takePolicy?.minExpectedProfitQuote,
    minProfitNative: params.takePolicy?.minProfitNative,
  });
  const fallbackIneligibleReason = fallbackEligibility.eligible
    ? resolveHybridGasQuoteFallbackTriggerReason({
        directDexNativeToQuoteReject,
      })
    : fallbackEligibility.reason;
  if (directDexNativeToQuoteReject && fallbackIneligibleReason) {
    logger.debug(
      `Hybrid gas quote fallback skipped for pool ${params.pool.name}: ${fallbackIneligibleReason}`
    );
  }
  if (fallbackIneligibleReason) {
    return undefined;
  }

  logger.warn(
    `Hybrid external take max-profit ranking unavailable because native-to-quote gas conversion failed; attempting direct_dex_first fallback pool=${params.pool.name} attempts="${formatGasQuoteAttempts(
      directDexNativeToQuoteReject?.gasQuoteAttempts
    )}"`
  );
  const fallbackQuote = await params.providerRegistry
    .selectExternalTakeProvider({ selectedPath: 'direct_dex' })
    .quote({
      pool: params.pool,
      signer: params.signer,
      poolConfig: params.poolConfig,
      price: params.price,
      auctionPrice: params.auctionPrice,
      collateral: params.collateral,
      debtToCover: params.debtToCover,
      intent: { kind: HYBRID_GAS_QUOTE_FALLBACK_KIND },
    });
  if (!fallbackQuote.isTakeable) {
    logger.debug(
      `Hybrid gas quote fallback direct_dex quote rejected for pool ${params.pool.name}: ${fallbackQuote.reason ?? 'not takeable'}`
    );
    return undefined;
  }

  const fallbackApproval = await params.approveExternalTake({
    price: params.price,
    auctionPrice: params.auctionPrice,
    collateral: params.collateral,
    debtToCover: params.debtToCover,
    quoteEvaluation: fallbackQuote,
    externalTakeApprovalContext: HYBRID_GAS_QUOTE_FALLBACK_CONTEXT,
    countStats: false,
    forceGasRefresh: true,
  });
  if (!fallbackApproval.approved) {
    logger.debug(
      `Hybrid gas quote fallback approval rejected for pool ${params.pool.name}: ${fallbackApproval.reason ?? 'policy rejected fallback path'}`
    );
    return undefined;
  }

  const approvedFallback = fallbackApproval.quoteEvaluation;
  logger.warn(
    `Hybrid gas quote fallback activated: direct_dex_first path=${approvedFallback.externalTakePath} source=${formatLiquiditySource(approvedFallback.selectedLiquiditySource)} pool=${params.pool.name} attempts="${formatGasQuoteAttempts(
      directDexNativeToQuoteReject?.gasQuoteAttempts
    )}"`
  );
  return {
    evaluation: approvedFallback,
    approvalContext: HYBRID_GAS_QUOTE_FALLBACK_CONTEXT,
  };
}

function isHybridGasQuoteFallbackCandidate(
  candidate: ExternalTakeExecutionCandidate<DiscoveryExternalTakeApprovalContext>
): boolean {
  return candidate.approvalContext?.kind === HYBRID_GAS_QUOTE_FALLBACK_KIND;
}

function formatRejectedProbeReasons(
  probeResults: readonly HybridExternalTakeProbeResult[]
): string[] {
  return probeResults
    .filter((result) => !result.evaluation)
    .map(
      (result) =>
        `${result.path}=${result.reason ?? 'not takeable'} (${result.durationMs}ms)`
    );
}

export async function evaluateHybridExternalTakeForDiscovery(
  params: AuctionTakeFacts & {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: ResolvedTakeTarget;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    externalTakePaths: ExternalTakePathKind[];
    calldataAggregatorProviders: readonly CalldataAggregatorProviderId[];
    routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
    probeTimeoutMs: number;
    price: number;
    providerRegistry: DiscoveryExternalTakeProviderRegistry;
    approveExternalTake: DiscoveryExternalTakeApprover;
    stats: HybridExternalTakeStats;
  }
): Promise<ExternalTakeEvaluationResult<DiscoveryExternalTakeApprovalContext>> {
  const probeResults = await runHybridExternalTakeProbes({
    ...params,
  });
  const rejectedReasons = formatRejectedProbeReasons(probeResults);

  if (params.routeSelectionMode === 'direct_dex_first') {
    for (const result of probeResults) {
      if (result.evaluation) {
        if (isSubsidizedExternalTakeQuote(result.evaluation)) {
          logger.debug(
            `Hybrid external take direct_dex_first found subsidized path=${result.evaluation.externalTakePath} source=${formatLiquiditySource(result.evaluation.selectedLiquiditySource)} expectedNetProfitRaw=${result.evaluation.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} expectedSubsidyRaw=${result.evaluation.routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'}; deferring it while probing remaining paths for pool ${params.pool.name}`
          );
          continue;
        }
        logger.debug(
          `Hybrid external take direct_dex_first selected path=${result.evaluation.externalTakePath} source=${formatLiquiditySource(result.evaluation.selectedLiquiditySource)} expectedNetProfitRaw=${result.evaluation.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} expectedSubsidyRaw=${result.evaluation.routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'} routeExecutionFloorRaw=${result.evaluation.routeExecutionFloorRaw.toString()} priorRejectedPaths=${
            probeResults
              .filter((probeResult) => !probeResult.evaluation)
              .map(
                (probeResult) =>
                  `${probeResult.path}=${probeResult.reason ?? 'not takeable'} (${probeResult.durationMs}ms)`
              )
              .join(', ') || 'none'
          } for pool ${params.pool.name}`
        );
        return {
          takeable: true,
          executionPlan: createExternalTakeExecutionPlan({
            primaryEvaluation: result.evaluation,
          }),
        };
      }
    }
  }
  const approvedEvaluations = probeResults
    .map((result) => result.evaluation)
    .filter(
      (evaluation): evaluation is BoundExternalTakeRouteEvaluation =>
        evaluation !== undefined
    );
  const buildGasQuoteFallbackEvaluation = async () =>
    await buildHybridGasQuoteFallbackEvaluation({
      ...params,
      probeResults,
    });

  const sortedApprovedEvaluations =
    sortExternalTakeQuoteEvaluationsForSelection({
      evaluations: approvedEvaluations,
      externalTakePaths: params.externalTakePaths,
    });
  const selected = sortedApprovedEvaluations[0];
  if (selected) {
    const selectedWithFallbacks = cloneExternalTakeQuoteEvaluation(selected);
    const fallbackCandidates: ExternalTakeExecutionCandidate<DiscoveryExternalTakeApprovalContext>[] =
      sortedApprovedEvaluations.slice(1).map((evaluation) =>
        createExternalTakeExecutionCandidate({
          evaluation: cloneExternalTakeQuoteEvaluation(evaluation),
        })
      );
    if (isCalldataAggregatorExternalTakeRoute(selected)) {
      const gasQuoteFallback = await buildGasQuoteFallbackEvaluation();
      if (gasQuoteFallback) {
        fallbackCandidates.push(gasQuoteFallback);
      }
    }
    logger.debug(
      `Hybrid external take selected path=${selected.externalTakePath} source=${formatLiquiditySource(selected.selectedLiquiditySource)} expectedNetProfitRaw=${selected.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} expectedSubsidyRaw=${selected.routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'} routeExecutionFloorRaw=${selected.routeExecutionFloorRaw.toString()} rejectedPaths=${rejectedReasons.join(', ') || 'none'} for pool ${params.pool.name}`
    );
    return {
      takeable: true,
      executionPlan: createExternalTakeExecutionPlan({
        primaryEvaluation: selectedWithFallbacks,
        fallbacks: fallbackCandidates,
      }),
    };
  }

  const gasQuoteFallback = await buildGasQuoteFallbackEvaluation();
  if (gasQuoteFallback) {
    return {
      takeable: true,
      executionPlan: createExternalTakeExecutionPlan({
        primaryEvaluation: gasQuoteFallback.evaluation,
        primaryApprovalContext: gasQuoteFallback.approvalContext,
      }),
    };
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
    takeable: false,
    quoteEvaluation: {
      isTakeable: false,
      reason: rejectedReasons.length
        ? `no viable external take path: ${rejectedReasons.join('; ')}`
        : 'no external take paths configured',
    },
  };
}

export async function executeHybridExternalTakeForDiscovery(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  liquidation: TakeLiquidationPlan<DiscoveryExternalTakeApprovalContext>;
  config: DiscoveryExternalExecutionConfig;
  externalTakePaths: ExternalTakePathKind[];
  calldataAggregatorProviders: readonly CalldataAggregatorProviderId[];
  providerRegistry: DiscoveryExternalTakeProviderRegistry;
  approveExternalTake: DiscoveryExternalTakeApprover;
  takeAuctionStatusReader: TakeAuctionStatusReader;
  stats: DiscoveredTakeTargetStats;
}): Promise<boolean> {
  const executionCandidates = resolveExternalTakeExecutionCandidates({
    executionPlan: params.liquidation.externalTakeExecutionPlan,
  });

  for (let index = 0; index < executionCandidates.length; index += 1) {
    const candidate = executionCandidates[index];
    if (!candidate) {
      continue;
    }
    const candidateEvaluation = candidate.evaluation;
    const selection = resolveHybridExternalTakeExecutionSelection({
      quoteEvaluation: candidateEvaluation,
      resolvedExternalTakePaths: params.externalTakePaths,
    });
    if (!selection.approved) {
      logger.error(
        `Hybrid external take ${selection.reason}; refusing execution for ${params.pool.name}/${params.liquidation.borrower}`
      );
      if (index === 0) {
        return false;
      }
      continue;
    }

    const isExecutionFallbackCandidate = index > 0;
    const isGasQuoteFallbackCandidate =
      isHybridGasQuoteFallbackCandidate(candidate);
    const requiresFallbackReapproval =
      isExecutionFallbackCandidate || isGasQuoteFallbackCandidate;
    if (isExecutionFallbackCandidate) {
      params.stats.hybridFallbackAttempts += 1;
    }
    if (isGasQuoteFallbackCandidate) {
      params.stats.hybridGasQuoteFallbackAttempts += 1;
    }

    let approvedEvaluation = candidateEvaluation;
    let executionLiquidation = params.liquidation;
    if (requiresFallbackReapproval) {
      const fallbackApproval = await refreshAndReapproveDiscoveryExternalTake({
        pool: params.pool,
        takeAuctionStatusReader: params.takeAuctionStatusReader,
        liquidation: params.liquidation,
        quoteEvaluation: candidateEvaluation,
        externalTakeApprovalContext: candidate.approvalContext,
        approveExternalTake: params.approveExternalTake,
        countStats: false,
        forceGasRefresh: true,
      });
      if (!fallbackApproval.approved) {
        if (fallbackApproval.kind === 'auction_refresh_failed') {
          logger.warn(
            `Hybrid fallback path could not refresh auction state for ${params.pool.name}/${params.liquidation.borrower}: ${fallbackApproval.reason}`
          );
          continue;
        }
        logger.debug(
          `Hybrid fallback path rejected during final approval for ${params.pool.name}/${params.liquidation.borrower}: ${fallbackApproval.reason}`
        );
        continue;
      }
      executionLiquidation = fallbackApproval.liquidation;
      approvedEvaluation = fallbackApproval.quoteEvaluation;
    }

    const selectedPath = selection.effectiveSelectedPath;
    const liquidationForCandidate = {
      ...executionLiquidation,
      externalTakeExecutionPlan: createExternalTakeExecutionPlan({
        primaryEvaluation: approvedEvaluation,
        primaryApprovalContext: candidate.approvalContext,
      }),
    };

    const routeIdentity = resolveExternalTakeRouteIdentity(approvedEvaluation);
    const provider = params.providerRegistry.selectExternalTakeProvider({
      selectedPath,
      providerId:
        routeIdentity?.path === 'calldata_aggregator'
          ? routeIdentity.providerId
          : undefined,
    });
    const attempt = await provider.execute({
      pool: params.pool,
      signer: params.signer,
      poolConfig: params.poolConfig,
      liquidation: liquidationForCandidate,
      config: params.config,
    });
    if (attempt.succeeded) {
      recordSuccessfulExternalTakeRouteStats(
        params.stats,
        approvedEvaluation,
        params.config.dryRun === true
      );
      if (isExecutionFallbackCandidate) {
        params.stats.hybridFallbackSuccesses += 1;
      }
      if (isGasQuoteFallbackCandidate) {
        params.stats.hybridGasQuoteFallbackSuccesses += 1;
      }
      return true;
    }
    if (attempt.preBroadcastFailed && index < executionCandidates.length - 1) {
      logger.warn(
        `Hybrid ${formatProviderWarnLabel(provider)} path failed before submission for ${params.pool.name}/${params.liquidation.borrower}; trying next approved fallback path`
      );
      continue;
    }
    return false;
  }

  logger.error(
    `Hybrid external take had no executable approved path for ${params.pool.name}/${params.liquidation.borrower}`
  );
  return false;
}
