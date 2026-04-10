import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { logger } from '../logging';
import { poolSettle } from '../transactions';
import { delay } from '../utils';
import { SettlementReadConfig, SettlementResult } from './model';
import { SettlementActionConfig } from '../settlement-types';

export async function settleAuctionCompletely(params: {
  pool: FungiblePool;
  signer: Signer;
  borrower: string;
  poolConfig: SettlementActionConfig;
  config: SettlementReadConfig;
}): Promise<SettlementResult> {
  const maxIterations = params.poolConfig.settlement.maxIterations || 10;
  const bucketDepth = params.poolConfig.settlement.maxBucketDepth || 50;

  if (params.config.dryRun) {
    logger.info(
      `DRY RUN: Would settle ${params.borrower.slice(0, 8)} in up to ${maxIterations} iterations`
    );
    return {
      success: true,
      completed: true,
      iterations: 1,
      reason: 'Dry run - settlement skipped',
    };
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    try {
      logger.debug(
        `Settlement iteration ${iteration}/${maxIterations} for ${params.borrower.slice(0, 8)}`
      );
      await poolSettle(
        params.pool,
        params.signer,
        params.borrower,
        bucketDepth
      );

      const auctionInfo = await params.pool.contract.auctionInfo(
        params.borrower
      );
      if (auctionInfo.kickTime_.eq(0)) {
        return {
          success: true,
          completed: true,
          iterations: iteration,
          reason: 'Auction fully settled and removed',
        };
      }

      logger.debug(
        `Partial settlement completed, auction still exists - need iteration ${
          iteration + 1
        }`
      );

      if (iteration < maxIterations) {
        await delay(params.config.delayBetweenActions);
      }
    } catch (error) {
      logger.error(
        `Settlement iteration ${iteration} failed for ${params.borrower.slice(0, 8)}:`,
        error
      );
      return {
        success: false,
        completed: false,
        iterations: iteration,
        reason: `Settlement failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return {
    success: true,
    completed: false,
    iterations: maxIterations,
    reason: `Partial settlement after ${maxIterations} iterations - may need more`,
  };
}
