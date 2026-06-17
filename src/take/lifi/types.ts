import { LifiDexConfig } from '../../config';
import { CalldataAggregatorExecutionConfigBase } from '../aggregator-calldata/execution';

export interface LifiQuoteConfig {
  lifi?: LifiDexConfig;
  lifiTaker?: string;
  lifiRequestAbortSignal?: AbortSignal;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
}

export interface LifiExecutionConfig
  extends LifiQuoteConfig,
    CalldataAggregatorExecutionConfigBase {}
