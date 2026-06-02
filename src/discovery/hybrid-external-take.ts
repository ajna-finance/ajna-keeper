import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  ActiveExternalTakeRouteSelectionMode,
  ExternalTakePathKind,
  formatLiquiditySource,
} from '../config';
import { logger } from '../logging';
import { isSubsidizedExternalTakeQuote } from '../take/external-take-policy';
import {
  ExternalTakeQuoteEvaluation,
  TakeLiquidationPlan,
} from '../take/types';
import { getErrorMessage } from '../utils';
import {
  DiscoveryExternalTakeApprover,
  ExternalTakeApprovalRejectCategory,
  ExternalTakeApprovalResult,
} from './external-take-approval';
import {
  cloneExternalTakeQuoteEvaluation,
  isLifiExternalTakeRoute,
  isOneInchExternalTakeRoute,
  withExternalTakeApprovalContext,
} from './external-take-evaluation';
import { DiscoveryExternalExecutionConfig } from './external-take-provider';
import { DiscoveryExternalTakeProviderRegistry } from './external-take-providers';
import {
  AutoDiscoverTakePolicyRuntime,
  FactoryPathQuoteFn,
  LifiCircuitOutcome,
  LifiPathQuoteFn,
  OneInchCircuitOutcome,
  OneInchPathQuoteFn,
} from './external-take-quotes';
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
  evaluation?: ExternalTakeQuoteEvaluation;
  reason?: string;
  rejectCategory?: ExternalTakeApprovalRejectCategory;
  gasPolicyRejectCode?: GasPolicyResult['rejectCode'];
  gasQuoteAttempts?: GasPolicyResult['gasQuoteAttempts'];
  oneInchCircuitOutcome?: OneInchCircuitOutcome;
  lifiCircuitOutcome?: LifiCircuitOutcome;
};

type ProbeControl = {
  abandoned: boolean;
  abortController: AbortController;
};

function getOneInchCircuitOutcome(
  evaluation: ExternalTakeQuoteEvaluation
): OneInchCircuitOutcome | undefined {
  if (evaluation.reason?.startsWith('1inch quote circuit open')) {
    return undefined;
  }
  if (evaluation.quoteFailureRetryable === true) {
    return 'failure';
  }
  return evaluation.quoteAmountRaw !== undefined ? 'success' : 'neutral';
}

