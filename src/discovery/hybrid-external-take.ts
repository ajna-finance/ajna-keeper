import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import {
  ActiveExternalTakeRouteSelectionMode,
  ExternalTakePathKind,
  formatLiquiditySource,
} from '../config';
import { logger } from '../logging';
import { isSubsidizedExternalTakeQuote } from '../take/external-take-policy';
import { ExternalTakeQuoteEvaluation } from '../take/types';
import { getErrorMessage } from '../utils';
import {
  ExternalTakeApprovalRejectCategory,
  DiscoveryExternalTakeApprover,
} from './external-take-approval';
import {
  cloneExternalTakeQuoteEvaluation,
  isLifiExternalTakeRoute,
  isOneInchExternalTakeRoute,
} from './external-take-evaluation';
import {
  AutoDiscoverTakePolicyRuntime,
  FactoryPathQuoteFn,
  LifiCircuitOutcome,
  LifiPathQuoteFn,
  OneInchCircuitOutcome,
  OneInchPathQuoteFn,
} from './external-take-quotes';
import { sortExternalTakeQuoteEvaluationsForSelection } from './external-take-selection';
import { GasPolicyResult } from './gas-policy';
import { ResolvedTakeTarget } from './targets';

export interface HybridExternalTakeStats {
  gasPolicyRejects: number;
  profitFloorRejects: number;
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
  const pathOrder = new Map<ExternalTakePathKind, number>(
    params.externalTakePaths.map((path, index) => [path, index])
  );
  const getProbeOrder = (): ExternalTakePathKind[] => {
    if (params.routeSelectionMode !== 'factory_first') {
      return [...params.externalTakePaths];
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
    gasPolicyRejectCode?: GasPolicyResult['rejectCode'];
    gasQuoteAttempts?: GasPolicyResult['gasQuoteAttempts'];
    oneInchCircuitOutcome?: OneInchCircuitOutcome;
    lifiCircuitOutcome?: LifiCircuitOutcome;
  };
  type ProbeControl = {
    abandoned: boolean;
    abortController: AbortController;
  };
  const getOneInchCircuitOutcome = (
    evaluation: ExternalTakeQuoteEvaluation
  ): OneInchCircuitOutcome | undefined => {
    if (evaluation.reason?.startsWith('1inch quote circuit open')) {
      return undefined;
    }
    if (evaluation.quoteFailureRetryable === true) {
      return 'failure';
    }
    return evaluation.quoteAmountRaw !== undefined ? 'success' : 'neutral';
  };
  const getLifiCircuitOutcome = (
    evaluation: ExternalTakeQuoteEvaluation
  ): LifiCircuitOutcome | undefined => {
    if (evaluation.reason?.startsWith('LI.FI quote circuit open')) {
      return undefined;
    }
    if (evaluation.quoteFailureRetryable === true) {
      return 'failure';
    }
    return evaluation.quoteAmountRaw !== undefined ? 'success' : 'neutral';
  };
  const probeExternalTakePath = async (
    path: ExternalTakePathKind,
    control?: ProbeControl
  ): Promise<ProbeResult> => {
    const startedAt = Date.now();
    let oneInchCircuitOutcome: OneInchCircuitOutcome | undefined;
    let lifiCircuitOutcome: LifiCircuitOutcome | undefined;
    try {
      let evaluation: ExternalTakeQuoteEvaluation;
      if (path === 'oneinch') {
        evaluation = await params.quoteOneInchPath({
          pool: params.pool,
          signer: params.signer,
          poolConfig: params.poolConfig,
          price: params.price,
          auctionPrice: params.auctionPrice,
          collateral: params.collateral,
          routeProbeAbortSignal: control?.abortController.signal,
        });
      } else if (path === 'factory') {
        evaluation = await params.quoteFactoryPath({
          pool: params.pool,
          signer: params.signer,
          poolConfig: params.poolConfig,
          auctionPrice: params.auctionPrice,
          collateral: params.collateral,
          routeProbeAbortSignal: control?.abortController.signal,
        });
      } else {
        evaluation = await params.quoteLifiPath({
          pool: params.pool,
          signer: params.signer,
          poolConfig: params.poolConfig,
          price: params.price,
          auctionPrice: params.auctionPrice,
          collateral: params.collateral,
          routeProbeAbortSignal: control?.abortController.signal,
          recordCircuitOutcome: false,
        });
      }
      if (control?.abandoned) {
        return {
          path,
          durationMs: Date.now() - startedAt,
          reason: 'probe abandoned after timeout',
        };
      }
      oneInchCircuitOutcome =
        path === 'oneinch' ? getOneInchCircuitOutcome(evaluation) : undefined;
      lifiCircuitOutcome =
        path === 'lifi' ? getLifiCircuitOutcome(evaluation) : undefined;
      if (!evaluation.isTakeable) {
        const gasPolicyRejectCode =
          evaluation.routeProfitability?.gasPolicyRejectCode;
        return {
          path,
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
          path,
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
        path,
        durationMs: Date.now() - startedAt,
        evaluation: approval.quoteEvaluation ?? evaluation,
        oneInchCircuitOutcome,
        lifiCircuitOutcome,
      };
    } catch (error) {
      return {
        path,
        durationMs: Date.now() - startedAt,
        reason: getErrorMessage(error),
        oneInchCircuitOutcome:
          path === 'oneinch' ? (oneInchCircuitOutcome ?? 'failure') : undefined,
        lifiCircuitOutcome:
          path === 'lifi' ? (lifiCircuitOutcome ?? 'failure') : undefined,
      };
    }
  };
  const recordProbeCircuitOutcome = (result: ProbeResult): void => {
    if (result.oneInchCircuitOutcome) {
      params.recordOneInchCircuitOutcome(result.oneInchCircuitOutcome);
    }
    if (result.lifiCircuitOutcome) {
      params.recordLifiCircuitOutcome(result.lifiCircuitOutcome);
    }
  };

  const withProbeTimeout = async (
    path: ExternalTakePathKind
  ): Promise<ProbeResult> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const control: ProbeControl = {
      abandoned: false,
      abortController: new AbortController(),
    };
    const probe = probeExternalTakePath(path, control);
    probe.catch(() => undefined);
    try {
      return await Promise.race([
        probe,
        new Promise<ProbeResult>((resolve) => {
          timeout = setTimeout(() => {
            // Keep the flag as a backstop for any late probe work that has not
            // reached an abort-aware RPC/API checkpoint yet.
            control.abandoned = true;
            control.abortController.abort(
              new Error(`probe timed out after ${params.probeTimeoutMs}ms`)
            );
            resolve({
              path,
              durationMs: params.probeTimeoutMs,
              reason: `probe timed out after ${params.probeTimeoutMs}ms`,
              oneInchCircuitOutcome: path === 'oneinch' ? 'failure' : undefined,
              lifiCircuitOutcome: path === 'lifi' ? 'failure' : undefined,
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
  const rejectedReasons = probeResults
    .filter((result) => !result.evaluation)
    .map(
      (result) =>
        `${result.path}=${result.reason ?? 'not takeable'} (${result.durationMs}ms)`
    );

  const formatGasQuoteAttempts = (
    attempts: GasPolicyResult['gasQuoteAttempts']
  ): string => {
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
  };
  const factoryNativeToQuoteReject = probeResults.find(
    (result) =>
      result.path === 'factory' &&
      result.gasPolicyRejectCode === 'native_to_quote_conversion_unavailable'
  );
  const getFallbackIneligibleReason = (): string | undefined => {
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
    if (!factoryNativeToQuoteReject) {
      return 'factory path was not rejected only by native-to-quote gas conversion';
    }
    return undefined;
  };
  const buildHybridGasQuoteFallbackEvaluation = async (): Promise<
    ExternalTakeQuoteEvaluation | undefined
  > => {
    const fallbackIneligibleReason = getFallbackIneligibleReason();
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
  };

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
      const gasQuoteFallback = await buildHybridGasQuoteFallbackEvaluation();
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

  const gasQuoteFallback = await buildHybridGasQuoteFallbackEvaluation();
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
