import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { ExternalTakePathKind, LiquiditySource } from '../config';
import { TakeWriteTransport } from '../take/write-transport';
import { TakeActionConfig, TakeLiquidationPlan } from '../take/types';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from './types';

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

/**
 * A provider owns one external-take path end to end on the execution side:
 * its failure classification, any provider-circuit gating, and dispatch to its
 * execution module. The hybrid executor and the single-path direct adapters
 * both dispatch through these provider instances instead of branching on path
 * identity, so path-specific mechanics (e.g. the LI.FI execution_refresh gate)
 * live behind one boundary rather than being duplicated at each call site.
 *
 * Route quoting/ranking still lives in the discovery quote machinery; this
 * abstraction intentionally covers execution dispatch only.
 */
export interface ExternalTakeRouteProvider<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
> {
  readonly path: ExternalTakePathKind;
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
  onOneInchExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
  onFactoryExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
  onLifiQuoteResult?: (result: {
    success: boolean;
    retryable?: boolean;
    errorCode?: number | string;
    error?: string;
  }) => void;
  onLifiExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
};

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