function getLifiCircuitOutcome(
  evaluation: ExternalTakeQuoteEvaluation
): LifiCircuitOutcome | undefined {
  if (evaluation.reason?.startsWith('LI.FI quote circuit open')) {
    return undefined;
  }
  if (evaluation.quoteFailureRetryable === true) {
    return 'failure';
  }
  return evaluation.quoteAmountRaw !== undefined ? 'success' : 'neutral';
}

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
  path: ExternalTakePathKind;
  control?: ProbeControl;
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  quoteOneInchPath: OneInchPathQuoteFn;
  quoteFactoryPath: FactoryPathQuoteFn;
  quoteLifiPath: LifiPathQuoteFn;
  approveExternalTake: DiscoveryExternalTakeApprover;
}): Promise<HybridExternalTakeProbeResult> {
  const startedAt = Date.now();
  let oneInchCircuitOutcome: OneInchCircuitOutcome | undefined;
  let lifiCircuitOutcome: LifiCircuitOutcome | undefined;
  try {
    let evaluation: ExternalTakeQuoteEvaluation;
    if (params.path === 'oneinch') {
      evaluation = await params.quoteOneInchPath({
        pool: params.pool,
        signer: params.signer,
        poolConfig: params.poolConfig,
        price: params.price,
        auctionPrice: params.auctionPrice,
        collateral: params.collateral,
        routeProbeAbortSignal: params.control?.abortController.signal,
      });
    } else if (params.path === 'factory') {
      evaluation = await params.quoteFactoryPath({
        pool: params.pool,
        signer: params.signer,
        poolConfig: params.poolConfig,
        auctionPrice: params.auctionPrice,
        collateral: params.collateral,
        routeProbeAbortSignal: params.control?.abortController.signal,
      });
    } else {
      evaluation = await params.quoteLifiPath({
        pool: params.pool,
        signer: params.signer,
        poolConfig: params.poolConfig,
        price: params.price,
        auctionPrice: params.auctionPrice,
        collateral: params.collateral,
        routeProbeAbortSignal: params.control?.abortController.signal,
        recordCircuitOutcome: false,
      });
    }
    if (params.control?.abandoned) {
      return {
        path: params.path,
        durationMs: Date.now() - startedAt,
        reason: 'probe abandoned after timeout',
      };
    }
    oneInchCircuitOutcome =
      params.path === 'oneinch'
        ? getOneInchCircuitOutcome(evaluation)
        : undefined;
    lifiCircuitOutcome =
      params.path === 'lifi' ? getLifiCircuitOutcome(evaluation) : undefined;
    if (!evaluation.isTakeable) {
      const gasPolicyRejectCode =
        evaluation.routeProfitability?.gasPolicyRejectCode;
      return {
        path: params.path,
        durationMs: Date.now() - startedAt,
        reason: evaluation.reason ?? 'not takeable',
        rejectCategory:
          gasPolicyRejectCode !== undefined ? 'gasPolicy' : undefined,
        gasPolicyRejectCode,
        gasQuoteAttempts: evaluation.routeProfitability?.gasQuoteAttempts,
        oneInchCircuitOutcome,
        lifiCircuitOutcome,
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
        path: params.path,
        durationMs: Date.now() - startedAt,
        reason: approval.reason ?? 'policy rejected path',
        rejectCategory: approval.rejectCategory,
        gasPolicyRejectCode: approval.gasPolicyRejectCode,
        gasQuoteAttempts: approval.gasQuoteAttempts,
        oneInchCircuitOutcome,
        lifiCircuitOutcome,
      };
    }
    return {
      path: params.path,
      durationMs: Date.now() - startedAt,
      evaluation: approval.quoteEvaluation ?? evaluation,
      oneInchCircuitOutcome,
      lifiCircuitOutcome,
    };
  } catch (error) {
    return {
      path: params.path,
      durationMs: Date.now() - startedAt,
      reason: getErrorMessage(error),
      oneInchCircuitOutcome:
        params.path === 'oneinch'
          ? (oneInchCircuitOutcome ?? 'failure')
          : undefined,
      lifiCircuitOutcome:
        params.path === 'lifi' ? (lifiCircuitOutcome ?? 'failure') : undefined,
    };
  }
}

function recordProbeCircuitOutcome(params: {
  result: HybridExternalTakeProbeResult;
  recordOneInchCircuitOutcome: (outcome: OneInchCircuitOutcome) => void;
  recordLifiCircuitOutcome: (outcome: LifiCircuitOutcome) => void;
}): void {
  if (params.result.oneInchCircuitOutcome) {
    params.recordOneInchCircuitOutcome(params.result.oneInchCircuitOutcome);
  }
  if (params.result.lifiCircuitOutcome) {
    params.recordLifiCircuitOutcome(params.result.lifiCircuitOutcome);
  }
}

