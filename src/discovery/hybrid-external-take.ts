import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  ActiveExternalTakeRouteSelectionMode,
  ExternalTakePathKind,
  formatLiquiditySource,
  resolveHybridGasQuoteFallbackPolicy,
} from '../config';
import { logger } from '../logging';
import { isSubsidizedExternalTakeQuote } from '../take/external-take-policy';
import {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeEvaluationResult,
  ExternalTakeExecutionCandidate,
  TakeLiquidationPlan,
} from '../take/types';
import { resolveExternalTakeExecutionCandidates } from '../take/external-take-execution-plan';
import { getErrorMessage } from '../utils';
import {
  DiscoveryExternalTakeApprovalContext,
  DiscoveryExternalTakeApprover,
  ExternalTakeApprovalRejectCategory,
  ExternalTakeApprovalResult,
  HYBRID_GAS_QUOTE_FALLBACK_CONTEXT,
  HYBRID_GAS_QUOTE_FALLBACK_KIND,
} from './external-take-approval';
import {
  cloneExternalTakeQuoteEvaluation,
  withExternalTakeApprovalContext,
} from './external-take-evaluation';
import {
  isLifiExternalTakeRoute,
  isOneInchExternalTakeRoute,
} from '../take/external-take-route';
import {
  DiscoveryExternalExecutionConfig,
  ExternalTakeQuoteCircuitOutcome,
} from './external-take-provider';
import {
  DiscoveryExternalTakeProviderRegistry,
  DiscoveryExternalTakeRouteProvider,
} from './external-take-providers';
import { AutoDiscoverTakePolicyRuntime } from './external-take-quotes';
import {
  DiscoveredTakeTargetStats,
  recordSuccessfulExternalTakeRouteStats,
} from './external-take-stats';
import {
  resolveHybridExternalTakeExecutionSelection,
  sortExternalTakeQuoteEvaluationsForSelection,
} from './external-take-selection';
import { GasPolicyResult } from './gas-policy';
import { ResolvedTakeTarget } from './targets';

const PROVIDER_WARN_LABEL: Record<ExternalTakePathKind, string> = {
  oneinch: '1inch',
  lifi: 'LI.FI',
  factory: 'factory',
};

export interface HybridExternalTakeStats {
  gasPolicyRejects: number;
  profitFloorRejects: number;
}

