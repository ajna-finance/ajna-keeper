import { CalldataAggregatorExecutionConfigBase } from '../aggregator-calldata/execution';

export interface OneInchAggregatorQuoteConfig {
  connectorTokens?: Array<string>;
  oneInchAggregatorTaker?: string;
  oneInchAggregationExecutorAllowlist?: { [chainId: number]: string[] };
  oneInchDefaultSlippage?: number;
  oneInchRouters?: { [chainId: number]: string };
  oneInchRequestAbortSignal?: AbortSignal;
  oneInchRequestTimeoutMs?: number;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
}

export interface OneInchAggregatorExecutionConfig
  extends OneInchAggregatorQuoteConfig,
    CalldataAggregatorExecutionConfigBase {}
