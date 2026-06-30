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

// kicker_ and neutralPrice_ are immutable for an auction's whole life, yet the
// take loop re-reads auctionInfo for the same auction every cycle for hours.
// Cache the resolved ceiling per (pool, borrower) and reuse it while the auction
// is unchanged. The ONLY way the values change is settle + re-kick (a new
// auction reusing the same key); collateral is monotonically non-increasing
// within an auction, so a collateral INCREASE is a reliable re-kick signal, and
// a TTL backstop bounds the rare case where the reset is missed between cycles.
const NP_CEILING_TTL_MS = 300_000; // 5 min backstop

interface NpCeilingCacheEntry {
  npCeiling: number | undefined; // number = self-kicked NP cap; undefined = not self-kicked
  collateral: BigNumber; // last-seen auction collateral
  expiresAt: number;
}
const npCeilingCache = new Map<string, NpCeilingCacheEntry>();

/** Test helper: drop the cached self-kick NP ceilings (module-level state). */
export function resetSelfKickNpCeilingCache(): void {
  npCeilingCache.clear();
}

/**
 * For a self-kicked auction the keeper's own arbTake reward keys off the bucket
 * price vs the auction neutralPrice: a bucketTake above NP penalizes the bond.
 * Resolve the NP ceiling that caps the arb bucket at NP when THIS keeper is the
 * kicker (read on-chain from auctionInfo — kicker + neutralPrice in one call, no
 * side-table), and undefined for auctions kicked by anyone else (no cap — taking
 * above their NP is their risk and our profit). Falls back to undefined
 * (uncapped) when auctionInfo can't be read, preserving liveness.
 *
 * `collateral` (the candidate's current collateral) enables a per-auction cache:
 * the immutable result is reused until the collateral increases (settle+re-kick)
 * or the TTL elapses. Omit it to always read fresh.
 */
export async function resolveSelfKickNpCeiling(
  pool: FungiblePool,
  signer: Signer,
  borrower: string,
  collateral?: BigNumber
): Promise<number | undefined> {
  if (collateral !== undefined) {
    const key = `${pool.poolAddress.toLowerCase()}:${borrower.toLowerCase()}`;
    const cached = npCeilingCache.get(key);
    if (
      cached &&
      Date.now() < cached.expiresAt &&
      collateral.lte(cached.collateral)
    ) {
      cached.collateral = collateral; // track the auction's decreasing collateral
      return cached.npCeiling;
    }
  }
  try {
    const [botAddress, auctionInfo] = await Promise.all([
      signer.getAddress(),
      pool.contract.auctionInfo(borrower),
    ]);
    const npCeiling =
      auctionInfo.kicker_.toLowerCase() === botAddress.toLowerCase()
        ? Number(weiToDecimaled(auctionInfo.neutralPrice_))
        : undefined;
    if (collateral !== undefined) {
      const key = `${pool.poolAddress.toLowerCase()}:${borrower.toLowerCase()}`;
      npCeilingCache.set(key, {
        npCeiling,
        collateral,
        expiresAt: Date.now() + NP_CEILING_TTL_MS,
      });
    }
    return npCeiling;
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
      // bucketTake cannot clear above NP and penalize its bond. Pass collateral
      // so the immutable {kicker, NP} is cached per auction (re-read only on a
      // collateral increase = re-kick, or the TTL backstop).
      const npCeiling = await resolveSelfKickNpCeiling(
        pool,
        signer,
        borrower,
        collateral
      );

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
