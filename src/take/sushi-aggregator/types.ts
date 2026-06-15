import { TakeWriteTransportConfig } from '../write-transport';
import { SushiAggregatorDexConfig } from '../../config';

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
  onSushiAggregatorQuoteResult?: (result: {
    success: boolean;
    retryable?: boolean;
    errorCode?: number | string;
    error?: string;
  }) => void;
  onSushiAggregatorExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
}
