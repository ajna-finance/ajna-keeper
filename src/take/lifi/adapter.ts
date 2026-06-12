import { ExternalTakeAdapter } from '../engine';
import { bindExternalTakeQuoteToExecutionResult } from '../external-take/execution-plan';
import { getLifiPathQuoteEvaluation, takeLiquidationLifi } from './execution';
import { LifiExecutionConfig, LifiQuoteConfig } from './types';
import { getDebtConstrainedTakeCollateralWad } from '../take-sizing';
import { TakeActionConfig } from '../types';

export function createLifiTakeAdapter(
  quoteConfig: LifiQuoteConfig
): ExternalTakeAdapter<TakeActionConfig, LifiExecutionConfig> {
  return {
    kind: 'lifi',
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
      const quoteEvaluation = await getLifiPathQuoteEvaluation(
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
        configuredLiquiditySource: poolConfig.take.liquiditySource,
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
      takeLiquidationLifi({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }),
  };
}
