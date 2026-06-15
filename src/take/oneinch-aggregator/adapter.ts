import { ExternalTakeAdapter } from '../engine';
import { bindExternalTakeQuoteToExecutionResult } from '../external-take/execution-plan';
import { getDebtConstrainedTakeCollateralWad } from '../take-sizing';
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
  return {
    kind: 'calldata_aggregator',
    evaluateExternalTake: async ({
      pool,
      signer,
      poolConfig,
      candidate,
      price,
      auctionPrice,
      collateral,
      debtToCover,
    }) => {
      const quoteEvaluation = await getOneInchAggregatorPathQuoteEvaluation(
        pool,
        price,
        getDebtConstrainedTakeCollateralWad({
          collateral,
          auctionPrice,
          debtToCover,
        }),
        poolConfig,
        quoteConfig,
        signer,
        auctionPrice
      );
      return bindExternalTakeQuoteToExecutionResult({
        quoteEvaluation,
        poolName: pool.name,
        borrower: candidate.borrower,
      });
    },
    executeExternalTake: async ({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    }) =>
      takeLiquidationOneInchAggregator({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }),
  };
}
