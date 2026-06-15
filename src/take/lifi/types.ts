import { TakeWriteTransportConfig } from '../write-transport';
import { LifiDexConfig } from '../../config';
import { CalldataAggregatorQuoteResultNotification } from '../aggregator-calldata/execution';

export interface LifiQuoteConfig {
  lifi?: LifiDexConfig;
  lifiTaker?: string;
  lifiRequestAbortSignal?: AbortSignal;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
}

export interface LifiExecutionConfig
  extends LifiQuoteConfig,
    TakeWriteTransportConfig {
  dryRun?: boolean;
  keeperTakerRouter?: string;
  onLifiQuoteResult?: (
    result: CalldataAggregatorQuoteResultNotification
  ) => void;
  onLifiExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
}
