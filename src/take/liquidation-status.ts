import { FungiblePool } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { getErrorMessage } from '../utils';
import { logger } from '../logging';

export const TAKE_STATUS_BATCH_SIZE = 50;
const TAKE_STATUS_SINGLE_READ_FALLBACK_CONCURRENCY = 4;
const AUCTION_STATUS_COLLATERAL_INDEX = 1;
const AUCTION_STATUS_PRICE_INDEX = 4;

export interface TakeAuctionStatus {
  borrower: string;
  collateral: BigNumber;
  auctionPrice: BigNumber;
}

export interface TakeAuctionStatusReader {
  read(params: {
    pool: FungiblePool;
    borrower: string;
  }): Promise<TakeAuctionStatus>;
  readMany?(params: {
    pool: FungiblePool;
    borrowers: string[];
  }): Promise<Map<string, TakeAuctionStatus>>;
}

export interface TakeAuctionStatusReadStats {
  takeStatusReadCount?: number;
  takeStatusBatchReadCount?: number;
  takeStatusBatchBorrowerCount?: number;
  takeStatusBatchFallbackCount?: number;
}

export function normalizeBorrowerKey(borrower: string): string {
  return borrower.toLowerCase();
}

function incrementStat(
  stats: TakeAuctionStatusReadStats | undefined,
  key: keyof TakeAuctionStatusReadStats,
  amount: number = 1
): void {
  if (!stats) {
    return;
  }
  stats[key] = (stats[key] ?? 0) + amount;
}

function mapAuctionStatusResult(
  borrower: string,
  result: {
    collateral?: BigNumber;
    collateral_?: BigNumber;
    price?: BigNumber;
    price_?: BigNumber;
    [index: number]: unknown;
  }
): TakeAuctionStatus {
  const collateral =
    result.collateral_ ??
    result.collateral ??
    result[AUCTION_STATUS_COLLATERAL_INDEX];
  const auctionPrice =
    result.price_ ?? result.price ?? result[AUCTION_STATUS_PRICE_INDEX];
  if (
    !BigNumber.isBigNumber(collateral) ||
    !BigNumber.isBigNumber(auctionPrice)
  ) {
    throw new Error(`auctionStatus returned malformed data for ${borrower}`);
  }
  return {
    borrower,
    collateral,
    auctionPrice,
  };
}

async function readSingleStatus(params: {
  pool: FungiblePool;
  borrower: string;
  stats?: TakeAuctionStatusReadStats;
}): Promise<TakeAuctionStatus> {
  incrementStat(params.stats, 'takeStatusReadCount');
  const maybePool = params.pool as FungiblePool & {
    poolInfoContractUtils?: {
      auctionStatus?: (
        poolAddress: string,
        borrower: string
      ) => Promise<unknown>;
    };
    getLiquidation?: (borrower: string) => {
      getStatus?: () => Promise<unknown>;
    };
  };
  let result: unknown;
  if (typeof maybePool.poolInfoContractUtils?.auctionStatus === 'function') {
    result = await maybePool.poolInfoContractUtils.auctionStatus(
      params.pool.poolAddress,
      params.borrower
    );
  } else if (typeof maybePool.getLiquidation === 'function') {
    logger.debug(
      `Lean auctionStatus reader unavailable for ${params.pool.name}; falling back to SDK liquidation status`
    );
    result = await maybePool.getLiquidation(params.borrower).getStatus?.();
  } else {
    throw new Error(
      `pool ${params.pool.name} does not expose auctionStatus reader utilities`
    );
  }
  return mapAuctionStatusResult(
    params.borrower,
    result as {
      collateral?: BigNumber;
      collateral_?: BigNumber;
      price?: BigNumber;
      price_?: BigNumber;
      [index: number]: unknown;
    }
  );
}

