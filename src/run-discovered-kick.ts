import { AjnaSDK, FungiblePool, Signer } from '@ajna-finance/sdk';
import { getAutoDiscoverKickPolicy, getManualPools, KeeperConfig } from './config';
import {
  getAddressInsensitiveMapValue,
  getErrorMessage,
  weiToDecimaled,
} from './utils';
import { kick } from './kick';
import { runDiscoveredKickCycle } from './kick-cycle';
import { getPoolPriceFromAlchemy } from './pricing/alchemy';
import {
  assertFinitePositivePrice,
  PriceUnavailableError,
} from './pricing/price-guard';
import { logger } from './logging';
import {
  ensurePoolLoaded,
  PoolHydrationCooldowns,
  PoolMap,
} from './discovery/targets';
import { SubgraphReader } from './read-transports';

/**
 * Price of the pool's highest-meaningful bucket (deposit >= minDeposit), the
 * bucket the keeper's arbTake would clear into. Undefined when the pool has no
 * such bucket or the subgraph read fails (the liveness gate then skips the loan
 * as `no-meaningful-bucket` rather than kicking blind).
 */
async function resolveHmbPrice(
  pool: FungiblePool,
  subgraph: Pick<SubgraphReader, 'getHighestMeaningfulBucket'>,
  poolAddress: string,
  minCollateral: number,
  hpbDecimaled: number
): Promise<number | undefined> {
  if (hpbDecimaled <= 0) {
    return undefined;
  }
  try {
    const minDeposit = String(minCollateral / hpbDecimaled);
    const { buckets } = await subgraph.getHighestMeaningfulBucket(
      poolAddress,
      minDeposit
    );
    if (buckets.length === 0) {
      return undefined;
    }
    return Number(
      weiToDecimaled(pool.getBucketByIndex(buckets[0].bucketIndex).price)
    );
  } catch (error) {
    logger.debug(
      `Could not resolve HMB for discovered kick pool ${poolAddress}: ${getErrorMessage(error)}`
    );
    return undefined;
  }
}

/**
 * The daemon's chain-wide discovered-kick step (Option 1): build the real
 * hydration + submit deps and run them through the shared kick cycle. Kept out
 * of run.ts so the daemon loop stays a thin dispatcher and this wiring lives
 * next to the cycle it feeds. Loader deps (ajna, hydrationCooldowns) are only
 * supplied by the daemon launcher, so callers gate on them before calling.
 */
export async function runDiscoveredKickStep({
  ajna,
  poolMap,
  config,
  signer,
  chainId,
  subgraph,
  hydrationCooldowns,
}: {
  ajna: AjnaSDK;
  poolMap: PoolMap;
  config: KeeperConfig;
  signer: Signer;
  chainId?: number;
  subgraph: SubgraphReader;
  hydrationCooldowns: PoolHydrationCooldowns;
}): Promise<void> {
  const kickPolicy = getAutoDiscoverKickPolicy(config.discovery);
  const kickDefaults = config.discovery?.defaults?.kick;
  const takeDefaults = config.discovery?.defaults?.take ?? {};
  if (!kickPolicy || !kickDefaults || kickDefaults.enabled !== true) {
    return;
  }

  const signerAddress = await signer.getAddress();
  const rpcUrl = config.network.rpcUrl;
  // Discovered pools post real bond, so default to dry-run until the operator
  // clears dryRunNewPools (and global dryRun).
  const discoveredDryRun =
    config.runtime.dryRun || (config.discovery?.dryRunNewPools ?? false);
  // Manual-wins dedup: pools the keeper is configured for are handled by the
  // manual loop; the discovered cycle covers only the rest.
  const manualPools = new Set(
    getManualPools(config).map((pool) => pool.address.toLowerCase())
  );

  const report = await runDiscoveredKickCycle({
    subgraph,
    kickPolicy,
    kickDefaults: {
      minDebt: kickDefaults.minDebt,
      priceFactor: kickDefaults.priceFactor,
    },
    takeDefaults: { hpbPriceFactor: takeDefaults.hpbPriceFactor },
    hydratePool: async (poolAddress) => {
      if (manualPools.has(poolAddress.toLowerCase())) {
        return undefined; // manual-wins dedup
      }
      const pool = await ensurePoolLoaded({
        ajna,
        poolMap,
        poolAddress,
        config,
        hydrationCooldowns,
      });
      if (!pool) {
        return undefined;
      }
      const [prices, kickerInfo] = await Promise.all([
        pool.getPrices(),
        pool.kickerInfo(signerAddress),
      ]);
      const hmbPrice =
        takeDefaults.minCollateral !== undefined
          ? await resolveHmbPrice(
              pool,
              subgraph,
              poolAddress,
              takeDefaults.minCollateral,
              weiToDecimaled(prices.hpb)
            )
          : undefined;
      return {
        poolAddress,
        lup: prices.lup,
        hpb: prices.hpb,
        hmbPrice,
        lockedBondQuote: weiToDecimaled(kickerInfo.locked),
      };
    },
    hydrateLoan: async (pool, borrower) => {
      const fungiblePool = getAddressInsensitiveMapValue(
        poolMap,
        pool.poolAddress
      );
      if (!fungiblePool || chainId === undefined) {
        return undefined;
      }
      const loanDetails = await fungiblePool.getLoan(borrower);
      let marketPrice: number;
      try {
        marketPrice = assertFinitePositivePrice(
          await getPoolPriceFromAlchemy(
            fungiblePool.quoteAddress,
            fungiblePool.collateralAddress,
            chainId,
            rpcUrl
          ),
          `discovered kick pool ${pool.poolAddress}`
        );
      } catch (error) {
        logger.debug(
          `Skipping discovered kick (no market price) for ${pool.poolAddress}/${borrower}: ${
            error instanceof PriceUnavailableError
              ? error.message
              : getErrorMessage(error)
          }`
        );
        return undefined;
      }
      return {
        thresholdPrice: loanDetails.thresholdPrice,
        debt: loanDetails.debt,
        neutralPrice: loanDetails.neutralPrice,
        liquidationBond: loanDetails.liquidationBond,
        marketPrice,
      };
    },
    kickLoan: async (pool, borrower, liquidationBond, marginPrice) => {
      const fungiblePool = getAddressInsensitiveMapValue(
        poolMap,
        pool.poolAddress
      );
      if (!fungiblePool) {
        // Unreachable: hydratePool loaded the pool into poolMap before any of
        // its loans reach kickLoan. Fail loud rather than silently no-op.
        throw new Error(
          `Discovered kick: pool ${pool.poolAddress} is not loaded`
        );
      }
      await kick({
        signer,
        pool: fungiblePool,
        config: { dryRun: discoveredDryRun },
        loanToKick: {
          borrower,
          liquidationBond,
          estimatedRemainingBond: liquidationBond,
          limitPrice: marginPrice,
        },
      });
    },
  });
  logger.info(
    `Discovered kick cycle done (dryRun=${discoveredDryRun}): kicked ${report.kicked}, ` +
      `${report.candidatesConsidered} candidates across ${report.poolsConsidered} pools`
  );
}
