import { ExternalTakeAdapter } from '../engine';
import { bindExternalTakeQuoteToExecutionResult } from '../external-take/execution-plan';
import { getDebtConstrainedTakeCollateralWad } from '../take-sizing';
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
      const quoteEvaluation = await getSushiAggregatorPathQuoteEvaluation(
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
      takeLiquidationSushiAggregator({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }),
  };
}