async function withProbeTimeout(params: {
  path: ExternalTakePathKind;
  probeTimeoutMs: number;
  probe: (
    path: ExternalTakePathKind,
    control: ProbeControl
  ) => Promise<HybridExternalTakeProbeResult>;
}): Promise<HybridExternalTakeProbeResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const control: ProbeControl = {
    abandoned: false,
    abortController: new AbortController(),
  };
  const probe = params.probe(params.path, control);
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
            path: params.path,
            durationMs: params.probeTimeoutMs,
            reason: `probe timed out after ${params.probeTimeoutMs}ms`,
            oneInchCircuitOutcome:
              params.path === 'oneinch' ? 'failure' : undefined,
            lifiCircuitOutcome: params.path === 'lifi' ? 'failure' : undefined,
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
  quoteOneInchPath: OneInchPathQuoteFn;
  quoteFactoryPath: FactoryPathQuoteFn;
  quoteLifiPath: LifiPathQuoteFn;
  approveExternalTake: DiscoveryExternalTakeApprover;
  recordOneInchCircuitOutcome: (outcome: OneInchCircuitOutcome) => void;
  recordLifiCircuitOutcome: (outcome: LifiCircuitOutcome) => void;
}): Promise<HybridExternalTakeProbeResult[]> {
  const probeOrder = resolveProbeOrder(params);
  const runProbe = async (path: ExternalTakePathKind, control: ProbeControl) =>
    await probeExternalTakePath({
      ...params,
      path,
      control,
    });

  if (params.routeSelectionMode !== 'factory_first') {
    const probeResults = await Promise.all(
      probeOrder.map((path) =>
        withProbeTimeout({
          path,
          probeTimeoutMs: params.probeTimeoutMs,
          probe: runProbe,
        })
      )
    );
    probeResults.forEach((result) =>
      recordProbeCircuitOutcome({
        result,
        recordOneInchCircuitOutcome: params.recordOneInchCircuitOutcome,
        recordLifiCircuitOutcome: params.recordLifiCircuitOutcome,
      })
    );
    return probeResults;
  }

  const probeResults: HybridExternalTakeProbeResult[] = [];
  for (const path of probeOrder) {
    const result = await withProbeTimeout({
      path,
      probeTimeoutMs: params.probeTimeoutMs,
      probe: runProbe,
    });
    probeResults.push(result);
    recordProbeCircuitOutcome({
      result,
      recordOneInchCircuitOutcome: params.recordOneInchCircuitOutcome,
      recordLifiCircuitOutcome: params.recordLifiCircuitOutcome,
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

function getFallbackIneligibleReason(params: {
  takePolicy: AutoDiscoverTakePolicyRuntime;
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  externalTakePaths: ExternalTakePathKind[];
  factoryNativeToQuoteReject?: HybridExternalTakeProbeResult;
}): string | undefined {
  if (
    params.takePolicy?.hybridGasQuoteFailureFallbackMode !== 'factory_first'
  ) {
    return 'fallback disabled';
  }
  if (params.routeSelectionMode !== 'maximize_profit') {
    return 'route selection mode is not maximize_profit';
  }
  if (
    !params.externalTakePaths.includes('factory') ||
    (!params.externalTakePaths.includes('oneinch') &&
      !params.externalTakePaths.includes('lifi'))
  ) {
    return 'hybrid paths do not include factory and at least one aggregator path';
  }
  if (params.takePolicy?.maxGasCostNative === undefined) {
    return 'maxGasCostNative is not configured';
  }
  if (params.takePolicy?.maxGasCostQuote !== undefined) {
    return 'maxGasCostQuote is configured';
  }
  if (params.takePolicy?.minExpectedProfitQuote !== undefined) {
    return 'minExpectedProfitQuote is configured';
  }
  if (params.takePolicy?.minProfitNative !== undefined) {
    return 'minProfitNative is configured';
  }
  if (!params.factoryNativeToQuoteReject) {
    return 'factory path was not rejected only by native-to-quote gas conversion';
  }
  return undefined;
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
  quoteFactoryPath: FactoryPathQuoteFn;
  approveExternalTake: DiscoveryExternalTakeApprover;
  probeResults: HybridExternalTakeProbeResult[];
}): Promise<ExternalTakeQuoteEvaluation | undefined> {
  const factoryNativeToQuoteReject = params.probeResults.find(
    (result) =>
      result.path === 'factory' &&
      result.gasPolicyRejectCode === 'native_to_quote_conversion_unavailable'
  );
  const fallbackIneligibleReason = getFallbackIneligibleReason({
    takePolicy: params.takePolicy,
    routeSelectionMode: params.routeSelectionMode,
    externalTakePaths: params.externalTakePaths,
    factoryNativeToQuoteReject,
  });
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
  const fallbackQuote = await params.quoteFactoryPath({
    pool: params.pool,
    signer: params.signer,
    poolConfig: params.poolConfig,
    auctionPrice: params.auctionPrice,
    collateral: params.collateral,
    factoryGasQuoteFallback: true,
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
    approvalMode: 'factory_gas_quote_fallback',
    countStats: false,
    forceGasRefresh: true,
  });
  if (!fallbackApproval.approved) {
    logger.debug(
      `Hybrid gas quote fallback approval rejected for pool ${params.pool.name}: ${fallbackApproval.reason ?? 'policy rejected fallback path'}`
    );
    return undefined;
  }

  const approvedFallback = fallbackApproval.quoteEvaluation ?? fallbackQuote;
  const markedFallback: ExternalTakeQuoteEvaluation = {
    ...approvedFallback,
    approvalMode: 'factory_gas_quote_fallback',
  };
  logger.warn(
    `Hybrid gas quote fallback activated: factory_first path=${markedFallback.externalTakePath} source=${formatLiquiditySource(markedFallback.selectedLiquiditySource)} pool=${params.pool.name} attempts="${formatGasQuoteAttempts(
      factoryNativeToQuoteReject?.gasQuoteAttempts
    )}"`
  );
  return markedFallback;
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
  quoteOneInchPath: OneInchPathQuoteFn;
  quoteFactoryPath: FactoryPathQuoteFn;
  quoteLifiPath: LifiPathQuoteFn;
  approveExternalTake: DiscoveryExternalTakeApprover;
  recordOneInchCircuitOutcome: (outcome: OneInchCircuitOutcome) => void;
  recordLifiCircuitOutcome: (outcome: LifiCircuitOutcome) => void;
  stats: HybridExternalTakeStats;
}): Promise<ExternalTakeQuoteEvaluation> {
  const probeResults = await runHybridExternalTakeProbes(params);
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
          `Hybrid external take factory-first selected path=${result.evaluation.externalTakePath} source=${formatLiquiditySource(result.evaluation.selectedLiquiditySource)} expectedNetProfitRaw=${result.evaluation.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} expectedSubsidyRaw=${result.evaluation.routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'} approvedMinOutRaw=${result.evaluation.approvedMinOutRaw?.toString() ?? 'n/a'} priorRejectedPaths=${
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
    const fallbackEvaluations = sortedApprovedEvaluations
      .slice(1)
      .map((evaluation) => {
        const fallback = cloneExternalTakeQuoteEvaluation(evaluation);
        fallback.fallbackExternalTakeQuoteEvaluations = undefined;
        return fallback;
      });
    if (
      isOneInchExternalTakeRoute(selected) ||
      isLifiExternalTakeRoute(selected)
    ) {
      const gasQuoteFallback = await buildGasQuoteFallbackEvaluation();
      if (gasQuoteFallback) {
        fallbackEvaluations.push(gasQuoteFallback);
      }
    }
    selectedWithFallbacks.fallbackExternalTakeQuoteEvaluations =
      fallbackEvaluations;
    logger.debug(
      `Hybrid external take selected path=${selected.externalTakePath} source=${formatLiquiditySource(selected.selectedLiquiditySource)} expectedNetProfitRaw=${selected.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} expectedSubsidyRaw=${selected.routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'} approvedMinOutRaw=${selected.approvedMinOutRaw?.toString() ?? 'n/a'} rejectedPaths=${rejectedReasons.join(', ') || 'none'} for pool ${params.pool.name}`
    );
    return selectedWithFallbacks;
  }

  const gasQuoteFallback = await buildGasQuoteFallbackEvaluation();
  if (gasQuoteFallback) {
    return gasQuoteFallback;
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

export async function executeHybridExternalTakeForDiscovery(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  liquidation: TakeLiquidationPlan;
  config: DiscoveryExternalExecutionConfig;
  externalTakePaths: ExternalTakePathKind[];
  providerRegistry: DiscoveryExternalTakeProviderRegistry;
  approveExternalTake: DiscoveryExternalTakeApprover;
  stats: DiscoveredTakeTargetStats;
}): Promise<boolean> {
  const primaryEvaluation = params.liquidation.externalTakeQuoteEvaluation;
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
        `Hybrid external take ${selection.reason}; refusing execution for ${params.pool.name}/${params.liquidation.borrower}`
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
