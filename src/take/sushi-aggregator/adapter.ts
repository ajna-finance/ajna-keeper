import { ExternalTakeAdapter } from '../engine';
import { createCalldataAggregatorTakeAdapter } from '../aggregator-calldata/adapter';
import { TakeActionConfig } from '../types';
import { getSushiAggregatorPathQuoteEvaluation } from './quote-evaluation';
import { takeLiquidationSushiAggregator } from './execution';
import {
  SushiAggregatorExecutionConfig,
  SushiAggregatorQuoteConfig,
} from './types';

export function createSushiAggregatorTakeAdapter(
  quoteConfig: SushiAggregatorQuoteConfig
): ExternalTakeAdapter<TakeActionConfig, SushiAggregatorExecutionConfig> {
  return createCalldataAggregatorTakeAdapter<
    SushiAggregatorExecutionConfig,
    SushiAggregatorQuoteConfig
  >({
    getPathQuoteEvaluation: getSushiAggregatorPathQuoteEvaluation,
    executeTake: takeLiquidationSushiAggregator,
    quoteConfig,
  });
}
