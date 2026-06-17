import { SushiAggregatorDexConfig } from '../../config';
import { CalldataAggregatorExecutionConfigBase } from '../aggregator-calldata/execution';

export interface SushiAggregatorQuoteConfig {
  sushiAggregator?: SushiAggregatorDexConfig;
  sushiAggregatorTaker?: string;
  sushiAggregatorRequestAbortSignal?: AbortSignal;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
}

export interface SushiAggregatorExecutionConfig
  extends SushiAggregatorQuoteConfig,
    CalldataAggregatorExecutionConfigBase {}