async function readSingleStatuses(params: {
  pool: FungiblePool;
  borrowers: string[];
  stats?: TakeAuctionStatusReadStats;
}): Promise<Map<string, TakeAuctionStatus>> {
  const result = new Map<string, TakeAuctionStatus>();
  let nextIndex = 0;
  const workerCount = Math.min(
    TAKE_STATUS_SINGLE_READ_FALLBACK_CONCURRENCY,
    params.borrowers.length
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < params.borrowers.length) {
        const index = nextIndex;
        nextIndex += 1;
        const borrower = params.borrowers[index];
        try {
          const status = await readSingleStatus({
            pool: params.pool,
            borrower,
            stats: params.stats,
          });
          result.set(normalizeBorrowerKey(status.borrower), status);
        } catch (error) {
          logger.debug(
            `Skipping preloaded take status for ${params.pool.name}/${borrower}: ${getErrorMessage(error)}`
          );
        }
      }
    })
  );
  return result;
}

function supportsBatchStatusRead(pool: FungiblePool): boolean {
  const maybePool = pool as FungiblePool & {
    contractUtilsMulti?: {
      auctionStatus?: (poolAddress: string, borrower: string) => unknown;
    };
    ethcallProvider?: {
      all?: (calls: unknown[]) => Promise<unknown[]>;
    };
  };
  return (
    typeof maybePool.contractUtilsMulti?.auctionStatus === 'function' &&
    typeof maybePool.ethcallProvider?.all === 'function'
  );
}

function getBorrowerChunks(borrowers: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < borrowers.length; index += TAKE_STATUS_BATCH_SIZE) {
    chunks.push(borrowers.slice(index, index + TAKE_STATUS_BATCH_SIZE));
  }
  return chunks;
}

async function readStatusChunk(params: {
  pool: FungiblePool;
  borrowers: string[];
  stats?: TakeAuctionStatusReadStats;
}): Promise<Map<string, TakeAuctionStatus>> {
  const calls = params.borrowers.map((borrower) =>
    params.pool.contractUtilsMulti.auctionStatus(
      params.pool.poolAddress,
      borrower
    )
  );
  const response = await params.pool.ethcallProvider.all(calls);
  if (response.length !== params.borrowers.length) {
    throw new Error(
      `auctionStatus batch returned ${response.length} results for ${params.borrowers.length} borrowers`
    );
  }
  incrementStat(params.stats, 'takeStatusBatchReadCount');
  incrementStat(
    params.stats,
    'takeStatusBatchBorrowerCount',
    params.borrowers.length
  );
  const result = new Map<string, TakeAuctionStatus>();
  for (let index = 0; index < response.length; index += 1) {
    const borrower = params.borrowers[index];
    const status = mapAuctionStatusResult(
      borrower,
      response[index] as {
        collateral_?: BigNumber;
        price_?: BigNumber;
        [index: number]: unknown;
      }
    );
    result.set(normalizeBorrowerKey(borrower), status);
  }
  return result;
}

export function createTakeAuctionStatusReader(params?: {
  stats?: TakeAuctionStatusReadStats;
}): TakeAuctionStatusReader {
  return {
    read: async ({ pool, borrower }) =>
      await readSingleStatus({
        pool,
        borrower,
        stats: params?.stats,
      }),
    readMany: async ({ pool, borrowers }) => {
      if (borrowers.length === 0) {
        return new Map();
      }
      if (!supportsBatchStatusRead(pool)) {
        incrementStat(params?.stats, 'takeStatusBatchFallbackCount');
        return await readSingleStatuses({
          pool,
          borrowers,
          stats: params?.stats,
        });
      }

      const result = new Map<string, TakeAuctionStatus>();
      for (const chunk of getBorrowerChunks(borrowers)) {
        try {
          const chunkStatuses = await readStatusChunk({
            pool,
            borrowers: chunk,
            stats: params?.stats,
          });
          for (const [borrower, status] of Array.from(chunkStatuses)) {
            result.set(borrower, status);
          }
        } catch (error) {
          incrementStat(params?.stats, 'takeStatusBatchFallbackCount');
          logger.debug(
            `Falling back to single take status reads for ${pool.name} chunk: ${getErrorMessage(error)}`
          );
          const fallbackStatuses = await readSingleStatuses({
            pool,
            borrowers: chunk,
            stats: params?.stats,
          });
          for (const [borrower, status] of Array.from(fallbackStatuses)) {
            result.set(borrower, status);
          }
        }
      }
      return result;
    },
  };
}

export const defaultTakeAuctionStatusReader = createTakeAuctionStatusReader();
