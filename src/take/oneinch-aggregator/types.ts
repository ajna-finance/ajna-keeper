import { TakeWriteTransportConfig } from '../write-transport';
import { CalldataAggregatorQuoteResultNotification } from '../aggregator-calldata/execution';

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
    TakeWriteTransportConfig {
  dryRun?: boolean;
  keeperTakerRouter?: string;
  onOneInchAggregatorQuoteResult?: (
    result: CalldataAggregatorQuoteResultNotification
  ) => void;
  onOneInchAggregatorExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
}
