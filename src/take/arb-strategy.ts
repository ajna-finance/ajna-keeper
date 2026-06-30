import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { SubgraphReader } from '../read-transports';
import { getErrorMessage, weiToDecimaled } from '../utils';
import { logger } from '../logging';
import { arbTakeLiquidation, checkIfArbTakeable } from './arb';
import { TakeWriteTransport } from './write-transport';
import { ArbTakeEvaluation, TakeActionConfig } from './types';

export interface ArbTakeStrategy<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
> {
  kind: 'arb';
  actionLabel?: string;
  logPrefix?: string;
  isEnabled: (poolConfig: TPoolConfig) => boolean;
  evaluateArbTake: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    subgraph: SubgraphReader;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
    borrower: string;
  }) => Promise<ArbTakeEvaluation>;
  executeArbTake: (params: {
    pool: FungiblePool;
    signer: Signer;
    borrower: string;
    hpbIndex: number;
    dryRun: boolean;
    takeWriteTransport?: TakeWriteTransport;
  }) => Promise<boolean>;
}

export function isArbTakeStrategyEnabled(
  poolConfig: TakeActionConfig
): boolean {
  return (
    poolConfig.take.minCollateral !== undefined &&
    poolConfig.take.hpbPriceFactor !== undefined
  );
}

/**
 * For a self-kicked auction the keeper's own arbTake reward keys off the bucket
 * price vs the auction neutralPrice: a bucketTake above NP penalizes the bond.
 * Resolve the NP ceiling that caps the arb bucket at NP when THIS keeper is the
 * kicker (read on-chain from auctionInfo — kicker + neutralPrice in one call, no
 * side-table), and undefined for auctions kicked by anyone else (no cap — taking
 * above their NP is their risk and our profit). Falls back to undefined
 * (uncapped) when auctionInfo can't be read, preserving liveness.
 */
export async function resolveSelfKickNpCeiling(
  pool: FungiblePool,
  signer: Signer,
  borrower: string
): Promise<number | undefined> {
  try {
    const [botAddress, auctionInfo] = await Promise.all([
      signer.getAddress(),
      pool.contract.auctionInfo(borrower),
    ]);
    if (auctionInfo.kicker_.toLowerCase() !== botAddress.toLowerCase()) {
      return undefined;
    }
    return Number(weiToDecimaled(auctionInfo.neutralPrice_));
  } catch (error) {
    logger.debug(
      `Could not resolve self-kick NP ceiling for ${pool.name}/${borrower}; leaving arbTake uncapped: ${getErrorMessage(error)}`
    );
    return undefined;
  }
}

export function createArbTakeStrategy<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
>(params?: {
  actionLabel?: string;
  logPrefix?: string;
}): ArbTakeStrategy<TPoolConfig> {
  return {
    kind: 'arb',
    actionLabel: params?.actionLabel,
    logPrefix: params?.logPrefix,
    isEnabled: isArbTakeStrategyEnabled,
    evaluateArbTake: async ({
      pool,
      signer,
      poolConfig,
      subgraph,
      price,
      collateral,
      borrower,
    }) => {
      if (!isArbTakeStrategyEnabled(poolConfig)) {
        return {
          isArbTakeable: false,
          hpbIndex: 0,
          reason: 'arbTake settings are not configured',
        };
      }

      const prices = await pool.getPrices();
      const hpb = Number(weiToDecimaled(prices.hpb));
      // Guard hpb=0 (degenerate/empty pool) so minDeposit is never Infinity
      // (which would otherwise be stringified into the subgraph query). An arb
      // take needs a meaningful highest bucket to deposit into; without one,
      // skip explicitly rather than relying on the Infinity floor.
      if (!Number.isFinite(hpb) || hpb <= 0) {
        return {
          isArbTakeable: false,
          hpbIndex: 0,
          reason: 'pool has no highest meaningful bucket (hpb <= 0)',
        };
      }
      const minDeposit = poolConfig.take.minCollateral
        ? poolConfig.take.minCollateral / hpb
        : 0;

      // Cap the arb bucket at NP for auctions this keeper kicked, so its own
      // bucketTake cannot clear above NP and penalize its bond.
      const npCeiling = await resolveSelfKickNpCeiling(pool, signer, borrower);

      return checkIfArbTakeable(
        pool,
        price,
        collateral,
        poolConfig,
        subgraph,
        minDeposit.toString(),
        signer,
        npCeiling
      );
    },
    executeArbTake: async ({
      pool,
      signer,
      borrower,
      hpbIndex,
      dryRun,
      takeWriteTransport,
    }) =>
      arbTakeLiquidation({
        pool,
        signer,
        liquidation: {
          borrower,
          hpbIndex,
        },
        config: {
          dryRun,
          takeWriteTransport,
        },
        actionLabel: params?.actionLabel,
        logPrefix: params?.logPrefix,
      }),
  };
}
