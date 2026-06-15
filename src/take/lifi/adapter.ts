import { ExternalTakeAdapter } from '../engine';
import { createCalldataAggregatorTakeAdapter } from '../aggregator-calldata/adapter';
import { getLifiPathQuoteEvaluation } from './quote-evaluation';
import { takeLiquidationLifi } from './execution';
import { LifiExecutionConfig, LifiQuoteConfig } from './types';
import { TakeActionConfig } from '../types';

export function createLifiTakeAdapter(
  quoteConfig: LifiQuoteConfig
): ExternalTakeAdapter<TakeActionConfig, LifiExecutionConfig> {
  return createCalldataAggregatorTakeAdapter<
    LifiExecutionConfig,
    LifiQuoteConfig
  >({
    getPathQuoteEvaluation: getLifiPathQuoteEvaluation,
    executeTake: takeLiquidationLifi,
    quoteConfig,
  });
}
