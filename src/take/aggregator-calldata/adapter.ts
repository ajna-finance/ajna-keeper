import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { ExternalTakeAdapter } from '../engine';
import { bindExternalTakeQuoteToExecutionResult } from '../external-take/execution-plan';
import { getDebtConstrainedTakeCollateralWad } from '../take-sizing';
import {
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';

/**
 * Provider-neutral calldata-aggregator take adapter. The three provider
 * adapters (LI.FI, Sushi, 1inch) are structurally identical apart from their
 * path-quote evaluation function, execution function, and type arguments; this
 * factory captures that shared shape so each provider wrapper only supplies the
 * provider-specific descriptor.
 */
export function createCalldataAggregatorTakeAdapter<
  TExecutionConfig,
  TQuoteConfig,
>(descriptor: {
  getPathQuoteEvaluation: (
    pool: FungiblePool,
    price: number,
    collateralWad: BigNumber,
    poolConfig: TakeActionConfig,
    quoteConfig: TQuoteConfig,
    signer: Signer,
    auctionPrice?: BigNumber
  ) => Promise<ExternalTakeQuoteEvaluation>;
  executeTake: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TakeActionConfig;
    liquidation: TakeLiquidationPlan;
    config: TExecutionConfig;
  }) => Promise<boolean>;
  quoteConfig: TQuoteConfig;
}): ExternalTakeAdapter<TakeActionConfig, TExecutionConfig> {
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
      const quoteEvaluation = await descriptor.getPathQuoteEvaluation(
        pool,
        price,
        getDebtConstrainedTakeCollateralWad({
          collateral,
          auctionPrice,
          debtToCover,
        }),
        poolConfig,
        descriptor.quoteConfig,
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
      descriptor.executeTake({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }),
  };
}
