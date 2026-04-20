import { FungiblePool, min, Signer } from '@ajna-finance/sdk';
import { BigNumber, constants, utils } from 'ethers';
import {
  KeeperConfig,
  PoolConfig,
  RewardAction,
  TokenToCollect,
} from '../config';
import { logger } from '../logging';
import { RewardActionTracker } from './action-tracker';
import {
  bucketRemoveCollateralToken,
  bucketRemoveQuoteToken,
} from '../transactions';
import { decimaledToWei, weiToDecimaled } from '../utils';
import { FungibleBucket } from '@ajna-finance/sdk/dist/classes/FungibleBucket';
import { SubgraphReader } from '../read-transports';

/**
 * Collects LP rewarded from BucketTakes without collecting the user's deposits
 * or loans.
 *
 * Uses subgraph-based polling instead of on-chain event listeners. Each
 * `collectLpRewards()` call fetches new `BucketTake` entities (filtered by
 * this signer as taker or kicker) since the last observed `blockTimestamp`,
 * hydrates the in-memory `lpMap`, then sweeps the map to redeem LP.
 *
 * On process start the cursor is `'0'`, so the first ingest replays all
 * historical BucketTake rewards for this (pool, signer). This reclaims
 * unredeemed LP that accrued before a restart. Correctness is bounded by the
 * on-chain `lpBalance` cap in `collectLpRewardFromBucket`, and the
 * zero-balance prune there drops entries whose rewards were already redeemed
 * so the replay is self-cleaning after at most one cycle.
 *
 * Assumes the signer is a dedicated keeper key whose `lpBalance` in each
 * bucket is entirely reward-derived. If the same signer also deposits into
 * these pools, history replay after a restart can redeem principal to
 * satisfy stale reward entries — use a distinct keeper key to avoid this.
 */
// Overlap window subtracted from the cursor before each subgraph query, so
// late-indexed events that land just under the previous cursor boundary are
// still re-seen. Any event already processed is filtered out by the seen-id
// set. Keeps us tolerant of typical Goldsky indexing lag (~5–30s in practice).
export const LP_REWARD_LOOKBACK_SECONDS = 60;

export class LpCollector {
  public lpMap: Map<number, BigNumber> = new Map(); // Map<bucketIndex, rewardLp>

  private signerAddressPromise: Promise<string>;
  // Cross-cycle pagination cursor. Pagination within a single `getBucketTake
  // LPAwards` call uses `id_gt` to advance through pages; this field carries
  // the last ingested id forward so the next cycle continues where pagination
  // stopped (crucial when a single cycle hits the max-pages truncation cap —
  // without a persistent cursor, pagination would restart at '' every cycle
  // and truncated tails would be permanently unreachable).
  private cursorId: string = '';
  // Timestamp cursor used for a small lookback window when querying the
  // subgraph, so late-indexed events below the max-seen timestamp are still
  // returned. Deduped client-side via `seenEventIds`.
  private cursorBlockTimestamp: string = '0';
  // Dedupe set scoped to the lookback window. Only used to reject events
  // re-returned by the lookback overlap; truly-new events (id beyond cursor)
  // cannot collide with entries here because `id_gt` strictly advances.
  private seenEventIds: Map<string, string> = new Map(); // id → blockTimestamp

  constructor(
    private pool: FungiblePool,
    private signer: Signer,
    private poolConfig: Required<Pick<PoolConfig, 'collectLpReward'>>,
    private config: Pick<KeeperConfig, 'dryRun'>,
    private exchangeTracker: RewardActionTracker,
    private subgraph: SubgraphReader
  ) {
    this.signerAddressPromise = this.signer.getAddress();
  }

  public async collectLpRewards() {
    await this.ingestNewAwardsFromSubgraph();

    const lpMapEntries = Array.from(this.lpMap.entries()).filter(
      ([bucketIndex, rewardLp]) => rewardLp.gt(constants.Zero)
    );
    for (let [bucketIndex, rewardLp] of lpMapEntries) {
      const lpConsumed = await this.collectLpRewardFromBucket(
        bucketIndex,
        rewardLp
      );
      this.subtractReward(bucketIndex, lpConsumed);
    }
  }

