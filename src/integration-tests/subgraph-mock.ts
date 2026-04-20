import { ERC20Pool__factory, FungiblePool, Loan } from '@ajna-finance/sdk';
import { BigNumber, utils } from 'ethers';
import subgraphModule, {
  BucketTakeLPAwardItem,
  GetBucketTakeLPAwardsResponse,
  GetLiquidationResponse,
  GetLoanResponse,
  GetMeaningfulBucketResponse,
} from '../subgraph';
import { getProvider } from './test-utils';
import { decimaledToWei, weiToDecimaled } from '../utils';
import { MAINNET_CONFIG } from './test-config';
import { logger } from '../logging';

export function overrideGetLoans(
  fn: typeof subgraphModule.getLoans
): () => void {
  const originalGetLoans = subgraphModule.getLoans;
  const undoFn = () => {
    subgraphModule.getLoans = originalGetLoans;
  };
  subgraphModule.getLoans = fn;
  return undoFn;
}

export const makeGetLoansFromSdk = (pool: FungiblePool) => {
  return async (
    subgraphUrl: string,
    poolAddress: string
  ): Promise<GetLoanResponse> => {
    const loansMap = await getLoansMap(pool);
    const borrowerLoanTuple = Array.from(loansMap.entries());
    const loans = borrowerLoanTuple
      .filter(([_, { isKicked, thresholdPrice }]) => !isKicked)
      .map(([borrower, { thresholdPrice }]) => ({
        borrower,
        thresholdPrice: weiToDecimaled(thresholdPrice),
      }));
    return {
      loans,
    };
  };
};

async function getLoansMap(pool: FungiblePool): Promise<Map<string, Loan>> {
  const { loansCount } = await pool.getStats();
  const poolContract = ERC20Pool__factory.connect(
    pool.poolAddress,
    getProvider()
  );
  const borrowers: string[] = [];
  for (let i = 1; i < loansCount + 1; i++) {
    const [borrower] = await poolContract.loanInfo(i);
    borrowers.push(borrower);
  }
  return await pool.getLoans(borrowers);
}

export function overrideGetLiquidations(
  fn: typeof subgraphModule.getLiquidations
): () => void {
  const originalGetLiquidations = subgraphModule.getLiquidations;
  const undoFn = () => {
    subgraphModule.getLiquidations = originalGetLiquidations;
  };
  subgraphModule.getLiquidations = fn;
  return undoFn;
}

export function makeGetLiquidationsFromSdk(pool: FungiblePool) {
  return async (
    subgraphUrl: string,
    poolAddress: string,
    minCollateral: number
  ): Promise<GetLiquidationResponse> => {
    const { hpb, hpbIndex } = await pool.getPrices();
    const poolContract = ERC20Pool__factory.connect(
      pool.poolAddress,
      getProvider()
    );
    const events = await poolContract.queryFilter(
      poolContract.filters.Kick(),
      MAINNET_CONFIG.BLOCK_NUMBER
    );
    const borrowers: string[] = [];
    for (const evt of events) {
      const { borrower } = evt.args;
      borrowers.push(borrower);
    }
    const liquidationAuctions: GetLiquidationResponse['pool']['liquidationAuctions'] =
      [];
    for (const borrower of borrowers) {
      try {
        const liquidation = await pool.getLiquidation(borrower);
        const liquidationStatus = await liquidation.getStatus();
        if (weiToDecimaled(liquidationStatus.collateral) > minCollateral) {
          liquidationAuctions.push({
            borrower,
          });
        }
      } catch (e) {
        logger.debug(
          `Failed to find auction for borrower: ${borrower}, pool: ${pool.name}`
        );
      }
    }

    return {
      pool: {
        hpb: weiToDecimaled(hpb),
        hpbIndex,
        liquidationAuctions,
      },
    };
  };
}

export function overrideGetHighestMeaningfulBucket(
  fn: typeof subgraphModule.getHighestMeaningfulBucket
): () => void {
  const originalGetBucket = subgraphModule.getHighestMeaningfulBucket;
  const undoFn = () => {
    subgraphModule.getHighestMeaningfulBucket = originalGetBucket;
  };
  subgraphModule.getHighestMeaningfulBucket = fn;
  return undoFn;
}

export function overrideGetBucketTakeLPAwards(
  fn: typeof subgraphModule.getBucketTakeLPAwards
): () => void {
  const original = subgraphModule.getBucketTakeLPAwards;
  const undoFn = () => {
    subgraphModule.getBucketTakeLPAwards = original;
  };
  subgraphModule.getBucketTakeLPAwards = fn;
  return undoFn;
}

// Match production's `pageSize * maxPages` cap so the mock truncates at the
// same boundary a real subgraph call would.
const MOCK_LP_AWARDS_PAGE_SIZE = 1000;
const MOCK_LP_AWARDS_MAX_PAGES = 100;

