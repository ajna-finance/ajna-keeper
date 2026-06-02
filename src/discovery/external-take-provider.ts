import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { ExternalTakePathKind, LiquiditySource } from '../config';
import { TakeWriteTransport } from '../take/write-transport';
import {
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../take/types';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from './types';

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

/**
 * Result of a single external-take provider execution attempt.
 *
 * `preBroadcastFailed` is true only when the provider proved the take failed
 * before any transport submission (the nonce was not consumed), which is the
 * sole condition under which the hybrid executor may try the next approved
 * fallback path. Once a submission is accepted or maybe-accepted, the execution
 * module reports `preBroadcast: false` and this stays false so no double-submit
 * or fallback occurs.
 *
 * `circuitOpenReason` is set only when a provider short-circuited on an open
 * provider circuit (today: the LI.FI execution_refresh circuit). It lets the
 * direct (non-hybrid) caller emit its distinct "circuit is open" log without the
 * provider needing to know whether it was invoked from the hybrid loop.
 */
export interface ExternalTakeExecutionAttemptResult {
  succeeded: boolean;
  preBroadcastFailed: boolean;
  circuitOpenReason?: string;
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
  // Concrete factory source selected for this candidate. Only the factory
  // provider consumes it (to switch the dynamic direct-DEX adapter); undefined
  // for single-source providers and for the direct factory adapter.
  selectedSource?: LiquiditySource;
}

export type ExternalTakeQuoteIntent =
  | { kind: 'direct' }
  | { kind: 'hybrid_probe'; abortSignal: AbortSignal }
  | { kind: 'hybrid_gas_quote_fallback' };

export interface ExternalTakeQuoteParams<TPoolConfig extends TakeActionConfig> {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TPoolConfig;
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
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
  | 'keeperTaker'
  | 'keeperTakerFactory'
  | 'lifi'
  | 'lifiTaker'
  | 'oneInchAggregationExecutorAllowlist'
  | 'oneInchDefaultSlippage'
  | 'oneInchRouters'
  | 'sushiswapRouterOverrides'
  | 'tokenAddresses'
  | 'uniswapV3RouterOverrides'
> & {
  takeWriteTransport?: TakeWriteTransport;
  runtimeCache?: DiscoveryRpcCache['factoryQuoteProviders'];
  oneInchRequestTimeoutMs?: number;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
  onOneInchSwapDataResult?: (result: {
    success: boolean;
    retryable?: boolean;
    errorCode?: number | string;
    error?: string;
  }) => void;
  onOneInchExecutionFailure?: (
    result: ExternalTakeExecutionFailureResult
  ) => void;
  onFactoryExecutionFailure?: (
    result: ExternalTakeExecutionFailureResult
  ) => void;
  onLifiQuoteResult?: (result: ExternalTakeQuoteResult) => void;
  onLifiExecutionFailure?: (result: ExternalTakeExecutionFailureResult) => void;
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