  // Exposed for tests that want to verify reward tracking independently of
  // the redemption flow. Production callers should use `collectLpRewards`.
  public async ingestNewAwardsFromSubgraph(): Promise<void> {
    const signerAddress = (await this.signerAddressPromise).toLowerCase();

    // Query from `cursorId` forward. Within a single call, pagination uses
    // `id_gt` to advance; across cycles we persist `cursorId` so a truncated
    // cycle continues where it left off instead of restarting at ''.
    // Additionally apply a small `blockTimestamp_gte` lookback so late-indexed
    // events below our boundary are still fetched; `seenEventIds` dedupes
    // those so they don't get double-counted.
    const queryCursor = subtractSecondsClamped(
      this.cursorBlockTimestamp,
      LP_REWARD_LOOKBACK_SECONDS
    );

    const { bucketTakes, truncated } =
      await this.subgraph.getBucketTakeLPAwards(
        this.pool.poolAddress,
        signerAddress,
        queryCursor,
        this.cursorId
      );

    let maxTimestamp = this.cursorBlockTimestamp;
    let maxId = this.cursorId;
    for (const take of bucketTakes) {
      if (this.seenEventIds.has(take.id)) continue;

      const takeIdLower = take.id.toLowerCase();

      // Defensive: schema marks `lpAwarded` non-null, but guard anyway so a
      // schema drift or GraphQL-library glitch can't throw and halt the pool.
      if (!take.lpAwarded) {
        logger.warn(
          `BucketTake event missing lpAwarded field; skipping. pool: ${this.pool.name}, id: ${take.id}`
        );
        if (takeIdLower > maxId) maxId = takeIdLower;
        continue;
      }

      const takerMatches = take.taker.toLowerCase() === signerAddress;
      const kickerMatches =
        take.lpAwarded.kicker.toLowerCase() === signerAddress;

      // Quarantine per-event parse failures: log + skip, still advance cursor.
      // A persistently malformed record would otherwise freeze the pool.
      let takerAmount: BigNumber;
      let kickerAmount: BigNumber;
      try {
        takerAmount = takerMatches
          ? parseBigDecimalToWad(take.lpAwarded.lpAwardedTaker)
          : constants.Zero;
        kickerAmount = kickerMatches
          ? parseBigDecimalToWad(take.lpAwarded.lpAwardedKicker)
          : constants.Zero;
      } catch (error) {
        logger.error(
          `Failed to parse BucketTake reward amounts; skipping event. pool: ${this.pool.name}, id: ${take.id}, taker: ${take.lpAwarded.lpAwardedTaker}, kicker: ${take.lpAwarded.lpAwardedKicker}`,
          error
        );
        if (takeIdLower > maxId) maxId = takeIdLower;
        continue;
      }

      if (takerMatches) {
        this.addRewardParsed(take.index, takerAmount, 'taker');
      }
      if (kickerMatches) {
        this.addRewardParsed(take.index, kickerAmount, 'kicker');
      }

      this.seenEventIds.set(take.id, take.blockTimestamp);
      if (takeIdLower > maxId) maxId = takeIdLower;

      if (bigIntStringGreater(take.blockTimestamp, maxTimestamp)) {
        maxTimestamp = take.blockTimestamp;
      }
    }

    // ALWAYS advance cursors, even on truncation. The id cursor guarantees
    // forward progress across cycles even if a single call hits the pagination
    // cap; on the next cycle we resume from where this one stopped.
    this.cursorId = maxId;
    this.cursorBlockTimestamp = maxTimestamp;

    // Only prune the seen-id dedupe window when the result set was complete.
    // On truncation, skip pruning so the lookback window remains intact for
    // the truncated-tail continuation next cycle.
    if (!truncated) {
      this.pruneSeenEventIds();
    }
  }

  private pruneSeenEventIds(): void {
    // Drop ids whose blockTimestamp is strictly older than (cursor - lookback).
    // We must KEEP ids at exactly the cutoff — the next query uses
    // `blockTimestamp_gte: cutoff` and will re-return them, so dropping the
    // boundary entries would cause them to be treated as new and double-counted.
    const cutoff = subtractSecondsClamped(
      this.cursorBlockTimestamp,
      LP_REWARD_LOOKBACK_SECONDS
    );
    this.seenEventIds.forEach((ts, id) => {
      if (bigIntStringGreater(cutoff, ts)) {
        this.seenEventIds.delete(id);
      }
    });
  }