// Coverage model: `getBucketTakeLPAwards` paginates INTERNALLY by advancing a
// composite `(blockTimestamp, id)` cursor until a short page or `maxPages`
// hits. The externally-observable return is a flat, ordered list with the
// final truncation applied. This mock stands in for that externally-visible
// contract — it returns the same flat list production would return after
// its internal pagination loop completes. Cross-page composite-cursor
// semantics are exercised at the unit level in `subgraph-bucket-takes.test.ts`
// against a stubbed `graphql-request`; integration tests don't need to
// re-cover that path through the mock.
//
// Pool scoping is enforced via the closure over `pool` (all queryFilter calls
// go to `pool.poolAddress`), mirroring production's `pool: $poolId` filter.
// Multi-pool tests must construct a separate mock per pool.
export function makeGetBucketTakeLPAwardsFromSdk(pool: FungiblePool) {
  return async (
    _subgraphUrl: string,
    _poolAddress: string,
    signerAddress: string,
    cursorBlockTimestamp: string
  ): Promise<GetBucketTakeLPAwardsResponse> => {
    const provider = getProvider();
    const poolContract = ERC20Pool__factory.connect(pool.poolAddress, provider);
    const lpAwardedFilter = poolContract.filters.BucketTakeLPAwarded();
    const events = await poolContract.queryFilter(
      lpAwardedFilter,
      MAINNET_CONFIG.BLOCK_NUMBER
    );
    // Matches production's page-1 semantics. On the first page, production's
    // query `blockTimestamp_gt: cursorTs OR (blockTimestamp == cursorTs AND
    // id_gt: '')` reduces to `blockTimestamp >= cursorTs` because every id
    // sorts strictly above the empty string. Subsequent pages advance a
    // composite `(pageTs, pageId)` cursor, but the FULL paged result is
    // equivalent to the single `>= cursorTs` selection sorted by `(ts, id)`
    // and truncated at the cap — which is exactly what this mock returns.
    const cursorTs = BigNumber.from(cursorBlockTimestamp || '0');
    const signerLower = signerAddress.toLowerCase();

    const candidates: BucketTakeLPAwardItem[] = [];
    for (const evt of events) {
      const { taker, kicker, lpAwardedTaker, lpAwardedKicker } = evt.args;
      const takerMatches = taker.toLowerCase() === signerLower;
      const kickerMatches = kicker.toLowerCase() === signerLower;
      if (!takerMatches && !kickerMatches) {
        continue;
      }

      const block = await evt.getBlock();
      const blockTimestamp = BigNumber.from(block.timestamp);

      // Parse the originating bucketTake(borrower, depositTake, index) call
      // to recover the bucket index the same way production used to — this
      // path only runs in tests against hardhat forks where the subgraph
      // can't see the local chain state.
      //
      // Known divergence from production: events emitted inside a Multicall3
      // wrapper (or any other aggregator) are SKIPPED here because
      // `parseTransaction` sees the wrapper's top-level function, not the
      // inner bucketTake. Production reads `BucketTake.index` directly from
      // the indexed entity and has no such restriction. Tests that wrap
      // bucketTake in multicall will silently lose coverage against the
      // mock. None of the current fixtures use that pattern; revisit if
      // that changes.
      const tx = await evt.getTransaction();
      const parsed = poolContract.interface.parseTransaction(tx);
      if (parsed.functionFragment.name !== 'bucketTake') {
        continue;
      }
      const [, , indexBn] = parsed.args as [string, boolean, BigNumber];

      const id = `${evt.transactionHash}-${evt.logIndex.toString(16).padStart(6, '0')}`.toLowerCase();

      if (blockTimestamp.lt(cursorTs)) continue;

      candidates.push({
        id,
        index: indexBn.toNumber(),
        taker: taker.toLowerCase(),
        lpAwarded: {
          lpAwardedTaker: utils.formatUnits(lpAwardedTaker, 18),
          lpAwardedKicker: utils.formatUnits(lpAwardedKicker, 18),
          kicker: kicker.toLowerCase(),
        },
        blockTimestamp: blockTimestamp.toString(),
      });
    }

    // Matches production orderBy: blockTimestamp asc, with id as tie-breaker.
    // Use byte-order string compare (not `localeCompare`, which applies ICU
    // collation and is locale-dependent) to match Graph Node's id ASC.
    candidates.sort((a, b) => {
      const tsCmp = BigNumber.from(a.blockTimestamp).sub(
        BigNumber.from(b.blockTimestamp)
      );
      if (!tsCmp.isZero()) return tsCmp.lt(0) ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // Matches production: clamp at pageSize * maxPages.
    const cap = MOCK_LP_AWARDS_PAGE_SIZE * MOCK_LP_AWARDS_MAX_PAGES;
    const bucketTakes =
      candidates.length > cap ? candidates.slice(0, cap) : candidates;
    return { bucketTakes };
  };
}

export function makeGetHighestMeaningfulBucket(pool: FungiblePool) {
  return async (
    subgraphUrl: string,
    poolAddress: string,
    minDeposit: string
  ): Promise<GetMeaningfulBucketResponse> => {
    const poolContract = ERC20Pool__factory.connect(
      pool.poolAddress,
      getProvider()
    );
    const events = await poolContract.queryFilter(
      poolContract.filters.AddQuoteToken(),
      MAINNET_CONFIG.BLOCK_NUMBER
    );
    const indices = new Set<number>();
    for (const evt of events) {
      const { index } = evt.args;
      indices.add(parseInt(index.toString()));
    }
    const ascIndices = Array.from(indices).sort();
    for (const index of ascIndices) {
      const bucket = pool.getBucketByIndex(index);
      const { deposit } = await bucket.getStatus();
      if (deposit.gte(decimaledToWei(parseFloat(minDeposit)))) {
        return {
          buckets: [{ bucketIndex: index }],
        };
      }
    }
    return { buckets: [] };
  };
}
