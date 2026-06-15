import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import {
  CalldataAggregatorLiquiditySource,
  LiquiditySource,
  formatLiquiditySource,
  getAutoDiscoverTakePolicy,
  resolveCalldataAggregatorProviderForSource,
} from '../../config';
import { DiscoveryReadTransports } from '../../read-transports';
import * as directDexModule from '../../take/direct-dex';
import { DirectDexRouteProfitabilityContext } from '../../take/direct-dex';
import {
  AuctionTakeFacts,
  ExternalTakeQuoteEvaluation,
} from '../../take/types';
import { resolveCalldataAggregatorQuoteIdentity } from '../../take/external-take/route-binding';
import {
  AsyncOperationLimiter,
  getErrorMessage,
  withTimeoutAbort,
} from '../../utils';
import {
  ExternalTakeQuoteCircuitOutcome,
  withTakeLiquiditySource,
} from './provider';
import { recordLifiQuoteFailure, recordLifiQuoteSuccess } from './lifi-circuit';
import {
  recordOneInchQuoteFailure,
  recordOneInchQuoteSuccess,
} from './one-inch-circuit';
import { ResolvedTakeTarget } from '../targets';
import {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
  LifiCircuitPurpose,
  OneInchQuoteCircuitPurpose,
} from '../types';

export type AutoDiscoverTakePolicyRuntime = ReturnType<
  typeof getAutoDiscoverTakePolicy
>;
export type OneInchCircuitOutcome = ExternalTakeQuoteCircuitOutcome;
export type LifiCircuitOutcome = ExternalTakeQuoteCircuitOutcome;

export interface DirectDexPathQuoteInput extends AuctionTakeFacts {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  directDexGasQuoteFallback?: boolean;
  routeProbeAbortSignal?: AbortSignal;
}

export interface CalldataAggregatorPathQuoteInput
  extends DirectDexPathQuoteInput {
  price: number;
  quoteCircuitMode?: 'record' | 'observe';
}

export interface OneInchAggregatorPathQuoteInput
  extends CalldataAggregatorPathQuoteInput {}

export interface LifiPathQuoteInput extends CalldataAggregatorPathQuoteInput {}

export interface SushiAggregatorPathQuoteInput
  extends CalldataAggregatorPathQuoteInput {}

