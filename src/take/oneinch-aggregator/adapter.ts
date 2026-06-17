import { ExternalTakeAdapter } from '../engine';
import { createCalldataAggregatorTakeAdapter } from '../aggregator-calldata/adapter';
import { TakeActionConfig } from '../types';
import { getOneInchAggregatorPathQuoteEvaluation } from './quote-evaluation';
import { takeLiquidationOneInchAggregator } from './execution';
import {
  OneInchAggregatorExecutionConfig,
  OneInchAggregatorQuoteConfig,
} from './types';

export function createOneInchAggregatorTakeAdapter(
  quoteConfig: OneInchAggregatorQuoteConfig
): ExternalTakeAdapter<TakeActionConfig, OneInchAggregatorExecutionConfig> {
  return createCalldataAggregatorTakeAdapter<
    OneInchAggregatorExecutionConfig,
    OneInchAggregatorQuoteConfig
  >({
    getPathQuoteEvaluation: getOneInchAggregatorPathQuoteEvaluation,
    executeTake: takeLiquidationOneInchAggregator,
    quoteConfig,
  });
}
