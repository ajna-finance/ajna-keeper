import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  CalldataAggregatorProviderId,
  ExternalTakePathKind,
  LiquiditySource,
} from '../../config';
import { TakeWriteTransport } from '../../take/write-transport';
import {
  AuctionTakeFacts,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../../take/types';
import type { ExternalTakeRouteIdentity } from '../../take/external-take/route-binding';
import { HYBRID_GAS_QUOTE_FALLBACK_KIND } from './approval';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from '../types';

export type ExternalTakeQuoteCircuitOutcome = 'success' | 'failure' | 'neutral';

export type ExternalTakeExecutionFailureResult = {
  preBroadcast: boolean;
  error?: string;
};

export type ExternalTakeQuoteResult = {
  success: boolean;
  retryable?: boolean;
  errorCode?: number | string;
  error?: string;
};

export type ExternalTakeRouteQuoteResult = {
  route: ExternalTakeRouteIdentity;
  result: ExternalTakeQuoteResult;
};

export type ExternalTakeRouteExecutionFailureResult = {
  route: ExternalTakeRouteIdentity;
  result: ExternalTakeExecutionFailureResult;
};

/**
 * Result of a single external-take provider execution attempt.
 *
 * `preBroadcastFailed` is true only when the provider proved the take failed
 * before any transport submission (the nonce was not consumed), which is the
 * sole condition under which the hybrid executor may try the next approved
 * fallback path. Once a submission is accepted or maybe-accepted, the execution
 * module reports `preBroadcast: false` and this stays false so no double-submit
 * or fallback occurs.
 */
export interface ExternalTakeExecutionAttemptResult {
  succeeded: boolean;
  preBroadcastFailed: boolean;
}

export interface ExternalTakeExecuteParams<
  TPoolConfig extends TakeActionConfig,
  TExecutionConfig,
> {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TPoolConfig;
  liquidation: TakeLiquidationPlan;
  config: TExecutionConfig;
}

export type ExternalTakeQuoteIntent =
  | { kind: 'direct' }
  | { kind: 'hybrid_probe'; abortSignal: AbortSignal }
  | { kind: typeof HYBRID_GAS_QUOTE_FALLBACK_KIND };

export interface ExternalTakeQuoteParams<TPoolConfig extends TakeActionConfig>
  extends AuctionTakeFacts {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TPoolConfig;
  price: number;
  intent: ExternalTakeQuoteIntent;
}

/**
 * A provider owns one external-take path end to end for discovery: route
 * quoting, quote-circuit accounting, execution dispatch, and execution failure
 * classification. The hybrid executor and single-path direct adapters dispatch
 * through these provider instances instead of rebuilding path-specific logic at
 * each call site.
 */
export interface ExternalTakeRouteProvider<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
> {
  readonly path: ExternalTakePathKind;
  /** Set for calldata-aggregator providers; dispatch is path + provider id. */
  readonly providerId?: CalldataAggregatorProviderId;
  quote(
    params: ExternalTakeQuoteParams<TPoolConfig>
  ): Promise<ExternalTakeQuoteEvaluation>;
  getQuoteCircuitOutcome?(
    evaluation: ExternalTakeQuoteEvaluation
  ): ExternalTakeQuoteCircuitOutcome | undefined;
  recordQuoteCircuitOutcome?(outcome: ExternalTakeQuoteCircuitOutcome): void;
  execute(
    params: ExternalTakeExecuteParams<TPoolConfig, TExecutionConfig>
  ): Promise<ExternalTakeExecutionAttemptResult>;
}

export type DiscoveryExternalExecutionConfig = Pick<
  DiscoveryExecutionConfig,
  | 'connectorTokens'
  | 'curveRouterOverrides'
  | 'dryRun'
  | 'keeperTakerRouter'
  | 'lifi'
  | 'lifiTaker'
  | 'oneInchAggregatorTaker'
  | 'sushiAggregator'
  | 'sushiAggregatorTaker'
  | 'oneInchAggregationExecutorAllowlist'
  | 'oneInchDefaultSlippage'
  | 'oneInchRouters'
  | 'tokenAddresses'
  | 'uniswapV3RouterOverrides'
> & {
  takeWriteTransport?: TakeWriteTransport;
  runtimeCache?: DiscoveryRpcCache['directDexQuoteProviders'];
  oneInchRequestTimeoutMs?: number;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
  onExternalTakeQuoteResult?: (event: ExternalTakeRouteQuoteResult) => void;
  onExternalTakeExecutionFailure?: (
    event: ExternalTakeRouteExecutionFailureResult
  ) => void;
};

export function createPreBroadcastFailureCapture(
  original?: (result: ExternalTakeExecutionFailureResult) => void
): {
  handler(result: ExternalTakeExecutionFailureResult): void;
  didFailPreBroadcast(): boolean;
} {
  let preBroadcastFailed = false;
  return {
    handler: (result) => {
      original?.(result);
      if (result.preBroadcast) {
        preBroadcastFailed = true;
      }
    },
    didFailPreBroadcast: () => preBroadcastFailed,
  };
}

export function createPreSubmitResultCapture<T extends { success: boolean }>(
  original?: (result: T) => void
): {
  handler(result: T): void;
  didRejectBeforeSubmit(): boolean;
} {
  let preSubmitRejected = false;
  let preSubmitSucceeded = false;
  return {
    handler: (result) => {
      original?.(result);
      if (result.success) {
        preSubmitSucceeded = true;
      } else {
        preSubmitRejected = true;
      }
    },
    didRejectBeforeSubmit: () => preSubmitRejected && !preSubmitSucceeded,
  };
}

export function withTakeLiquiditySource<T extends TakeActionConfig>(
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