  /**
   * Collects the lpReward from bucket. Returns amount of lp used.
   */
  private async collectLpRewardFromBucket(
    bucketIndex: number,
    rewardLp: BigNumber
  ): Promise<BigNumber> {
    const {
      redeemFirst,
      minAmountQuote,
      minAmountCollateral,
      rewardActionQuote,
      rewardActionCollateral,
    } = this.poolConfig.collectLpReward;
    const signerAddress = await this.signerAddressPromise;
    const bucket = this.pool.getBucketByIndex(bucketIndex);
    let { deposit, collateral } = await bucket.getStatus();
    const { lpBalance, depositRedeemable, collateralRedeemable } =
      await bucket.getPosition(signerAddress);
    if (lpBalance.lt(rewardLp)) rewardLp = lpBalance;
    // Tracked reward must be stale (already redeemed or never minted) — drop
    // the entry so subsequent cycles don't re-query this bucket.
    if (rewardLp.eq(constants.Zero)) {
      this.lpMap.delete(bucketIndex);
      return constants.Zero;
    }
    let reedemed = constants.Zero;

    if (redeemFirst === TokenToCollect.COLLATERAL) {
      const collateralToWithdraw = min(collateralRedeemable, collateral);
      if (collateralToWithdraw.gt(decimaledToWei(minAmountCollateral))) {
        reedemed = reedemed.add(
          await this.redeemCollateral(
            bucket,
            bucketIndex,
            collateralToWithdraw,
            rewardActionCollateral
          )
        );
        ({ deposit, collateral } = await bucket.getStatus());
      }
      const remainingLp = rewardLp.sub(reedemed);
      if (remainingLp.lte(constants.Zero)) {
        return reedemed;
      }
      const remainingQuote = await bucket.lpToQuoteTokens(remainingLp);
      const quoteToWithdraw = min(remainingQuote, deposit);
      if (quoteToWithdraw.gt(decimaledToWei(minAmountQuote))) {
        reedemed = reedemed.add(
          await this.redeemQuote(bucket, quoteToWithdraw, rewardActionQuote)
        );
      }
    } else {
      const quoteToWithdraw = min(depositRedeemable, deposit);
      if (quoteToWithdraw.gt(decimaledToWei(minAmountQuote))) {
        reedemed = reedemed.add(
          await this.redeemQuote(bucket, quoteToWithdraw, rewardActionQuote)
        );
        ({ deposit, collateral } = await bucket.getStatus());
      }
      const remainingLp = rewardLp.sub(reedemed);
      if (remainingLp.lte(constants.Zero)) {
        return reedemed;
      }
      const remainingCollateral = await bucket.lpToCollateral(remainingLp);
      const collateralToWithdraw = min(remainingCollateral, collateral);
      if (collateralToWithdraw.gt(decimaledToWei(minAmountCollateral))) {
        reedemed = reedemed.add(
          await this.redeemCollateral(
            bucket,
            bucketIndex,
            collateralToWithdraw,
            rewardActionCollateral
          )
        );
      }
    }

    return reedemed;
  }

