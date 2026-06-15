import { TakeWriteTransportConfig } from '../write-transport';
import { SushiAggregatorDexConfig } from '../../config';
import { CalldataAggregatorQuoteResultNotification } from '../aggregator-calldata/execution';

export interface SushiAggregatorQuoteConfig {
  sushiAggregator?: SushiAggregatorDexConfig;
  sushiAggregatorTaker?: string;
  sushiAggregatorRequestAbortSignal?: AbortSignal;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
}

export interface SushiAggregatorExecutionConfig
  extends SushiAggregatorQuoteConfig,
    TakeWriteTransportConfig {
  dryRun?: boolean;
  keeperTakerRouter?: string;
  onSushiAggregatorQuoteResult?: (
    result: CalldataAggregatorQuoteResultNotification
  ) => void;
  onSushiAggregatorExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
}
