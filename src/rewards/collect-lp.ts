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
// Default overlap window subtracted from the cursor before each subgraph
// query, so late-indexed events that land just under the previous cursor
// boundary are still re-seen. Any event already processed is filtered out
// by the seen-id set. Fits typical Goldsky lag (~5–30s); operators on slower
// chains can raise via `KeeperConfig.lpRewardLookbackSeconds`.
export const LP_REWARD_LOOKBACK_SECONDS_DEFAULT = 60;

// Advisory threshold for the dedupe set. Memory is hard-bounded by
// `lookbackSeconds × event rate` (entries outside the window are pruned
// each cycle); this threshold is a warning trigger for operators, not an
// enforced cap. Evicting in-window entries would cause re-fetched events
// to double-count, so we never do it.
const MAX_SEEN_EVENT_IDS = 100_000;

// Ajna valid bucket index range is 0..MAX_FENWICK_INDEX inclusive
// (see `@ajna-finance/sdk` constants — there are 7389 buckets total).
const MAX_FENWICK_INDEX = 7388;

export class LpCollector {
  public lpMap: Map<number, BigNumber> = new Map(); // Map<bucketIndex, rewardLp>

  private signerAddressPromise: Promise<string>;
  // Timestamp cursor advanced to the highest `blockTimestamp` seen so far.
  // Each query subtracts `lookbackSeconds` from this value so
  // late-indexed events within that window are still re-fetched; dedupe is
  // handled by `seenEventIds`. A pure timestamp cursor is sufficient here —
  // within a single query call, composite (ts, id) pagination in
  // `getBucketTakeLPAwards` handles same-timestamp events deterministically,
  // so we don't need a cross-cycle id cursor.
  private cursorBlockTimestamp: string = '0';
  // Dedupe set scoped to the lookback window. Rejects events re-returned
  // across the overlap so they aren't double-counted.
  private seenEventIds: Map<string, string> = new Map(); // id → blockTimestamp
  // Effective lookback window, resolved from config with a default fallback.
  private lookbackSeconds: number;

  constructor(
    private pool: FungiblePool,
    private signer: Signer,
    private poolConfig: Required<Pick<PoolConfig, 'collectLpReward'>>,
    private config: Pick<KeeperConfig, 'dryRun' | 'lpRewardLookbackSeconds'>,
    private exchangeTracker: RewardActionTracker,
    private subgraph: SubgraphReader
  ) {
    // Attach a catch so a failed address resolution doesn't become an
    // unhandled rejection at process start (Node ≥15 is strict by default).
    // The same rejection will still surface on every `await` of this promise.
    this.signerAddressPromise = this.signer.getAddress();
    this.signerAddressPromise.catch((err) => {
      logger.error(
        `Failed to resolve signer address for pool ${this.pool.name}`,
        err
      );
    });

    // Defense-in-depth beyond `load.ts` validation: if `lpRewardLookbackSeconds`
    // somehow arrives non-finite (e.g. a caller that bypassed the schema
    // validator), fall back to the default rather than letting NaN/Infinity
    // propagate into BigNumber arithmetic and silently break cursor math.
    const configured = this.config.lpRewardLookbackSeconds;
    this.lookbackSeconds =
      typeof configured === 'number' &&
      Number.isFinite(configured) &&
      Number.isInteger(configured) &&
      configured >= 0
        ? configured
        : LP_REWARD_LOOKBACK_SECONDS_DEFAULT;
  }

