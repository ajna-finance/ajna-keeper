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

// Hard cap on the dedupe map so sustained truncation or a pathological
// backlog can't grow memory unboundedly. Oldest (by blockTimestamp) entries
// are evicted first; anything evicted would either be filtered by the
// composite cursor on the next cycle (if it's chronologically behind) or
// caught by the lookback window + cap rarely needs to evict in steady state.
const MAX_SEEN_EVENT_IDS = 100_000;

export class LpCollector {
  public lpMap: Map<number, BigNumber> = new Map(); // Map<bucketIndex, rewardLp>

  private signerAddressPromise: Promise<string>;
  // Timestamp cursor advanced to the highest `blockTimestamp` seen so far.
  // Each query subtracts `LP_REWARD_LOOKBACK_SECONDS` from this value so
  // late-indexed events within that window are still re-fetched; dedupe is
  // handled by `seenEventIds`. A pure timestamp cursor is sufficient here —
  // within a single query call, composite (ts, id) pagination in
  // `getBucketTakeLPAwards` handles same-timestamp events deterministically,
  // so we don't need a cross-cycle id cursor.
  private cursorBlockTimestamp: string = '0';
  // Dedupe set scoped to the lookback window. Rejects events re-returned
  // across the overlap so they aren't double-counted.
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

    // Shift the query's timestamp cursor BACK by LP_REWARD_LOOKBACK_SECONDS
    // so late-indexed events that land just below our real cursor are still
    // returned. `seenEventIds` dedupes the overlap.
    const queryTs = subtractSecondsClamped(
      this.cursorBlockTimestamp,
      LP_REWARD_LOOKBACK_SECONDS
    );
    const { bucketTakes } = await this.subgraph.getBucketTakeLPAwards(
      this.pool.poolAddress,
      signerAddress,
      queryTs
    );

    let maxTimestamp = this.cursorBlockTimestamp;
    const observeTimestamp = (ts: string) => {
      if (bigIntStringGreater(ts, maxTimestamp)) maxTimestamp = ts;
    };

    for (const take of bucketTakes) {
      if (this.seenEventIds.has(take.id)) continue;

      // Record the event in the seen set BEFORE any early-return so a
      // persistently malformed record does not get re-parsed on every cycle
      // within the lookback window.
      this.seenEventIds.set(take.id, take.blockTimestamp);
      observeTimestamp(take.blockTimestamp);

      // Defensive: schema marks `taker` and `lpAwarded` non-null, but guard
      // anyway so a schema drift or GraphQL-library glitch can't throw and
      // halt the pool.
      if (!take.taker) {
        logger.warn(
          `BucketTake event missing taker field; skipping. pool: ${this.pool.name}, id: ${take.id}`
        );
        continue;
      }
      if (!take.lpAwarded) {
        logger.warn(
          `BucketTake event missing lpAwarded field; skipping. pool: ${this.pool.name}, id: ${take.id}`
        );
        continue;
      }

      const takerMatches = take.taker.toLowerCase() === signerAddress;
      const kickerMatches =
        take.lpAwarded.kicker.toLowerCase() === signerAddress;

      // Quarantine per-event parse failures: log + skip, leave seen-id in
      // place so we don't re-error every cycle while the record remains
      // malformed.
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
        continue;
      }

      if (takerMatches) {
        this.addRewardParsed(take.index, takerAmount, 'taker');
      }
      if (kickerMatches) {
        this.addRewardParsed(take.index, kickerAmount, 'kicker');
      }
    }

    // ALWAYS advance cursor, even on truncation — the server-side orderBy
    // plus within-call composite pagination means the next cycle's query
    // picks up where this one left off, just later in wall-clock time.
    this.cursorBlockTimestamp = maxTimestamp;

    // Prune and cap seenEventIds. Prune drops entries below the lookback
    // window (safe to forget). Cap evicts older entries if we're still over
    // the memory cap — but never entries inside the active window.
    this.pruneSeenEventIds();
    this.capSeenEventIds();
  }

  private capSeenEventIds(): void {
    if (this.seenEventIds.size <= MAX_SEEN_EVENT_IDS) return;
    // Partition seen ids into those still within the active lookback window
    // (MUST be retained — next cycle's query will re-return them and we need
    // dedupe to fire) and those already past the window (safe to evict).
    const cutoff = subtractSecondsClamped(
      this.cursorBlockTimestamp,
      LP_REWARD_LOOKBACK_SECONDS
    );
    const inWindow: Array<[string, string]> = [];
    const outOfWindow: Array<[string, string]> = [];
    this.seenEventIds.forEach((ts, id) => {
      if (bigIntStringGreater(cutoff, ts)) {
        outOfWindow.push([id, ts]);
      } else {
        inWindow.push([id, ts]);
      }
    });

    if (inWindow.length >= MAX_SEEN_EVENT_IDS) {
      // Window itself exceeds the cap. Refuse to evict from the window —
      // doing so would cause re-fetched events to double-count. Drop the
      // out-of-window tail entirely and log a warning for the operator.
      logger.warn(
        `seenEventIds lookback window (${inWindow.length}) exceeds cap (${MAX_SEEN_EVENT_IDS}); dropping out-of-window entries only. pool: ${this.pool.name}`
      );
      this.seenEventIds = new Map(inWindow);
      return;
    }

    // Sort out-of-window entries newest-first and keep as many as fit under
    // the cap. A stable tie-breaker on id avoids arbitrary eviction at
    // boundary timestamps.
    outOfWindow.sort((a, b) => {
      try {
        const cmp = BigNumber.from(b[1]).sub(BigNumber.from(a[1]));
        if (!cmp.isZero()) return cmp.lt(0) ? -1 : 1;
      } catch {
        /* fall through to id tie-breaker */
      }
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const remaining = MAX_SEEN_EVENT_IDS - inWindow.length;
    this.seenEventIds = new Map([...inWindow, ...outOfWindow.slice(0, remaining)]);
  }

  private pruneSeenEventIds(): void {
    // The next query will pass `(cursorTs - lookback)` as its effective
    // timestamp floor. Events older than that cutoff can never be returned
    // again, so their seen-ids are safe to prune. Keep entries at or above
    // the cutoff so lookback-window re-fetches still dedupe correctly.
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
