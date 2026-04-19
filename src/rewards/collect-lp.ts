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
 * Collects lp rewarded from BucketTakes without collecting the user's deposits or loans.
 *
 * Uses subgraph-based polling instead of on-chain event listeners. Each
 * `collectLpRewards()` call fetches new `BucketTake` entities (filtered by this
 * signer as taker or kicker) since the last observed block timestamp, hydrates
 * the in-memory `lpMap`, then sweeps the map to redeem LP. Matches the prior
 * event-listener semantics (starts with an empty map on process startup; does
 * not replay history) while eliminating ethers v5 event-listener polling.
 */
export class LpCollector {
  public lpMap: Map<number, BigNumber> = new Map(); // Map<bucketIndex, rewardLp>

  private signerAddressPromise: Promise<string>;
  private cursorBlockTimestamp: string = '0';

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

    // Cursor starts at '0' so the first cycle replays all historical
    // BucketTakes for this (pool, signer) from the subgraph. This reclaims
    // unredeemed LP rewards that accrued before a restart. Correctness is
    // bounded by `collectLpRewardFromBucket`'s on-chain `lpBalance` cap, and
    // the zero-balance prune in the same method drops entries whose rewards
    // were already redeemed (lpBalance=0), so the replay is self-cleaning
    // after at most one cycle.
    const { bucketTakes } = await this.subgraph.getBucketTakeLPAwards(
      this.pool.poolAddress,
      signerAddress,
      this.cursorBlockTimestamp
    );

    let maxTimestamp = this.cursorBlockTimestamp;
    for (const take of bucketTakes) {
      const takerMatches = take.taker.toLowerCase() === signerAddress;
      const kickerMatches =
        take.lpAwarded.kicker.toLowerCase() === signerAddress;

      if (takerMatches) {
        this.addReward(take.index, take.lpAwarded.lpAwardedTaker, 'taker');
      }
      if (kickerMatches) {
        this.addReward(take.index, take.lpAwarded.lpAwardedKicker, 'kicker');
      }

      if (bigIntStringGreater(take.blockTimestamp, maxTimestamp)) {
        maxTimestamp = take.blockTimestamp;
      }
    }
    this.cursorBlockTimestamp = maxTimestamp;
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
    let { exchangeRate, deposit, collateral } = await bucket.getStatus();
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
            exchangeRate,
            rewardActionCollateral
          )
        );
        ({ exchangeRate, deposit, collateral } = await bucket.getStatus());
      }
      const remainingLp = rewardLp.sub(reedemed);
      if (remainingLp.lte(constants.Zero)) {
        return reedemed;
      }
      const remainingQuote = await bucket.lpToQuoteTokens(remainingLp);
      const quoteToWithdraw = min(remainingQuote, deposit);
      if (quoteToWithdraw.gt(decimaledToWei(minAmountQuote))) {
        reedemed = reedemed.add(
          await this.redeemQuote(
            bucket,
            quoteToWithdraw,
            exchangeRate,
            rewardActionQuote
          )
        );
      }
    } else {
      const quoteToWithdraw = min(depositRedeemable, deposit);
      if (quoteToWithdraw.gt(decimaledToWei(minAmountQuote))) {
        reedemed = reedemed.add(
          await this.redeemQuote(
            bucket,
            quoteToWithdraw,
            exchangeRate,
            rewardActionQuote
          )
        );
        ({ exchangeRate, deposit, collateral } = await bucket.getStatus());
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
            exchangeRate,
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
    exchangeRate: BigNumber,
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
    exchangeRate: BigNumber,
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

  private addReward(
    bucketIndex: number,
    rewardLpDecimal: string,
    role: 'taker' | 'kicker'
  ) {
    const rewardLp = parseBigDecimalToWad(rewardLpDecimal);
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
// like "123.456000000000000000". Convert to a WAD-scaled BigNumber.
function parseBigDecimalToWad(value: string): BigNumber {
  if (!value || value === '0' || value === '0.0') {
    return constants.Zero;
  }
  try {
    return utils.parseUnits(value, 18);
  } catch (error) {
    logger.warn(
      `Failed to parse LP reward amount "${value}" as BigDecimal; treating as zero`,
      error
    );
    return constants.Zero;
  }
}

function bigIntStringGreater(a: string, b: string): boolean {
  try {
    return BigNumber.from(a).gt(BigNumber.from(b));
  } catch {
    return false;
  }
}
