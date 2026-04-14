import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { ethers } from 'ethers';
import { logger } from '../logging';
import { AuctionToSettle, SettlementReadConfig } from './model';
import { SettlementActionConfig } from './types';
import { needsSettlement } from './checks';

interface SettlementScannerCacheEntry {
  lastSubgraphQuery: number;
  cachedAuctions: AuctionToSettle[];
}

const sharedSettlementScannerCache = new Map<string, SettlementScannerCacheEntry>();
const SHARED_SETTLEMENT_SCANNER_CACHE_RETENTION_MS = 900000;

export function clearSharedSettlementScannerCache(): void {
  sharedSettlementScannerCache.clear();
}

function pruneSharedSettlementScannerCache(now: number): void {
  sharedSettlementScannerCache.forEach((entry, cacheKey) => {
    if (now - entry.lastSubgraphQuery > SHARED_SETTLEMENT_SCANNER_CACHE_RETENTION_MS) {
      sharedSettlementScannerCache.delete(cacheKey);
    }
  });
}

export class SettlementScanner {
  private readonly QUERY_CACHE_DURATION = 300000;

  constructor(
    private pool: FungiblePool,
    private signer: Signer,
    private poolConfig: SettlementActionConfig,
    private config: SettlementReadConfig
  ) {}

  private getCacheEntry(minAge: number): SettlementScannerCacheEntry {
    pruneSharedSettlementScannerCache(Date.now());
    const maxBucketDepth = this.poolConfig.settlement.maxBucketDepth ?? 50;
    const cacheKey = `${this.config.subgraph.cacheKey}:${this.pool.poolAddress.toLowerCase()}:${minAge}:${maxBucketDepth}`;
    const existing = sharedSettlementScannerCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created: SettlementScannerCacheEntry = {
      lastSubgraphQuery: 0,
      cachedAuctions: [],
    };
    sharedSettlementScannerCache.set(cacheKey, created);
    return created;
  }

  async findSettleableAuctions(): Promise<AuctionToSettle[]> {
    const now = Date.now();
    const minAge = this.poolConfig.settlement.minAuctionAge || 3600;
    const cacheEntry = this.getCacheEntry(minAge);
    const cacheAge = now - cacheEntry.lastSubgraphQuery;
    const shouldUseCache =
      cacheAge < this.QUERY_CACHE_DURATION &&
      cacheAge < minAge * 1000 &&
      cacheEntry.cachedAuctions.length === 0;

    if (shouldUseCache) {
      logger.debug(
        `Using cached settlement data for ${this.pool.name} (${Math.round(
          cacheAge / 1000
        )}s old)`
      );
      return cacheEntry.cachedAuctions;
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
      const actuallySettleable: AuctionToSettle[] = [];
      let hadRetryableCheckFailures = false;
      let sawTooYoungAuction = false;

      for (const auction of result.liquidationAuctions) {
        const borrower = auction.borrower;
        const kickTime = parseInt(auction.kickTime) * 1000;
        const ageSeconds = (now - kickTime) / 1000;

        if (ageSeconds < minAge) {
          sawTooYoungAuction = true;
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
          maxBucketDepth: this.poolConfig.settlement.maxBucketDepth,
        });

        if (settlementCheck.retryable) {
          hadRetryableCheckFailures = true;
          logger.warn(
            `Retryable settlement check failure for ${borrower.slice(0, 8)} in ${this.pool.name}; leaving cache stale so the auction is retried soon: ${settlementCheck.reason}`
          );
          continue;
        }

        if (settlementCheck.needs) {
          logger.debug(
            `Auction ${borrower.slice(0, 8)} DOES need settlement: ${settlementCheck.reason}`
          );
          try {
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
          } catch (error) {
            logger.warn(
              `Skipping settlement candidate ${borrower.slice(0, 8)} in ${this.pool.name}: malformed numeric fields`,
              error
            );
          }
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

      if (!hadRetryableCheckFailures) {
        const canCacheEmptyResult =
          actuallySettleable.length > 0 ||
          (!sawTooYoungAuction && result.liquidationAuctions.length === 0);

        if (canCacheEmptyResult) {
          cacheEntry.lastSubgraphQuery = now;
          cacheEntry.cachedAuctions = actuallySettleable;
        }
      }
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
