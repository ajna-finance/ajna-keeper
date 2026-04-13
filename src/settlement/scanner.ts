import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { ethers } from 'ethers';
import { logger } from '../logging';
import { AuctionToSettle, SettlementReadConfig } from './model';
import { SettlementActionConfig } from './types';
import { needsSettlement } from './checks';

export class SettlementScanner {
  private lastSubgraphQuery = 0;
  private cachedAuctions: AuctionToSettle[] = [];
  private readonly QUERY_CACHE_DURATION = 300000;

  constructor(
    private pool: FungiblePool,
    private signer: Signer,
    private poolConfig: SettlementActionConfig,
    private config: SettlementReadConfig
  ) {}

  async findSettleableAuctions(): Promise<AuctionToSettle[]> {
    const now = Date.now();
    const minAge = this.poolConfig.settlement.minAuctionAge || 3600;
    const cacheAge = now - this.lastSubgraphQuery;
    const shouldUseCache =
      cacheAge < this.QUERY_CACHE_DURATION &&
      cacheAge < minAge * 1000;

    if (shouldUseCache) {
      logger.debug(
        `Using cached settlement data for ${this.pool.name} (${Math.round(
          cacheAge / 1000
        )}s old)`
      );
      return this.cachedAuctions;
    }

    logger.debug(
      `Querying subgraph for settlement data: ${this.pool.name} (cache age: ${Math.round(
        cacheAge / 1000
      )}s)`
    );

    try {
      const result = await this.config.subgraph.getUnsettledAuctions(
        this.pool.poolAddress
      );

      this.lastSubgraphQuery = now;
      const actuallySettleable: AuctionToSettle[] = [];

      for (const auction of result.liquidationAuctions) {
        const borrower = auction.borrower;
        const kickTime = parseInt(auction.kickTime) * 1000;
        const ageSeconds = (now - kickTime) / 1000;

        if (ageSeconds < minAge) {
          logger.debug(
            `Auction ${borrower.slice(0, 8)} too young (${Math.round(
              ageSeconds
            )}s < ${minAge}s) - skipping on-chain check`
          );
          continue;
        }

        logger.debug(
          `Checking if auction ${borrower.slice(0, 8)} actually needs settlement (age: ${Math.round(
            ageSeconds
          )}s)...`
        );

        const settlementCheck = await needsSettlement({
          pool: this.pool,
          signer: this.signer,
          borrower,
        });

        if (settlementCheck.needs) {
          logger.debug(
            `Auction ${borrower.slice(0, 8)} DOES need settlement: ${settlementCheck.reason}`
          );
          actuallySettleable.push({
            borrower: auction.borrower,
            kickTime,
            debtRemaining: ethers.utils.parseEther(
              auction.debtRemaining || '0'
            ),
            collateralRemaining: ethers.utils.parseEther(
              auction.collateralRemaining || '0'
            ),
          });
        } else {
          logger.debug(
            `Auction ${borrower.slice(0, 8)} does NOT need settlement: ${settlementCheck.reason}`
          );
        }
      }

      if (actuallySettleable.length > 0) {
        logger.info(
          `Found ${actuallySettleable.length} auctions that ACTUALLY need settlement in pool: ${this.pool.name}`
        );
      } else {
        logger.debug(
          `No auctions actually need settlement in pool: ${this.pool.name} (all too young or already settled)`
        );
      }

      this.cachedAuctions = actuallySettleable;
      return actuallySettleable;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes('ECONNRESET') ||
        errorMessage.includes('ETIMEDOUT')
      ) {
        logger.warn(
          `Network error querying settlements for ${this.pool.name}, will retry: ${errorMessage}`
        );
      } else {
        logger.error(`Error querying settlements for ${this.pool.name}:`, error);
      }

      return [];
    }
  }
}
