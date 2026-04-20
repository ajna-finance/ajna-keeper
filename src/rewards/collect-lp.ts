import { FungiblePool, min, Signer } from '@ajna-finance/sdk';
import { MAX_FENWICK_INDEX } from '../constants';
import { BigNumber, constants, utils } from 'ethers';
import {
  CollectLpRewardSettings,
  isValidLookbackSeconds,
  KeeperConfig,
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
import { BucketTakeLPAwardItem } from '../subgraph';
import { SubgraphReader } from '../read-transports';
import { normalizeAddress } from '../discovery/targets';

/**
 * LP-reward collection via subgraph polling.
 *
 * Architecture: one chain-wide `LpIngester` fetches all `BucketTake` events
 * where the signer was taker or kicker across every Ajna pool, then
 * dispatches the parsed rewards to per-pool `LpRedeemer` instances. An
 * `LpManager` orchestrates ingest + dispatch + sweep and materializes
 * redeemers on-demand as new pool addresses surface in subgraph events.
 *
 * Chain-wide scope means auto-discovered pools are covered automatically:
 * if the signer takes on a pool that isn't in the static config,
 * `LpManager` still redeems the resulting LP (using the configured
 * `defaultLpReward` settings).
 *
 * Cold-start correctness: on process start the ingest cursor is `'0'`, so
 * the first ingest replays all historical BucketTake rewards for the
 * signer. Correctness is bounded by the on-chain `lpBalance` cap in each
 * `LpRedeemer.sweep`; the zero-balance prune drops entries whose rewards
 * were already redeemed before the restart.
 *
 * Assumes the signer is a dedicated keeper key whose on-chain `lpBalance`
 * in each bucket is entirely reward-derived. If the same signer also
 * deposits into these pools, history replay after restart can redeem
 * principal — use a distinct keeper key to avoid this.
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

// Threshold for the per-cycle quarantine alarm. A one-off bad record is
// expected (operator already sees the ERROR log); a full cycle of parse
// failures is pathological and should surface its own aggregate signal.
const QUARANTINE_ALARM_THRESHOLD = 5;

/**
 * Kick off `signer.getAddress()` at construction time and attach a no-op
 * logging catch so a rejection doesn't become an unhandled rejection at
 * process start (Node ≥15 is strict by default). The same rejection still
 * surfaces on every subsequent `await` of the returned promise.
 */
function resolveSignerAddressWithLoggingCatch(
  signer: Signer,
  contextLabel: string
): Promise<string> {
  const promise = signer.getAddress();
  promise.catch((err) => {
    logger.error(`Failed to resolve signer address for ${contextLabel}`, err);
  });
  return promise;
}

/**
 * One parsed BucketTake reward destined for a specific pool's redeemer.
 * Role-specific amounts are pre-computed here so the redeemer doesn't need
 * to re-parse.
 */
export interface ParsedLpReward {
  poolAddress: string; // lowercased
  bucketIndex: number;
  takerAmount: BigNumber;
  kickerAmount: BigNumber;
}

/**
 * Chain-wide ingester: owns the cursor, dedupe set, and subgraph query.
 * Returns parsed rewards grouped by pool address so the caller can
 * dispatch them to per-pool redeemers.
 */
export class LpIngester {
  private signerAddressPromise: Promise<string>;
  // Timestamp cursor advanced to the highest `blockTimestamp` seen so far.
  // Each query subtracts `lookbackSeconds` from this value so late-indexed
  // events within that window are still re-fetched; dedupe is handled by
  // `seenEventIds`. A pure timestamp cursor is sufficient here — within a
  // single query call, composite (ts, id) pagination in
  // `getBucketTakeLPAwards` handles same-timestamp events deterministically,
  // so we don't need a cross-cycle id cursor.
  private cursorBlockTimestamp: string = '0';
  // Dedupe set scoped to the lookback window. Rejects events re-returned
  // across the overlap so they aren't double-counted.
  private seenEventIds: Map<string, string> = new Map(); // id → blockTimestamp
  // Effective lookback window, resolved from config with a default fallback.
  private lookbackSeconds: number;
  // Rising-edge latch on the advisory dedupe-threshold warn.
  private seenEventIdsOverThreshold: boolean = false;

  constructor(
    private signer: Signer,
    private subgraph: SubgraphReader,
    config: Pick<KeeperConfig, 'lpRewardLookbackSeconds'>
  ) {
    this.signerAddressPromise = resolveSignerAddressWithLoggingCatch(
      this.signer,
      'LP ingester'
    );

    // Defense-in-depth beyond `load.ts` validation: if `lpRewardLookbackSeconds`
    // somehow arrives non-finite (e.g. a caller that bypassed the schema
    // validator), fall back to the default rather than letting NaN/Infinity
    // propagate into BigNumber arithmetic and silently break cursor math.
    this.lookbackSeconds = isValidLookbackSeconds(config.lpRewardLookbackSeconds)
      ? config.lpRewardLookbackSeconds
      : LP_REWARD_LOOKBACK_SECONDS_DEFAULT;
  }

  /**
   * Fetch new BucketTake events for this signer across every pool, apply
   * all defensive parsing / quarantine / index-range checks, and return
   * the accepted rewards grouped by pool address.
   */
  public async ingest(): Promise<Map<string, ParsedLpReward[]>> {
    const signerAddress = normalizeAddress(await this.signerAddressPromise);

    // Shift the query's timestamp cursor BACK by `lookbackSeconds` so
    // late-indexed events that land just below our real cursor are still
    // returned. `seenEventIds` dedupes the overlap.
    const queryTs = subtractSecondsClamped(
      this.cursorBlockTimestamp,
      this.lookbackSeconds
    );
    const { bucketTakes } = await this.subgraph.getBucketTakeLPAwards(
      signerAddress,
      queryTs
    );

    let maxTimestamp = this.cursorBlockTimestamp;
    const observeTimestamp = (ts: string) => {
      if (bigIntStringGreater(ts, maxTimestamp)) maxTimestamp = ts;
    };

    // Count per-event parse-failure quarantines and surface a single WARN at
    // end-of-cycle if the rate is suspicious. A one-off bad record is benign
    // (already logged at ERROR); a whole cycle's worth suggests schema drift
    // that's silently draining rewards while the cursor still advances.
    let quarantineCount = 0;

    const byPool: Map<string, ParsedLpReward[]> = new Map();
    const push = (poolAddress: string, reward: ParsedLpReward) => {
      const existing = byPool.get(poolAddress);
      if (existing) existing.push(reward);
      else byPool.set(poolAddress, [reward]);
    };

    for (const take of bucketTakes) {
      if (this.seenEventIds.has(take.id)) continue;

      // Reject unparseable blockTimestamp up-front — if we record an entry
      // in `seenEventIds` with a junk ts, neither prune nor cap can evict
      // it (both go through `bigIntStringGreater`, which returns false on
      // parse error), and the entry pins the dedupe map permanently. A
      // schema drift or GraphQL-library glitch that produces a non-numeric
      // ts is exactly the case where halting ingest here protects memory
      // bounds.
      try {
        BigNumber.from(take.blockTimestamp);
      } catch {
        logger.warn(
          `BucketTake event has unparseable blockTimestamp; skipping. id: ${take.id}, ts: ${take.blockTimestamp}`
        );
        continue;
      }

      // Record the event in the seen set BEFORE any early-return so a
      // persistently malformed record does not get re-parsed on every cycle
      // within the lookback window.
      this.seenEventIds.set(take.id, take.blockTimestamp);
      observeTimestamp(take.blockTimestamp);

      if (!take.pool?.id) {
        logger.warn(
          `BucketTake event missing pool.id field; skipping. id: ${take.id}`
        );
        continue;
      }
      const poolAddress = normalizeAddress(take.pool.id);

      // Defensive: schema marks `taker`, `lpAwarded`, and `lpAwarded.kicker`
      // non-null, but guard anyway so a schema drift or GraphQL-library glitch
      // can't throw and halt ingest. `lpAwarded` missing is fatal (no amounts
      // to parse); missing `taker` or `kicker` is non-fatal — we just can't
      // credit that role.
      if (!take.lpAwarded) {
        logger.warn(
          `BucketTake event missing lpAwarded field; skipping. pool: ${poolAddress}, id: ${take.id}`
        );
        continue;
      }

      const takerMatches =
        !!take.taker && normalizeAddress(take.taker) === signerAddress;
      const kickerMatches =
        !!take.lpAwarded.kicker &&
        normalizeAddress(take.lpAwarded.kicker) === signerAddress;

      if (!take.taker || !take.lpAwarded.kicker) {
        logger.warn(
          `BucketTake event missing taker/kicker field; continuing best-effort. pool: ${poolAddress}, id: ${take.id}, takerNull: ${!take.taker}, kickerNull: ${!take.lpAwarded.kicker}`
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
          `BucketTake event has out-of-range bucket index; skipping. pool: ${poolAddress}, id: ${take.id}, index: ${take.index}`
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
          `Failed to parse BucketTake reward amounts; skipping event. pool: ${poolAddress}, id: ${take.id}, taker: ${take.lpAwarded.lpAwardedTaker}, kicker: ${take.lpAwarded.lpAwardedKicker}`,
          error
        );
        quarantineCount++;
        continue;
      }

      if (!takerMatches && !kickerMatches) {
        // Subgraph filter should have excluded this, but guard anyway.
        continue;
      }

      push(poolAddress, {
        poolAddress,
        bucketIndex: take.index,
        takerAmount,
        kickerAmount,
      });
    }

    if (quarantineCount >= QUARANTINE_ALARM_THRESHOLD) {
      logger.warn(
        `Quarantined ${quarantineCount} BucketTake event(s) in a single ingest cycle; rewards are silently dropping. Likely schema drift in lpAwardedTaker/lpAwardedKicker — investigate before the cursor rolls past the lookback window.`
      );
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

    return byPool;
  }

  // Exposed for tests / diagnostics.
  public getCursorBlockTimestamp(): string {
    return this.cursorBlockTimestamp;
  }
  public getSeenEventIdsSize(): number {
    return this.seenEventIds.size;
  }

  private warnIfSeenEventIdsOverThreshold(): void {
    // After `pruneSeenEventIds`, the remaining entries are all within the
    // active lookback window and MUST be retained (evicting them would
    // cause re-fetched events to double-count). `MAX_SEEN_EVENT_IDS` is
    // therefore advisory: memory is hard-bounded by
    // `lookbackSeconds × event rate`, and this log lets operators notice
    // pathological pools or oversized lookback windows before they become
    // a problem. Fire only on the rising edge to avoid log spam.
    const overThresholdNow = this.seenEventIds.size >= MAX_SEEN_EVENT_IDS;
    if (overThresholdNow && !this.seenEventIdsOverThreshold) {
      logger.warn(
        `seenEventIds lookback window (${this.seenEventIds.size}) meets or exceeds advisory threshold (${MAX_SEEN_EVENT_IDS}); verify signer activity vs. lpRewardLookbackSeconds.`
      );
    }
    this.seenEventIdsOverThreshold = overThresholdNow;
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
}

/**
 * Per-pool redemption state. Owns the lpMap for one pool and the
 * settings/handle needed to sweep it. Constructed lazily by `LpManager`
 * on first event arrival for the pool.
 */
export class LpRedeemer {
  public lpMap: Map<number, BigNumber> = new Map(); // bucketIndex → rewardLp

  private signerAddressPromise: Promise<string>;

  constructor(
    public readonly pool: FungiblePool,
    private signer: Signer,
    private settings: CollectLpRewardSettings,
    private config: Pick<KeeperConfig, 'dryRun'>,
    private exchangeTracker: RewardActionTracker
  ) {
    this.signerAddressPromise = resolveSignerAddressWithLoggingCatch(
      this.signer,
      `pool ${this.pool.name}`
    );
  }

  /** Credit an ingested reward for this pool into the lpMap. */
  public creditReward(reward: ParsedLpReward): void {
    if (!reward.takerAmount.eq(constants.Zero)) {
      this.addRewardParsed(reward.bucketIndex, reward.takerAmount, 'taker');
    }
    if (!reward.kickerAmount.eq(constants.Zero)) {
      this.addRewardParsed(reward.bucketIndex, reward.kickerAmount, 'kicker');
    }
  }

  /**
   * Sweep every non-zero entry in the lpMap, redeeming the corresponding
   * quote and/or collateral on-chain. AuctionNotCleared re-throws to the
   * caller so reactive settlement can run; other per-bucket errors stay
   * contained.
   */
  public async sweep(): Promise<void> {
    const lpMapEntries = Array.from(this.lpMap.entries()).filter(
      ([, rewardLp]) => rewardLp.gt(constants.Zero)
    );
    for (let [bucketIndex, rewardLp] of lpMapEntries) {
      try {
        const lpConsumed = await this.collectLpRewardFromBucket(
          bucketIndex,
          rewardLp
        );
        this.subtractReward(bucketIndex, lpConsumed);
      } catch (error) {
        // AuctionNotCleared is re-thrown so `run.ts` can trigger reactive
        // settlement. Other per-bucket errors stay contained — a
        // persistently-failing bucket should not starve later buckets in
        // the same cycle. The lpMap entry remains so the next cycle retries.
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
    } = this.settings;
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
    // `sweep` catches it, skips the fallback arm for this bucket so we
    // don't attempt a redundant second tx, and retries next cycle with
    // fresh on-chain state.
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
    // propagate to the per-bucket try/catch in `sweep` rather than silently
    // returning Zero (which would trigger a redundant fallback withdrawal
    // tx on the other token side).
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

/**
 * Resolves a pool address from a subgraph event to either an existing
 * LpRedeemer (cached) or a newly-materialized one (hydrating the
 * FungiblePool handle on-demand). Returns undefined if the pool cannot be
 * hydrated (e.g. ERC721 pool the factory can't construct, or hydration in
 * cooldown).
 */
export type LpRedeemerResolver = (
  poolAddress: string
) => Promise<LpRedeemer | undefined>;

/**
 * Orchestrates ingest → dispatch. Sweep is the caller's responsibility so
 * per-pool error handling (AuctionNotCleared → reactive settlement → retry)
 * can live at the callsite with proper pool context.
 */
export class LpManager {
  constructor(
    private ingester: LpIngester,
    private resolveRedeemer: LpRedeemerResolver
  ) {}

  /**
   * Fetch new events chain-wide, credit each to the appropriate per-pool
   * redeemer (hydrating the handle on-demand), and return the redeemers
   * that have non-zero `lpMap` entries ready to sweep.
   *
   * Pools that fail to hydrate (ERC721, deployment mismatch, cooldown) are
   * skipped silently — the rewards stay safe on-chain and a later cycle
   * can pick them up once the pool becomes hydratable. Skipping here
   * doesn't corrupt cursor state: the ingester has already advanced past
   * these events and recorded them in `seenEventIds`.
   */
  public async ingestAndDispatch(): Promise<LpRedeemer[]> {
    const byPool = await this.ingester.ingest();
    const touched: LpRedeemer[] = [];

    for (const [poolAddress, rewards] of Array.from(byPool.entries())) {
      const redeemer = await this.resolveRedeemer(poolAddress);
      if (!redeemer) continue;
      for (const reward of rewards) redeemer.creditReward(reward);
      touched.push(redeemer);
    }

    return touched;
  }

  /** Exposed for tests / diagnostics. */
  public getIngester(): LpIngester {
    return this.ingester;
  }
}

// Subgraph serializes BigDecimal reward amounts (18-decimal fixed) as strings
// like "123.456000000000000000". Convert to a WAD-scaled BigNumber. Throws on
// malformed input; the caller in `LpIngester.ingest` catches the throw and
// quarantines the record (the seen-id + timestamp are recorded BEFORE parse,
// so cursor advance and dedupe both still apply — the bad event is dropped
// forever for this window and NOT retried every cycle).
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
// timestamp format the subgraph expects. Clamps at zero so a fresh ingester
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
  } catch (error) {
    // Defense-in-depth for a corrupted cursor or a non-finite `seconds` that
    // escaped upstream validation. Returning '0' triggers a full historical
    // replay which is SAFE (dedupe catches re-ingested events), but silent
    // replay hides the root cause; log so an operator can track it down.
    logger.warn(
      `subtractSecondsClamped failed to parse (cursor=${JSON.stringify(cursor)}, seconds=${seconds}); returning '0' and forcing replay.`,
      error
    );
    return '0';
  }
}
