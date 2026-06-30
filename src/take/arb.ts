import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { getDecimalsErc20 } from '../erc20';
import { logger } from '../logging';
import { SubgraphReader } from '../read-transports';
import { ArbTakeEvaluation, TakeActionConfig } from './types';
import { liquidationArbTake } from '../transactions';
import { isNonceConsumedTransactionError } from '../nonce';
import { TakeWriteTransport } from './write-transport';
import { decimaledToWei, weiToDecimaled } from '../utils';

interface ArbTakeExecutionParams {
  pool: FungiblePool;
  signer: Signer;
  liquidation: {
    borrower: string;
    hpbIndex: number;
  };
  config: {
    dryRun?: boolean;
    takeWriteTransport?: TakeWriteTransport;
  };
  actionLabel?: string;
  logPrefix?: string;
}

export interface ArbProfitability {
  takeable: boolean;
  maxArbTakePrice: number;
  reason?: string;
}

/**
 * Pure arb-take profitability core (no I/O). Given the auction/take price and
 * the pool's highest-meaningful-bucket price, decides whether an arbTake clears.
 * Shared by the take path (checkIfArbTakeable, which fetches the HMB live) and
 * the kick liveness gate (which batches the HMB per pool), so both agree on
 * exactly which bucket an arbTake would use.
 *
 * Self-penalty avoidance: the keeper's arbTake deposits collateral into the HMB
 * bucket, and a bucketTake is rewarded only if the BUCKET price <= NP
 * (TakerActions._prepareTake feeds bucketPrice into _bpf; isRewarded <=>
 * bucketPrice <= NP — NOT the auction price). So for a self-kicked auction the
 * caller passes npCeiling = neutralPrice and we refuse when hmbPrice > NP: taking
 * into HMB would penalize the keeper's own bond no matter how far the auction
 * has decayed. undefined npCeiling (auctions kicked by others) leaves the arb
 * uncapped, keeping this function ignorant of who kicked.
 */
export function isArbProfitable(params: {
  price: number;
  hmbPrice: number;
  hpbPriceFactor: number;
  npCeiling?: number;
}): ArbProfitability {
  const { price, hmbPrice, hpbPriceFactor, npCeiling } = params;
  const maxArbPrice = hmbPrice * hpbPriceFactor;
  if (npCeiling !== undefined && hmbPrice > npCeiling) {
    return {
      takeable: false,
      maxArbTakePrice: maxArbPrice,
      reason: 'hmb bucket price above neutralPrice',
    };
  }
  const takeable = price < maxArbPrice;
  return {
    takeable,
    maxArbTakePrice: maxArbPrice,
    reason: takeable ? undefined : 'auction price above arbTake threshold',
  };
}

export async function checkIfArbTakeable(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  subgraph: SubgraphReader,
  minDeposit: string,
  signer: Signer,
  // Auction neutralPrice for self-kicked auctions: the arbTake is refused when
  // the HMB bucket price exceeds it (a bucketTake above NP penalizes the
  // kicker's bond). undefined (default) leaves auctions kicked by others uncapped.
  npCeiling?: number
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
  const hmbPrice = Number(
    weiToDecimaled(pool.getBucketByIndex(hmbIndex).price)
  );
  const profitability = isArbProfitable({
    price,
    hmbPrice,
    hpbPriceFactor: poolConfig.take.hpbPriceFactor,
    npCeiling,
  });

  logger.info(
    `ArbTake check for pool ${pool.name}: hmbPrice=${hmbPrice.toFixed(6)}, ` +
      `maxArbPrice=${profitability.maxArbTakePrice.toFixed(6)}, auctionPrice=${price.toFixed(6)}, ` +
      `factor=${poolConfig.take.hpbPriceFactor}` +
      `${npCeiling !== undefined ? `, npCeiling=${npCeiling.toFixed(6)}` : ''} -> ` +
      `${profitability.takeable ? 'ARB-TAKEABLE' : 'skip'}`
  );

  return {
    isArbTakeable: profitability.takeable,
    hpbIndex: hmbIndex,
    maxArbTakePrice: profitability.maxArbTakePrice,
    reason: profitability.reason,
  };
}

export async function arbTakeLiquidation({
  pool,
  signer,
  liquidation,
  config,
  actionLabel = 'ArbTake',
  logPrefix = '',
}: ArbTakeExecutionParams): Promise<boolean> {
  const { borrower, hpbIndex } = liquidation;

  if (config.dryRun) {
    logger.info(
      `DryRun - would ${actionLabel} - poolAddress: ${pool.poolAddress}, borrower: ${borrower}`
    );
    return true;
  }

  try {
    logger.debug(
      `${logPrefix}Sending ArbTake Tx - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, hpbIndex: ${hpbIndex}`
    );
    const liquidationSdk = pool.getLiquidation(borrower);
    await liquidationArbTake(
      liquidationSdk,
      signer,
      hpbIndex,
      config.takeWriteTransport
    );
    logger.info(
      `${actionLabel} successful - poolAddress: ${pool.poolAddress}, borrower: ${borrower}`
    );
    return true;
  } catch (error) {
    logger.error(
      `${logPrefix}Failed to ArbTake. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
    // A nonce-consumed error means the arbTake tx may have broadcast (the nonce
    // was consumed) even though the receipt wait failed. Propagate it so the
    // engine treats it as an attempted submission and invalidates stale auction
    // state, rather than swallowing it as a clean no-op (audit Pass-2 HIGH). The
    // calldata path classifies the same error as preBroadcast=false.
    if (isNonceConsumedTransactionError(error)) {
      throw error;
    }
    return false;
  }
}