  public async collectLpRewards() {
    await this.ingestNewAwardsFromSubgraph();

    const lpMapEntries = Array.from(this.lpMap.entries()).filter(
      ([bucketIndex, rewardLp]) => rewardLp.gt(constants.Zero)
    );
    for (let [bucketIndex, rewardLp] of lpMapEntries) {
      try {
        const lpConsumed = await this.collectLpRewardFromBucket(
          bucketIndex,
          rewardLp
        );
        this.subtractReward(bucketIndex, lpConsumed);
      } catch (error) {
        // AuctionNotCleared is re-thrown up the stack so `run.ts` can trigger
        // reactive settlement. Other per-bucket errors stay contained — a
        // persistently-failing bucket should not starve later buckets in the
        // same cycle. The lpMap entry remains so the next cycle retries.
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('AuctionNotCleared')) {
          throw error;
        }
        logger.error(
          `Failed to collect LP reward from bucket; continuing with remaining buckets. pool: ${this.pool.name}, bucketIndex: ${bucketIndex}`,
          error
        );
      }
    }
  }

  // Exposed for tests that want to verify reward tracking independently of
  // the redemption flow. Production callers should use `collectLpRewards`.
  public async ingestNewAwardsFromSubgraph(): Promise<void> {
    const signerAddress = (await this.signerAddressPromise).toLowerCase();

    // Shift the query's timestamp cursor BACK by `lookbackSeconds` so
    // late-indexed events that land just below our real cursor are still
    // returned. `seenEventIds` dedupes the overlap.
    const queryTs = subtractSecondsClamped(
      this.cursorBlockTimestamp,
      this.lookbackSeconds
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

      // Reject unparseable blockTimestamp up-front — if we record an entry in
      // `seenEventIds` with a junk ts, neither prune nor cap can evict it
      // (both go through `bigIntStringGreater`, which returns false on parse
      // error), and the entry pins the dedupe map permanently. A schema drift
      // or GraphQL-library glitch that produces a non-numeric ts is exactly
      // the case where halting ingest here protects memory bounds.
      try {
        BigNumber.from(take.blockTimestamp);
      } catch {
        logger.warn(
          `BucketTake event has unparseable blockTimestamp; skipping. pool: ${this.pool.name}, id: ${take.id}, ts: ${take.blockTimestamp}`
        );
        continue;
      }

      // Record the event in the seen set BEFORE any early-return so a
      // persistently malformed record does not get re-parsed on every cycle
      // within the lookback window.
      this.seenEventIds.set(take.id, take.blockTimestamp);
      observeTimestamp(take.blockTimestamp);

      // Defensive: schema marks `taker`, `lpAwarded`, and `lpAwarded.kicker`
      // non-null, but guard anyway so a schema drift or GraphQL-library glitch
      // can't throw and halt the pool. `lpAwarded` missing is fatal (no
      // amounts to parse); missing `taker` or `kicker` is non-fatal — we
      // just can't credit that role. If BOTH are missing for our signer we
      // log and move on.
      if (!take.lpAwarded) {
        logger.warn(
          `BucketTake event missing lpAwarded field; skipping. pool: ${this.pool.name}, id: ${take.id}`
        );
        continue;
      }

      const takerMatches =
        !!take.taker && take.taker.toLowerCase() === signerAddress;
      const kickerMatches =
        !!take.lpAwarded.kicker &&
        take.lpAwarded.kicker.toLowerCase() === signerAddress;

      if (!take.taker || !take.lpAwarded.kicker) {
        logger.warn(
          `BucketTake event missing taker/kicker field; continuing best-effort. pool: ${this.pool.name}, id: ${take.id}, takerNull: ${!take.taker}, kickerNull: ${!take.lpAwarded.kicker}`
        );
      }

      // Validate the bucket index before it lands in `lpMap`. Ajna valid
      // bucket indices are 0..MAX_FENWICK_INDEX (7388). An out-of-range
      // value from schema drift would later make `pool.getBucketByIndex`
      // throw every cycle — harmless per-bucket (per-bucket try/catch
      // catches), but a permanent RPC-waste if the entry never clears.
      if (
        !Number.isInteger(take.index) ||
        take.index < 0 ||
        take.index > MAX_FENWICK_INDEX
      ) {
        logger.warn(
          `BucketTake event has out-of-range bucket index; skipping. pool: ${this.pool.name}, id: ${take.id}, index: ${take.index}`
        );
        continue;
      }

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

    // Prune the dedupe set: drops entries below the lookback window (safe to
    // forget — the next query's timestamp floor would filter them anyway).
    // Then check that memory stays bounded.
    this.pruneSeenEventIds();
    this.warnIfSeenEventIdsOverThreshold();
  }

  private warnIfSeenEventIdsOverThreshold(): void {
    // After `pruneSeenEventIds`, the remaining entries are all within the
    // active lookback window and MUST be retained (evicting them would cause
    // re-fetched events to double-count). `MAX_SEEN_EVENT_IDS` is therefore
    // advisory: memory is hard-bounded by `lookbackSeconds × event rate`,
    // and this log lets operators notice pathological pools or oversized
    // lookback windows before they become a problem.
    if (this.seenEventIds.size >= MAX_SEEN_EVENT_IDS) {
      logger.warn(
        `seenEventIds lookback window (${this.seenEventIds.size}) meets or exceeds advisory threshold (${MAX_SEEN_EVENT_IDS}); verify pool event rate vs. lpRewardLookbackSeconds. pool: ${this.pool.name}`
      );
    }
  }

  private pruneSeenEventIds(): void {
    // The next query will pass `(cursorTs - lookback)` as its effective
    // timestamp floor. Events older than that cutoff can never be returned
    // again, so their seen-ids are safe to prune. Keep entries at or above
    // the cutoff so lookback-window re-fetches still dedupe correctly.
    const cutoff = subtractSecondsClamped(
      this.cursorBlockTimestamp,
      this.lookbackSeconds
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
      return constants.Zero;
    }

    const signerAddress = await this.signerAddressPromise;
    let lpBalanceBefore: BigNumber;
    try {
      logger.debug(`Collecting LP reward as quote. pool: ${this.pool.name}`);

      ({ lpBalance: lpBalanceBefore } = await bucket.getPosition(signerAddress));

      await bucketRemoveQuoteToken(bucket, this.signer, quoteToWithdraw);

      // The withdrawal succeeded on-chain, so the quote tokens are now in
      // the signer's wallet. Enqueue the reward action BEFORE the post-read
      // so a read failure can't orphan the withdrawn tokens.
      if (rewardActionQuote) {
        this.exchangeTracker.addToken(
          rewardActionQuote,
          this.pool.quoteAddress,
          quoteToWithdraw
        );
      }

      logger.info(
        `Collected LP reward as quote. pool: ${this.pool.name}, amount: ${weiToDecimaled(quoteToWithdraw)}`
      );
    } catch (error) {
      // Pre-tx or tx-level failure — the withdrawal did NOT happen.
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('AuctionNotCleared')) {
        logger.debug(`Re-throwing AuctionNotCleared error from ${this.pool.name} to trigger reactive settlement`);
        throw error;
      }
      logger.error(
        `Failed to collect LP reward as quote. pool: ${this.pool.name}`,
        error
      );
      return constants.Zero;
    }

    // Post-read is OUTSIDE the try above. The withdrawal already succeeded;
    // we're measuring how much LP it consumed. If this read fails (transient
    // RPC flake), let the error propagate — the per-bucket try/catch in
    // `collectLpRewards` catches it, skips the fallback arm for this bucket
    // so we don't attempt a redundant second tx, and retries next cycle
    // with fresh on-chain state.
    const { lpBalance: lpBalanceAfter } = await bucket.getPosition(signerAddress);
    const lpUsed = lpBalanceBefore.sub(lpBalanceAfter);
    if (lpUsed.lt(0)) {
      logger.warn(`Negative LP calculation detected in redeemQuote, using zero instead. Pool: ${this.pool.name}, lpBefore: ${lpBalanceBefore.toString()}, lpAfter: ${lpBalanceAfter.toString()}`);
      return constants.Zero;
    }
    return lpUsed;
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
      return constants.Zero;
    }

    const signerAddress = await this.signerAddressPromise;
    let lpBalanceBefore: BigNumber;
    try {
      logger.debug(
        `Collecting LP reward as collateral. pool ${this.pool.name}`
      );

      ({ lpBalance: lpBalanceBefore } = await bucket.getPosition(signerAddress));

      await bucketRemoveCollateralToken(
        bucket,
        this.signer,
        collateralToWithdraw
      );

      // Enqueue the reward action BEFORE the post-read so a read failure
      // can't orphan the withdrawn collateral.
      if (rewardActionCollateral) {
        this.exchangeTracker.addToken(
          rewardActionCollateral,
          this.pool.collateralAddress,
          collateralToWithdraw
        );
      }

      logger.info(
        `Collected LP reward as collateral. pool: ${this.pool.name}, token: ${this.pool.collateralSymbol}, amount: ${weiToDecimaled(collateralToWithdraw)}`
      );
    } catch (error) {
      // Pre-tx or tx-level failure — the withdrawal did NOT happen.
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('AuctionNotCleared')) {
        logger.debug(`Re-throwing AuctionNotCleared error from ${this.pool.name} to trigger reactive settlement`);
        throw error;
      }
      logger.error(`Failed to collect LP reward as collateral. pool: ${this.pool.name}`, error);
      return constants.Zero;
    }

    // Post-read is OUTSIDE the try above. Same reasoning as redeemQuote:
    // the withdrawal already succeeded, and a post-read failure should
    // propagate to the per-bucket try/catch in `collectLpRewards` rather
    // than silently returning Zero (which would trigger a redundant
    // fallback withdrawal tx on the other token side).
    const { lpBalance: lpBalanceAfter } = await bucket.getPosition(signerAddress);
    const lpUsed = lpBalanceBefore.sub(lpBalanceAfter);
    if (lpUsed.lt(0)) {
      logger.warn(`Negative LP calculation detected in redeemCollateral, using zero instead. Pool: ${this.pool.name}, lpBefore: ${lpBalanceBefore.toString()}, lpAfter: ${lpBalanceAfter.toString()}`);
      return constants.Zero;
    }
    return lpUsed;
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
// malformed input; the caller in `ingestNewAwardsFromSubgraph` catches the
// throw and quarantines the record (the seen-id + timestamp are recorded
// BEFORE parse, so cursor advance and dedupe both still apply — the bad
// event is dropped forever for this window and NOT retried every cycle).
//
// Rejects negatives explicitly. `utils.parseUnits('-1.5', 18)` returns a
// negative BigNumber, which would otherwise flow into `addRewardParsed`
// (which only short-circuits on `eq(Zero)`) and corrupt `lpMap` via
// subtraction. The Ajna subgraph schema types these as non-negative
// BigDecimal, so a negative string only reaches us on schema drift or a
// subgraph bug — exactly the case this quarantine layer exists to catch.
export function parseBigDecimalToWad(value: string): BigNumber {
  if (!value || /^-?0(\.0+)?$/.test(value)) {
    return constants.Zero;
  }
  if (value.startsWith('-')) {
    throw new Error(`parseBigDecimalToWad rejecting negative value: ${value}`);
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