export type HybridExternalTakeProbeResult = {
  path: ExternalTakePathKind;
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

function resolveProbeOrder(params: {
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
}): ExternalTakePathKind[] {
  if (params.routeSelectionMode !== 'factory_first') {
    return [...params.externalTakePaths];
  }
  const pathOrder = new Map<ExternalTakePathKind, number>(
    params.externalTakePaths.map((path, index) => [path, index])
  );
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
}

async function probeExternalTakePath(params: {
  provider: DiscoveryExternalTakeRouteProvider;
  control: ProbeControl;
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  approveExternalTake: DiscoveryExternalTakeApprover;
}): Promise<HybridExternalTakeProbeResult> {
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
      intent: {
        kind: 'hybrid_probe',
        abortSignal: params.control.abortController.signal,
      },
    });
    if (params.control.abandoned) {
      return {
        path: params.provider.path,
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
      quoteEvaluation: evaluation,
      countStats: false,
    });
    if (!approval.approved) {
      return {
        path: params.provider.path,
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
      durationMs: Date.now() - startedAt,
      evaluation: approval.quoteEvaluation,
      circuitOutcome,
    };
  } catch (error) {
    return {
      path: params.provider.path,
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
      .selectExternalTakeProvider({ selectedPath: params.result.path })
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

async function runHybridExternalTakeProbes(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  probeTimeoutMs: number;
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  providerRegistry: DiscoveryExternalTakeProviderRegistry;
  approveExternalTake: DiscoveryExternalTakeApprover;
}): Promise<HybridExternalTakeProbeResult[]> {
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

  if (params.routeSelectionMode !== 'factory_first') {
    const probeResults = await Promise.all(
      probeOrder.map((path) =>
        withProbeTimeout({
          provider: params.providerRegistry.selectExternalTakeProvider({
            selectedPath: path,
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
  for (const path of probeOrder) {
    const result = await withProbeTimeout({
      provider: params.providerRegistry.selectExternalTakeProvider({
        selectedPath: path,
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
  factoryNativeToQuoteReject?: HybridExternalTakeProbeResult;
}): string | undefined {
  return params.factoryNativeToQuoteReject === undefined
    ? 'factory path was not rejected only by native-to-quote gas conversion'
    : undefined;
}

async function buildHybridGasQuoteFallbackEvaluation(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  providerRegistry: DiscoveryExternalTakeProviderRegistry;
  approveExternalTake: DiscoveryExternalTakeApprover;
  probeResults: HybridExternalTakeProbeResult[];
}): Promise<
  ExternalTakeExecutionCandidate<DiscoveryExternalTakeApprovalContext> | undefined
> {
  const factoryNativeToQuoteReject = params.probeResults.find(
    (result) =>
      result.path === 'factory' &&
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
        factoryNativeToQuoteReject,
      })
    : fallbackEligibility.reason;
  if (factoryNativeToQuoteReject && fallbackIneligibleReason) {
    logger.debug(
      `Hybrid gas quote fallback skipped for pool ${params.pool.name}: ${fallbackIneligibleReason}`
    );
  }
  if (fallbackIneligibleReason) {
    return undefined;
  }

  logger.warn(
    `Hybrid external take max-profit ranking unavailable because native-to-quote gas conversion failed; attempting factory_first fallback pool=${params.pool.name} attempts="${formatGasQuoteAttempts(
      factoryNativeToQuoteReject?.gasQuoteAttempts
    )}"`
  );
  const fallbackQuote = await params.providerRegistry.factoryProvider.quote({
    pool: params.pool,
    signer: params.signer,
    poolConfig: params.poolConfig,
    price: params.price,
    auctionPrice: params.auctionPrice,
    collateral: params.collateral,
    intent: { kind: HYBRID_GAS_QUOTE_FALLBACK_KIND },
  });
  if (!fallbackQuote.isTakeable) {
    logger.debug(
      `Hybrid gas quote fallback factory quote rejected for pool ${params.pool.name}: ${fallbackQuote.reason ?? 'not takeable'}`
    );
    return undefined;
  }

  const fallbackApproval = await params.approveExternalTake({
    price: params.price,
    auctionPrice: params.auctionPrice,
    collateral: params.collateral,
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
    `Hybrid gas quote fallback activated: factory_first path=${approvedFallback.externalTakePath} source=${formatLiquiditySource(approvedFallback.selectedLiquiditySource)} pool=${params.pool.name} attempts="${formatGasQuoteAttempts(
      factoryNativeToQuoteReject?.gasQuoteAttempts
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

export async function evaluateHybridExternalTakeForDiscovery(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  probeTimeoutMs: number;
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  providerRegistry: DiscoveryExternalTakeProviderRegistry;
  approveExternalTake: DiscoveryExternalTakeApprover;
  stats: HybridExternalTakeStats;
}): Promise<ExternalTakeEvaluationResult<DiscoveryExternalTakeApprovalContext>> {
  const probeResults = await runHybridExternalTakeProbes({
    ...params,
  });
  const rejectedReasons = formatRejectedProbeReasons(probeResults);

  if (params.routeSelectionMode === 'factory_first') {
    for (const result of probeResults) {
      if (result.evaluation) {
        if (isSubsidizedExternalTakeQuote(result.evaluation)) {
          logger.debug(
            `Hybrid external take factory-first found subsidized path=${result.evaluation.externalTakePath} source=${formatLiquiditySource(result.evaluation.selectedLiquiditySource)} expectedNetProfitRaw=${result.evaluation.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} expectedSubsidyRaw=${result.evaluation.routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'}; deferring it while probing remaining paths for pool ${params.pool.name}`
          );
          continue;
        }
        logger.debug(
          `Hybrid external take factory-first selected path=${result.evaluation.externalTakePath} source=${formatLiquiditySource(result.evaluation.selectedLiquiditySource)} expectedNetProfitRaw=${result.evaluation.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} expectedSubsidyRaw=${result.evaluation.routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'} routeExecutionFloorRaw=${result.evaluation.routeExecutionFloorRaw.toString()} priorRejectedPaths=${
            probeResults
              .filter((probeResult) => !probeResult.evaluation)
              .map(
                (probeResult) =>
                  `${probeResult.path}=${probeResult.reason ?? 'not takeable'} (${probeResult.durationMs}ms)`
              )
              .join(', ') || 'none'
          } for pool ${params.pool.name}`
        );
        return { quoteEvaluation: result.evaluation };
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
      sortedApprovedEvaluations.slice(1).map((evaluation) => ({
        evaluation: cloneExternalTakeQuoteEvaluation(evaluation),
      }));
    if (
      isOneInchExternalTakeRoute(selected) ||
      isLifiExternalTakeRoute(selected)
    ) {
      const gasQuoteFallback = await buildGasQuoteFallbackEvaluation();
      if (gasQuoteFallback) {
        fallbackCandidates.push(gasQuoteFallback);
      }
    }
    logger.debug(
      `Hybrid external take selected path=${selected.externalTakePath} source=${formatLiquiditySource(selected.selectedLiquiditySource)} expectedNetProfitRaw=${selected.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} expectedSubsidyRaw=${selected.routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'} routeExecutionFloorRaw=${selected.routeExecutionFloorRaw.toString()} rejectedPaths=${rejectedReasons.join(', ') || 'none'} for pool ${params.pool.name}`
    );
    return {
      quoteEvaluation: selectedWithFallbacks,
      executionPlan: {
        primary: {
          evaluation: selectedWithFallbacks,
        },
        fallbacks: fallbackCandidates,
      },
    };
  }

  const gasQuoteFallback = await buildGasQuoteFallbackEvaluation();
  if (gasQuoteFallback) {
    return {
      quoteEvaluation: gasQuoteFallback.evaluation,
      executionPlan: {
        primary: gasQuoteFallback,
        fallbacks: [],
      },
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
  providerRegistry: DiscoveryExternalTakeProviderRegistry;
  approveExternalTake: DiscoveryExternalTakeApprover;
  stats: DiscoveredTakeTargetStats;
}): Promise<boolean> {
  const executionCandidates = resolveExternalTakeExecutionCandidates({
    primaryEvaluation: params.liquidation.externalTakeQuoteEvaluation,
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
      allowedExternalTakePaths: params.externalTakePaths,
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
      // The primary path already passed the engine's final approval hook.
      // Fallbacks are selected inside this executor, so refresh and reapprove
      // them immediately before attempting execution.
      let refreshedStatus;
      try {
        refreshedStatus = await params.pool
          .getLiquidation(params.liquidation.borrower)
          .getStatus();
      } catch (error) {
        logger.warn(
          `Hybrid fallback path could not refresh auction state for ${params.pool.name}/${params.liquidation.borrower}: ${getErrorMessage(error)}`
        );
        continue;
      }
      executionLiquidation = {
        ...params.liquidation,
        auctionPrice: refreshedStatus.price,
        collateral: refreshedStatus.collateral,
      };
      const fallbackApproval: ExternalTakeApprovalResult =
        await params.approveExternalTake({
          price: Number(
            ethers.utils.formatEther(executionLiquidation.auctionPrice)
          ),
          auctionPrice: executionLiquidation.auctionPrice,
          collateral: executionLiquidation.collateral,
          quoteEvaluation: candidateEvaluation,
          externalTakeApprovalContext: candidate.approvalContext,
          countStats: false,
          forceGasRefresh: true,
        });
      if (!fallbackApproval.approved) {
        logger.debug(
          `Hybrid fallback path rejected during final approval for ${params.pool.name}/${params.liquidation.borrower}: ${
            fallbackApproval.reason ?? 'policy rejected fallback path'
          }`
        );
        continue;
      }
      approvedEvaluation = withExternalTakeApprovalContext({
        quoteEvaluation: fallbackApproval.quoteEvaluation,
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

    const provider = params.providerRegistry.selectExternalTakeProvider({
      selectedPath,
    });
    const attempt = await provider.execute({
      pool: params.pool,
      signer: params.signer,
      poolConfig: params.poolConfig,
      liquidation: liquidationForCandidate,
      config: params.config,
      selectedSource,
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
        `Hybrid ${PROVIDER_WARN_LABEL[provider.path]} path failed before submission for ${params.pool.name}/${params.liquidation.borrower}; trying next approved fallback path`
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
