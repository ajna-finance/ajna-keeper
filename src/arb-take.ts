import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { getDecimalsErc20 } from './erc20';
import { logger } from './logging';
import { SubgraphReader } from './read-transports';
import { ArbTakeEvaluation, TakeActionConfig } from './take-types';
import { liquidationArbTake } from './transactions';
import { decimaledToWei, weiToDecimaled } from './utils';

interface ArbTakeExecutionParams {
  pool: FungiblePool;
  signer: Signer;
  liquidation: {
    borrower: string;
    hpbIndex: number;
  };
  config: {
    dryRun?: boolean;
  };
  actionLabel?: string;
  logPrefix?: string;
}

export async function checkIfArbTakeable(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  subgraph: SubgraphReader,
  minDeposit: string,
  signer: Signer
): Promise<ArbTakeEvaluation> {
  if (!poolConfig.take.minCollateral || !poolConfig.take.hpbPriceFactor) {
    return {
      isArbTakeable: false,
      hpbIndex: 0,
      reason: 'arbTake settings are not configured',
    };
  }

  const collateralDecimals = await getDecimalsErc20(
    signer,
    pool.collateralAddress
  );
  const minCollateral = ethers.BigNumber.from(
    decimaledToWei(poolConfig.take.minCollateral, collateralDecimals)
  );

  if (collateral.lt(minCollateral)) {
    logger.debug(
      `Collateral ${weiToDecimaled(collateral)} below minCollateral ${poolConfig.take.minCollateral} for pool: ${pool.name}`
    );
    return {
      isArbTakeable: false,
      hpbIndex: 0,
      reason: 'collateral below minCollateral',
    };
  }

  const { buckets } = await subgraph.getHighestMeaningfulBucket(
    pool.poolAddress,
    minDeposit
  );
  if (buckets.length === 0) {
    logger.debug(
      `No meaningful bucket found for pool ${pool.name} (minDeposit: ${minDeposit}), skipping arb take`
    );
    return {
      isArbTakeable: false,
      hpbIndex: 0,
      reason: 'no meaningful bucket found',
    };
  }

  const hmbIndex = buckets[0].bucketIndex;
  const hmbPrice = Number(weiToDecimaled(pool.getBucketByIndex(hmbIndex).price));
  const maxArbPrice = hmbPrice * poolConfig.take.hpbPriceFactor;
  const arbTakeable = price < maxArbPrice;

  logger.info(
    `ArbTake check for pool ${pool.name}: hmbPrice=${hmbPrice.toFixed(6)}, maxArbPrice=${maxArbPrice.toFixed(6)}, auctionPrice=${price.toFixed(6)}, factor=${poolConfig.take.hpbPriceFactor} -> ${arbTakeable ? 'ARB-TAKEABLE' : 'skip'}`
  );

  return {
    isArbTakeable: arbTakeable,
    hpbIndex: hmbIndex,
    maxArbTakePrice: maxArbPrice,
    reason: arbTakeable ? undefined : 'auction price above arbTake threshold',
  };
}

export async function arbTakeLiquidation({
  pool,
  signer,
  liquidation,
  config,
  actionLabel = 'ArbTake',
  logPrefix = '',
}: ArbTakeExecutionParams): Promise<void> {
  const { borrower, hpbIndex } = liquidation;

  if (config.dryRun) {
    logger.info(
      `DryRun - would ${actionLabel} - poolAddress: ${pool.poolAddress}, borrower: ${borrower}`
    );
    return;
  }

  try {
    logger.debug(
      `${logPrefix}Sending ArbTake Tx - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, hpbIndex: ${hpbIndex}`
    );
    const liquidationSdk = pool.getLiquidation(borrower);
    await liquidationArbTake(liquidationSdk, signer, hpbIndex);
    logger.info(
      `${actionLabel} successful - poolAddress: ${pool.poolAddress}, borrower: ${borrower}`
    );
  } catch (error) {
    logger.error(
      `${logPrefix}Failed to ArbTake. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
  }
}
