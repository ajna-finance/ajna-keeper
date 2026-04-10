import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { PoolConfig } from '../config';
import { logger } from '../logging';
import {
  AuctionToSettle,
  SettlementConfigInput,
  SettlementStatus,
  resolveSettlementReadConfig,
} from './model';
import { SettlementActionConfig } from './types';
import {
  checkBotIncentive,
  isAuctionOldEnough,
  needsSettlement,
} from './checks';
import { SettlementScanner } from './scanner';
import { settleAuctionCompletely } from './execution';
import { delay, RequireFields } from '../utils';

export * from './model';
export * from './types';

export class SettlementHandler {
  private static activeSettlements: Set<string> = new Set();
  private config;
  private scanner: SettlementScanner;

  constructor(
    private pool: FungiblePool,
    private signer: Signer,
    private poolConfig: SettlementActionConfig,
    config: SettlementConfigInput
  ) {
    this.config = resolveSettlementReadConfig(config);
    this.scanner = new SettlementScanner(
      this.pool,
      this.signer,
      this.poolConfig,
      this.config
    );
  }

  async handleSettlements(): Promise<void> {
    logger.debug(`Checking for settleable auctions in pool: ${this.pool.name}`);

    const auctions = await this.findSettleableAuctions();
    if (auctions.length === 0) {
      logger.debug(`No settleable auctions found in pool: ${this.pool.name}`);
      return;
    }

    logger.info(
      `Found ${auctions.length} potentially settleable auctions in pool: ${this.pool.name}`
    );

    for (const auction of auctions) {
      await this.processAuction(auction);
      await delay(this.config.delayBetweenActions);
    }
  }

  async handleCandidateAuctions(auctions: AuctionToSettle[]): Promise<void> {
    for (const auction of auctions) {
      await this.processAuction(auction);
      await delay(this.config.delayBetweenActions);
    }
  }

  public async findSettleableAuctions(): Promise<AuctionToSettle[]> {
    return await this.scanner.findSettleableAuctions();
  }

  async needsSettlement(borrower: string) {
    return await needsSettlement({
      pool: this.pool,
      signer: this.signer,
      borrower,
    });
  }

  async checkBotIncentive(borrower: string) {
    return await checkBotIncentive({
      pool: this.pool,
      signer: this.signer,
      borrower,
    });
  }

  isAuctionOldEnough(auction: AuctionToSettle): boolean {
    return isAuctionOldEnough(auction, this.poolConfig);
  }

  async settleAuctionCompletely(borrower: string) {
    return await settleAuctionCompletely({
      pool: this.pool,
      signer: this.signer,
      borrower,
      poolConfig: this.poolConfig,
      config: this.config,
    });
  }

  async getSettlementStatus(borrower: string): Promise<SettlementStatus> {
    const signerAddress = await this.signer.getAddress();
    const auctionInfo = await this.pool.contract.auctionInfo(borrower);
    const { locked, claimable } = await this.pool.kickerInfo(signerAddress);

    return {
      auctionExists: !auctionInfo.kickTime_.eq(0),
      bondsLocked: !locked.eq(0),
      bondsClaimable: claimable.gt(0),
      needsSettlement: !auctionInfo.kickTime_.eq(0),
      canWithdrawBonds: locked.eq(0) && claimable.gt(0),
    };
  }

  private async processAuction(auction: AuctionToSettle): Promise<void> {
    const { borrower } = auction;
    const settlementKey = `${this.pool.poolAddress}-${borrower}`;

    if (SettlementHandler.activeSettlements.has(settlementKey)) {
      logger.debug(
        `Settlement already in progress for ${borrower.slice(0, 8)} in ${this.pool.name} - skipping duplicate`
      );
      return;
    }

    SettlementHandler.activeSettlements.add(settlementKey);

    try {
      logger.debug(
        `Checking settlement for borrower ${borrower.slice(0, 8)} in pool ${this.pool.name}`
      );

      if (!this.isAuctionOldEnough(auction)) {
        logger.debug(
          `Auction for ${borrower.slice(0, 8)} is too young, skipping`
        );
        return;
      }

      const settlementCheck = await this.needsSettlement(borrower);
      if (!settlementCheck.needs) {
        logger.debug(
          `Settlement not needed for ${borrower.slice(0, 8)}: ${settlementCheck.reason}`
        );
        return;
      }

      if (this.poolConfig.settlement.checkBotIncentive) {
        const incentiveCheck = await this.checkBotIncentive(borrower);
        if (!incentiveCheck.hasIncentive) {
          logger.debug(
            `No bot incentive for ${borrower.slice(0, 8)}: ${incentiveCheck.reason}`
          );
          return;
        }
        logger.debug(`Bot incentive confirmed: ${incentiveCheck.reason}`);
      }

      logger.info(
        `SETTLEMENT NEEDED for ${borrower.slice(0, 8)}: ${settlementCheck.reason}`
      );
      const result = await this.settleAuctionCompletely(borrower);

      if (result.success) {
        logger.info(
          `Settlement completed for ${borrower.slice(0, 8)} in ${result.iterations} iterations`
        );
      } else {
        logger.warn(
          `Settlement incomplete for ${borrower.slice(0, 8)} after ${result.iterations} iterations: ${result.reason}`
        );
      }
    } finally {
      SettlementHandler.activeSettlements.delete(settlementKey);
    }
  }
}

export async function handleSettlements({
  pool,
  poolConfig,
  signer,
  config,
}: {
  pool: FungiblePool;
  poolConfig: RequireFields<PoolConfig, 'settlement'>;
  signer: Signer;
  config: SettlementConfigInput;
}): Promise<void> {
  const handler = new SettlementHandler(pool, signer, poolConfig, config);
  await handler.handleSettlements();
}

export async function tryReactiveSettlement({
  pool,
  poolConfig,
  signer,
  config,
}: {
  pool: FungiblePool;
  poolConfig: PoolConfig;
  signer: Signer;
  config: SettlementConfigInput;
}): Promise<boolean> {
  if (!poolConfig.settlement?.enabled) {
    return false;
  }

  const handler = new SettlementHandler(
    pool,
    signer,
    poolConfig as RequireFields<PoolConfig, 'settlement'>,
    config
  );

  const auctions = await handler.findSettleableAuctions();
  if (auctions.length === 0) {
    logger.debug(
      `No auctions need settlement in ${pool.name} - bonds locked for normal reasons`
    );
    return false;
  }

  logger.info(`Bonds locked in ${pool.name}, attempting reactive settlement...`);
  await handler.handleSettlements();

  const signerAddress = await signer.getAddress();
  const { locked } = await pool.kickerInfo(signerAddress);
  const bondsUnlocked = locked.eq(0);

  if (bondsUnlocked) {
    logger.info(`Reactive settlement successful - bonds unlocked in ${pool.name}`);
  } else {
    logger.warn(
      `Reactive settlement completed but bonds still locked in ${pool.name}`
    );
  }

  return bondsUnlocked;
}