export type DirectDexPathQuoteFn = (
  quoteParams: DirectDexPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

export type CalldataAggregatorPathQuoteFn = (
  quoteParams: CalldataAggregatorPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

export type OneInchAggregatorPathQuoteFn = (
  quoteParams: OneInchAggregatorPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

export type LifiPathQuoteFn = (
  quoteParams: LifiPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

export type SushiAggregatorPathQuoteFn = (
  quoteParams: SushiAggregatorPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

export type DiscoveryDirectDexQuoteConfig = {
  uniswapV3RouterOverrides: DiscoveryExecutionConfig['uniswapV3RouterOverrides'];
  curveRouterOverrides: DiscoveryExecutionConfig['curveRouterOverrides'];
  tokenAddresses: DiscoveryExecutionConfig['tokenAddresses'];
};

export type DiscoveryDirectDexRouteProfitabilityContextBuilder = (params: {
  pool: FungiblePool;
  signer: Signer;
  config: DiscoveryExecutionConfig;
  transports: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
  defaultLiquiditySource: LiquiditySource | undefined;
  sources?: LiquiditySource[];
  allowSubsidy?: boolean;
  takePolicy: AutoDiscoverTakePolicyRuntime;
}) => Promise<DirectDexRouteProfitabilityContext | undefined>;

export type DiscoveryTokenDecimalsCacheResolver = (
  rpcCache?: DiscoveryRpcCache
) => Map<string, number> | undefined;

async function withCombinedAbortSignal<T>(
  signals: Array<AbortSignal | undefined>,
  fn: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (activeSignals.length === 0) {
    return await fn();
  }
  if (activeSignals.length === 1) {
    return await fn(activeSignals[0]);
  }

  const controller = new AbortController();
  const cleanup: Array<() => void> = [];
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener('abort', listener, { once: true });
    cleanup.push(() => signal.removeEventListener('abort', listener));
  }

  try {
    return await fn(controller.signal);
  } finally {
    for (const removeListener of cleanup) {
      removeListener();
    }
  }
}

export function recordOneInchCircuitOutcomeForDiscovery(params: {
  rpcCache?: DiscoveryRpcCache;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  outcome: OneInchCircuitOutcome;
  purpose?: OneInchQuoteCircuitPurpose;
}): void {
  if (params.outcome === 'neutral') {
    return;
  }
  if (params.outcome === 'failure') {
    recordOneInchQuoteFailure({
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      purpose: params.purpose,
    });
    return;
  }
  recordOneInchQuoteSuccess(params.rpcCache, params.purpose);
}

export function recordLifiCircuitOutcomeForDiscovery(params: {
  rpcCache?: DiscoveryRpcCache;
  config?: DiscoveryExecutionConfig;
  outcome: LifiCircuitOutcome;
  purpose?: LifiCircuitPurpose;
}): void {
  if (params.outcome === 'neutral') {
    return;
  }
  if (params.outcome === 'failure') {
    recordLifiQuoteFailure({
      rpcCache: params.rpcCache,
      lifiConfig: params.config?.lifi,
      purpose: params.purpose,
    });
    return;
  }
  recordLifiQuoteSuccess(params.rpcCache, params.purpose);
}

export async function quoteDirectDexPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    transports: DiscoveryReadTransports;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    resolvedDefaultDirectDexLiquiditySource: LiquiditySource | undefined;
    routeProbeLimiter?: AsyncOperationLimiter;
    directDexQuoteConfig: DiscoveryDirectDexQuoteConfig;
    buildDirectDexRouteProfitabilityContext: DiscoveryDirectDexRouteProfitabilityContextBuilder;
  } & DirectDexPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  if (params.resolvedDefaultDirectDexLiquiditySource === undefined) {
    return {
      isTakeable: false,
      externalTakePath: 'direct_dex',
      reason: 'direct_dex external take path is not configured',
    };
  }
  const directDexPoolConfig = withTakeLiquiditySource(
    params.poolConfig,
    params.resolvedDefaultDirectDexLiquiditySource
  );
  const routeProfitabilityContextBuilder = async (sources: LiquiditySource[]) =>
    await params.buildDirectDexRouteProfitabilityContext({
      pool: params.pool,
      signer: params.signer,
      config: params.config,
      transports: params.transports,
      rpcCache: params.rpcCache,
      defaultLiquiditySource: params.resolvedDefaultDirectDexLiquiditySource,
      sources,
      allowSubsidy: params.poolConfig.take.allowSubsidy === true,
      takePolicy: params.takePolicy,
    });
  const routeSelection = {
    allowedLiquiditySources: params.takePolicy?.allowedLiquiditySources,
    routeQuoteBudgetPerCandidate:
      params.takePolicy?.takeRouteQuoteBudgetPerCandidate,
    routeProbeLimiter: params.routeProbeLimiter,
    routeProbeAbortSignal: params.routeProbeAbortSignal,
    routeProfitabilityContextBuilder: params.directDexGasQuoteFallback
      ? undefined
      : routeProfitabilityContextBuilder,
  };

  const evaluation = await directDexModule.getDirectDexTakeQuoteEvaluation(
    params.pool,
    params.auctionPrice,
    params.collateral,
    directDexPoolConfig,
    params.directDexQuoteConfig,
    params.signer,
    params.rpcCache?.directDexQuoteProviders,
    routeSelection
  );
  return {
    ...evaluation,
    externalTakePath: 'direct_dex',
    quotedAuctionPriceWad:
      evaluation.quotedAuctionPriceWad ?? params.auctionPrice,
    quotedCollateralWad: evaluation.quotedCollateralWad ?? params.collateral,
  };
}

export function getCircuitGuardedQuoteOutcome(
  evaluation: ExternalTakeQuoteEvaluation
): ExternalTakeQuoteCircuitOutcome | undefined {
  if (evaluation.quoteCircuitOpen === true) {
    return undefined;
  }
  if (evaluation.quoteFailureRetryable === true) {
    return 'failure';
  }
  return evaluation.quoteAmountRaw !== undefined ? 'success' : 'neutral';
}

export type QuoteCircuitPolicy =
  | {
      kind: 'none';
    }
  | {
      kind: 'observe';
      openReason?: string;
    }
  | {
      kind: 'record';
      openReason?: string;
      recordOutcome: (outcome: ExternalTakeQuoteCircuitOutcome) => void;
    };

function getCircuitOpenReason(policy: QuoteCircuitPolicy): string | undefined {
  return policy.kind === 'none' ? undefined : policy.openReason;
}

function recordCircuitOutcome(
  policy: QuoteCircuitPolicy,
  outcome: ExternalTakeQuoteCircuitOutcome
): void {
  if (policy.kind === 'record') {
    policy.recordOutcome(outcome);
  }
}

function getCalldataAggregatorQuoteIdentityMismatch(params: {
  label: string;
  expectedPath: 'calldata_aggregator';
  expectedLiquiditySource: CalldataAggregatorLiquiditySource;
  evaluation: ExternalTakeQuoteEvaluation;
}): string | undefined {
  if (params.evaluation.externalTakePath !== params.expectedPath) {
    return `${params.label} quote returned path ${params.evaluation.externalTakePath ?? 'none'} instead of ${params.expectedPath}`;
  }
  if (
    params.evaluation.selectedLiquiditySource !== params.expectedLiquiditySource
  ) {
    return `${params.label} quote returned source ${formatLiquiditySource(
      params.evaluation.selectedLiquiditySource
    )} instead of ${formatLiquiditySource(params.expectedLiquiditySource)}`;
  }

  const expectedProviderId = resolveCalldataAggregatorProviderForSource(
    params.expectedLiquiditySource
  );
  const identity = resolveCalldataAggregatorQuoteIdentity(params.evaluation);
  if (identity.mismatch !== undefined) {
    return `${params.label} quote returned conflicting provider identity provider=${identity.mismatch.providerId} calldataQuoteProvider=${identity.mismatch.calldataQuoteProviderId}`;
  }
  if (
    identity.providerId !== undefined &&
    identity.providerId !== expectedProviderId
  ) {
    return `${params.label} quote returned provider ${identity.providerId} instead of ${expectedProviderId ?? 'none'}`;
  }
  if (
    params.evaluation.quoteAmountRaw !== undefined &&
    identity.providerId === undefined
  ) {
    return `${params.label} quote returned an executable amount without provider identity`;
  }
  return undefined;
}

export async function quoteCircuitGuardedPath(params: {
  poolName: string;
  label: string;
  externalTakePath: 'calldata_aggregator';
  selectedLiquiditySource: CalldataAggregatorLiquiditySource;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  circuit: QuoteCircuitPolicy;
  routeProbeLimiter?: AsyncOperationLimiter;
  routeProbeAbortSignal?: AbortSignal;
  probeTimeoutMs: number;
  abortErrorMessage: string;
  timeoutLabel: string;
  evaluate: (signal?: AbortSignal) => Promise<ExternalTakeQuoteEvaluation>;
}): Promise<ExternalTakeQuoteEvaluation> {
  const circuitOpenReason = getCircuitOpenReason(params.circuit);
  if (circuitOpenReason) {
    return {
      isTakeable: false,
      externalTakePath: params.externalTakePath,
      selectedLiquiditySource: params.selectedLiquiditySource,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      quoteCircuitOpen: true,
      reason: circuitOpenReason,
    };
  }

  let evaluation: ExternalTakeQuoteEvaluation;
  try {
    evaluation = await withTimeoutAbort(
      async (timeoutSignal) =>
        await withCombinedAbortSignal(
          [timeoutSignal, params.routeProbeAbortSignal],
          async (signal) => {
            if (signal?.aborted) {
              throw signal.reason instanceof Error
                ? signal.reason
                : new Error(params.abortErrorMessage);
            }
            const evaluateQuote = async () => await params.evaluate(signal);
            return params.routeProbeLimiter
              ? await params.routeProbeLimiter.run(
                  `${params.label} quote ${params.poolName}`,
                  evaluateQuote,
                  { signal }
                )
              : await evaluateQuote();
          }
        ),
      params.probeTimeoutMs,
      params.timeoutLabel
    );
  } catch (error) {
    recordCircuitOutcome(params.circuit, 'failure');
    return {
      isTakeable: false,
      externalTakePath: params.externalTakePath,
      selectedLiquiditySource: params.selectedLiquiditySource,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: getErrorMessage(error),
      quoteFailureRetryable: true,
      quoteFailureCode: 'exception',
    };
  }

  const identityMismatch = getCalldataAggregatorQuoteIdentityMismatch({
    label: params.label,
    expectedPath: params.externalTakePath,
    expectedLiquiditySource: params.selectedLiquiditySource,
    evaluation,
  });
  if (identityMismatch) {
    return {
      isTakeable: false,
      externalTakePath: params.externalTakePath,
      selectedLiquiditySource: params.selectedLiquiditySource,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      quoteFailureRetryable: false,
      quoteFailureCode: 'identity_mismatch',
      reason: identityMismatch,
    };
  }

  if (params.circuit.kind === 'record') {
    const outcome = getCircuitGuardedQuoteOutcome(evaluation);
    if (outcome) {
      recordCircuitOutcome(params.circuit, outcome);
    }
  }

  return {
    ...evaluation,
    externalTakePath: params.externalTakePath,
    selectedLiquiditySource: evaluation.selectedLiquiditySource,
    quotedAuctionPriceWad: params.auctionPrice,
    quotedCollateralWad: params.collateral,
  };
}