  private async redeemQuote(
    bucket: FungibleBucket,
    quoteToWithdraw: BigNumber,
    rewardActionQuote?: RewardAction
  ): Promise<BigNumber> {
    if (this.config.dryRun) {
      logger.info(
        `DryRun - Would collect LP reward as ${quoteToWithdraw.toNumber()} quote. pool: ${this.pool.name}`
      );
    } else {
      try {
        logger.debug(`Collecting LP reward as quote. pool: ${this.pool.name}`);

        const signerAddress = await this.signerAddressPromise;
        const { lpBalance: lpBalanceBefore } = await bucket.getPosition(signerAddress);

        await bucketRemoveQuoteToken(bucket, this.signer, quoteToWithdraw);

        const { lpBalance: lpBalanceAfter } = await bucket.getPosition(signerAddress);

        logger.info(
          `Collected LP reward as quote. pool: ${this.pool.name}, amount: ${weiToDecimaled(quoteToWithdraw)}`
        );

        if (rewardActionQuote) {
          this.exchangeTracker.addToken(
            rewardActionQuote,
            this.pool.quoteAddress,
            quoteToWithdraw
          );
        }

        const lpUsed = lpBalanceBefore.sub(lpBalanceAfter);
        if (lpUsed.lt(0)) {
          logger.warn(`Negative LP calculation detected in redeemQuote, using zero instead. Pool: ${this.pool.name}, lpBefore: ${lpBalanceBefore.toString()}, lpAfter: ${lpBalanceAfter.toString()}`);
          return constants.Zero;
        }

        return lpUsed;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('AuctionNotCleared')) {
          logger.debug(`Re-throwing AuctionNotCleared error from ${this.pool.name} to trigger reactive settlement`);
          throw error;
        }

        logger.error(
          `Failed to collect LP reward as quote. pool: ${this.pool.name}`,
          error
        );
      }
    }
    return constants.Zero;
  }

  private async redeemCollateral(
    bucket: FungibleBucket,
    bucketIndex: number,
    collateralToWithdraw: BigNumber,
    rewardActionCollateral?: RewardAction
  ): Promise<BigNumber> {
    if (this.config.dryRun) {
      logger.info(
        `DryRun - Would collect LP reward as ${collateralToWithdraw.toNumber()} collateral. pool: ${this.pool.name}`
      );
    } else {
      try {
        logger.debug(
          `Collecting LP reward as collateral. pool ${this.pool.name}`
        );

        const signerAddress = await this.signerAddressPromise;
        const { lpBalance: lpBalanceBefore } = await bucket.getPosition(signerAddress);

        await bucketRemoveCollateralToken(
          bucket,
          this.signer,
          collateralToWithdraw
        );

        const { lpBalance: lpBalanceAfter } = await bucket.getPosition(signerAddress);

        logger.info(
          `Collected LP reward as collateral. pool: ${this.pool.name}, token: ${this.pool.collateralSymbol}, amount: ${weiToDecimaled(collateralToWithdraw)}`
        );

        if (rewardActionCollateral) {
          this.exchangeTracker.addToken(
            rewardActionCollateral,
            this.pool.collateralAddress,
            collateralToWithdraw
          );
        }

        const lpUsed = lpBalanceBefore.sub(lpBalanceAfter);
        if (lpUsed.lt(0)) {
          logger.warn(`Negative LP calculation detected in redeemCollateral, using zero instead. Pool: ${this.pool.name}, lpBefore: ${lpBalanceBefore.toString()}, lpAfter: ${lpBalanceAfter.toString()}`);
          return constants.Zero;
        }

        return lpUsed;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('AuctionNotCleared')) {
          logger.debug(`Re-throwing AuctionNotCleared error from ${this.pool.name} to trigger reactive settlement`);
          throw error;
        }

        logger.error(`Failed to collect LP reward as collateral. pool: ${this.pool.name}`, error);
      }
    }
    return constants.Zero;
  }

  private addRewardParsed(
    bucketIndex: number,
    rewardLp: BigNumber,
    role: 'taker' | 'kicker'
  ) {
    if (rewardLp.eq(constants.Zero)) return;
    const prevReward = this.lpMap.get(bucketIndex) ?? constants.Zero;
    const sumReward = prevReward.add(rewardLp);
    logger.info(
      `Received LP Rewards in pool: ${this.pool.name}, bucketIndex: ${bucketIndex}, role: ${role}, rewardLp: ${rewardLp}`
    );
    this.lpMap.set(bucketIndex, sumReward);
  }

  private subtractReward(bucketIndex: number, lp: BigNumber) {
    const prevReward = this.lpMap.get(bucketIndex) ?? constants.Zero;
    const newReward = prevReward.sub(lp);
    if (newReward.lte(constants.Zero)) {
      this.lpMap.delete(bucketIndex);
    } else {
      this.lpMap.set(bucketIndex, newReward);
    }
  }
}

// Subgraph serializes BigDecimal reward amounts (18-decimal fixed) as strings
// like "123.456000000000000000". Convert to a WAD-scaled BigNumber. Throws on
// malformed input so the outer ingest loop halts WITHOUT advancing the cursor
// — the reward will be re-fetched on the next cycle rather than silently lost.
export function parseBigDecimalToWad(value: string): BigNumber {
  if (!value || /^-?0(\.0+)?$/.test(value)) {
    return constants.Zero;
  }
  return utils.parseUnits(value, 18);
}

export function bigIntStringGreater(a: string, b: string): boolean {
  try {
    return BigNumber.from(a).gt(BigNumber.from(b));
  } catch (error) {
    logger.warn(
      `Failed to compare blockTimestamps "${a}" vs "${b}" as BigInt; cursor will not advance this iteration`,
      error
    );
    return false;
  }
}

// Returns max(0, cursor - seconds) as a decimal string, matching the BigInt
// timestamp format the subgraph expects. Clamps at zero so a fresh collector
// with cursor='0' still produces a valid BigInt query variable.
export function subtractSecondsClamped(
  cursor: string,
  seconds: number
): string {
  try {
    const cursorBn = BigNumber.from(cursor);
    const shift = BigNumber.from(seconds);
    if (cursorBn.lte(shift)) return '0';
    return cursorBn.sub(shift).toString();
  } catch {
    return '0';
  }
}
