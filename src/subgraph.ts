import { gql, request, RequestDocument } from 'graphql-request';
import {
  EndpointKind,
  formatEndpointForLogs,
  logEndpointFailover,
  orderEndpointsByHealth,
  recordEndpointFailure,
  recordEndpointSuccess,
} from './endpoint-health';
import { logger } from './logging';

const SUBGRAPH_FAILURE_THRESHOLD = 3;
const SUBGRAPH_COOLDOWN_MS = 30_000;
const SUBGRAPH_TIMEOUT_MS = 8_000;

interface SubgraphRequestOptions {
  fallbackUrls?: string[];
}

function uniqueEndpoints(endpoints: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const endpoint of endpoints) {
    if (!endpoint || seen.has(endpoint)) {
      continue;
    }
    seen.add(endpoint);
    result.push(endpoint);
  }
  return result;
}

function getSubgraphEndpoints(
  subgraphUrl: string,
  options?: SubgraphRequestOptions
): string[] {
  return uniqueEndpoints([subgraphUrl, ...(options?.fallbackUrls ?? [])]);
}

async function requestSubgraph<T, V extends Record<string, any> = Record<string, never>>(params: {
  subgraphUrl: string;
  document: RequestDocument;
  variables?: V;
  options?: SubgraphRequestOptions;
}): Promise<T> {
  const endpointKind: EndpointKind = 'subgraph';
  const endpoints = orderEndpointsByHealth(
    endpointKind,
    getSubgraphEndpoints(params.subgraphUrl, params.options)
  );

  let lastError: unknown;
  for (let index = 0; index < endpoints.length; index++) {
    const endpoint = endpoints[index];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT_MS);

    try {
      const requestParams: any = {
        url: endpoint,
        document: params.document,
        signal: controller.signal,
      };
      if (params.variables !== undefined) {
        requestParams.variables = params.variables;
      }
      const result = await request<T, V>(requestParams);
      clearTimeout(timeout);
      recordEndpointSuccess(endpointKind, endpoint);
      if (index > 0) {
        logger.warn(
          `subgraph request succeeded on fallback endpoint=${formatEndpointForLogs(endpoint)}`
        );
      }
      return result;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      recordEndpointFailure(endpointKind, endpoint, error, {
        failureThreshold: SUBGRAPH_FAILURE_THRESHOLD,
        cooldownMs: SUBGRAPH_COOLDOWN_MS,
      });
      const nextEndpoint = endpoints[index + 1];
      if (nextEndpoint) {
        logEndpointFailover({
          kind: endpointKind,
          from: endpoint,
          to: nextEndpoint,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throw lastError ?? new Error('All subgraph endpoints failed');
}

export interface GetLoanResponse {
  loans: {
    borrower: string;
    thresholdPrice: number;
  }[];
}

const GET_LOANS_PAGE_SIZE = 1000;
const GET_LOANS_MAX_PAGES = 100;

async function paginateSubgraphCursor<TItem>(params: {
  pageSize: number;
  maxPages: number;
  truncationWarning: string;
  fetchPage: (cursor: string) => Promise<TItem[]>;
  getCursor: (item: TItem) => string | undefined;
  missingCursorWarning?: string;
}): Promise<TItem[]> {
  const items: TItem[] = [];
  let cursor = '';

  for (let page = 0; page < params.maxPages; page++) {
    const pageItems = await params.fetchPage(cursor);
    items.push(...pageItems);

    if (
      page === params.maxPages - 1 &&
      pageItems.length === params.pageSize
    ) {
      logger.warn(params.truncationWarning);
    }

    if (pageItems.length < params.pageSize) {
      break;
    }

    const nextCursor = params.getCursor(pageItems[pageItems.length - 1]);
    if (!nextCursor) {
      if (params.missingCursorWarning) {
        logger.warn(params.missingCursorWarning);
      }
      break;
    }

    cursor = nextCursor;
  }

  return items;
}

const getLoansQuery = gql`
  query GetLoans($poolId: String!, $first: Int!, $afterBorrower: String!) {
    loans(
      first: $first
      orderBy: borrower
      orderDirection: asc
      where: {
        inLiquidation: false
        poolAddress: $poolId
        borrower_gt: $afterBorrower
      }
    ) {
      borrower
      thresholdPrice
    }
  }
`;

async function getLoans(
  subgraphUrl: string,
  poolAddress: string,
  options?: SubgraphRequestOptions
) {
  const poolId = poolAddress.toLowerCase();
  const loans = await paginateSubgraphCursor({
    pageSize: GET_LOANS_PAGE_SIZE,
    maxPages: GET_LOANS_MAX_PAGES,
    truncationWarning: `Loan discovery reached maxPages=${GET_LOANS_MAX_PAGES} with pageSize=${GET_LOANS_PAGE_SIZE} for pool=${poolId}; results may be truncated`,
    fetchPage: async (afterBorrower) => {
      const pageResult = await requestSubgraph<
        GetLoanResponse,
        { poolId: string; first: number; afterBorrower: string }
      >({
        subgraphUrl,
        document: getLoansQuery,
        variables: {
          poolId,
          first: GET_LOANS_PAGE_SIZE,
          afterBorrower,
        },
        options,
      });
      return pageResult.loans;
    },
    getCursor: (loan) => loan.borrower.toLowerCase(),
  });

  return { loans };
}

export interface GetLiquidationResponse {
  pool: {
    hpb: number;
    hpbIndex: number;
    liquidationAuctions: {
      borrower: string;
    }[];
  };
}

const GET_LIQUIDATIONS_PAGE_SIZE = 1000;
const GET_LIQUIDATIONS_MAX_PAGES = 100;

const getLiquidationsQuery = gql`
  query GetLiquidations(
    $poolId: String!
    $minCollateral: String!
    $first: Int!
    $afterBorrower: String!
  ) {
    pool(id: $poolId) {
      hpb
      hpbIndex
      liquidationAuctions(
        first: $first
        orderBy: borrower
        orderDirection: asc
        where: {
          collateralRemaining_gt: $minCollateral
          borrower_gt: $afterBorrower
        }
      ) {
        borrower
      }
    }
  }
`;

async function getLiquidations(
  subgraphUrl: string,
  poolAddress: string,
  minCollateral: number,
  options?: SubgraphRequestOptions
) {
  const poolId = poolAddress.toLowerCase();
  let hpb = 0;
  let hpbIndex = 0;
  const liquidationAuctions = await paginateSubgraphCursor({
    pageSize: GET_LIQUIDATIONS_PAGE_SIZE,
    maxPages: GET_LIQUIDATIONS_MAX_PAGES,
    truncationWarning: `Pool liquidation discovery reached maxPages=${GET_LIQUIDATIONS_MAX_PAGES} with pageSize=${GET_LIQUIDATIONS_PAGE_SIZE} for pool=${poolId}; results may be truncated`,
    fetchPage: async (afterBorrower) => {
      const pageResult = await requestSubgraph<
        GetLiquidationResponse,
        {
          poolId: string;
          minCollateral: string;
          first: number;
          afterBorrower: string;
        }
      >({
        subgraphUrl,
        document: getLiquidationsQuery,
        variables: {
          poolId,
          minCollateral: minCollateral.toString(),
          first: GET_LIQUIDATIONS_PAGE_SIZE,
          afterBorrower,
        },
        options,
      });

      if (pageResult.pool) {
        hpb = pageResult.pool.hpb;
        hpbIndex = pageResult.pool.hpbIndex;
      }

      return pageResult.pool?.liquidationAuctions ?? [];
    },
    getCursor: (auction) => auction.borrower.toLowerCase(),
  });

  return {
    pool: {
      hpb,
      hpbIndex,
      liquidationAuctions,
    },
  };
}

export interface GetMeaningfulBucketResponse {
  buckets: {
    bucketIndex: number;
  }[];
}

async function getHighestMeaningfulBucket(
  subgraphUrl: string,
  poolAddress: string,
  minDeposit: string,
  options?: SubgraphRequestOptions
) {
  const query = gql`
    query {
      buckets(
        where: {
          deposit_gt: "${minDeposit}"
          poolAddress: "${poolAddress.toLowerCase()}"
        }
        first: 1
        orderBy: bucketPrice
        orderDirection: desc
      ) {
        bucketIndex
      }
    }
  `;

  const result = await requestSubgraph<GetMeaningfulBucketResponse>({
    subgraphUrl,
    document: query,
    options,
  });
  return result;
}

export interface GetUnsettledAuctionsResponse {
  liquidationAuctions: {
    borrower: string;
    kickTime: string;
    debtRemaining: string;
    collateralRemaining: string;
    neutralPrice: string;
    debt: string;
    collateral: string;
  }[];
}

export interface ChainwideLiquidationAuction {
  id?: string;
  borrower: string;
  kickTime: string;
  debtRemaining: string;
  collateralRemaining: string;
  neutralPrice: string;
  debt: string;
  collateral: string;
  pool: {
    id: string;
  };
}

export interface GetChainwideLiquidationAuctionsResponse {
  liquidationAuctions: ChainwideLiquidationAuction[];
}

const GET_UNSETTLED_AUCTIONS_PAGE_SIZE = 1000;
const GET_UNSETTLED_AUCTIONS_MAX_PAGES = 100;

const getUnsettledAuctionsQuery = gql`
  query GetUnsettledAuctions(
    $poolId: String!
    $first: Int!
    $afterBorrower: String!
  ) {
    liquidationAuctions(
      first: $first
      orderBy: borrower
      orderDirection: asc
      where: {
        pool: $poolId
        settled: false
        borrower_gt: $afterBorrower
      }
    ) {
      borrower
      kickTime
      debtRemaining
      collateralRemaining
      neutralPrice
      debt
      collateral
    }
  }
`;

async function getUnsettledAuctions(
  subgraphUrl: string,
  poolAddress: string,
  options?: SubgraphRequestOptions
) {
  const poolId = poolAddress.toLowerCase();
  const liquidationAuctions = await paginateSubgraphCursor({
    pageSize: GET_UNSETTLED_AUCTIONS_PAGE_SIZE,
    maxPages: GET_UNSETTLED_AUCTIONS_MAX_PAGES,
    truncationWarning: `Unsettled auction discovery reached maxPages=${GET_UNSETTLED_AUCTIONS_MAX_PAGES} with pageSize=${GET_UNSETTLED_AUCTIONS_PAGE_SIZE} for pool=${poolId}; results may be truncated`,
    fetchPage: async (afterBorrower) => {
      const pageResult = await requestSubgraph<
        GetUnsettledAuctionsResponse,
        { poolId: string; first: number; afterBorrower: string }
      >({
        subgraphUrl,
        document: getUnsettledAuctionsQuery,
        variables: {
          poolId,
          first: GET_UNSETTLED_AUCTIONS_PAGE_SIZE,
          afterBorrower,
        },
        options,
      });
      return pageResult.liquidationAuctions;
    },
    getCursor: (auction) => auction.borrower.toLowerCase(),
  });

  return { liquidationAuctions };
}

const getChainwideLiquidationAuctionsQuery = gql`
  query GetChainwideLiquidationAuctions($first: Int!, $afterId: String!) {
    liquidationAuctions(
      first: $first
      orderBy: id
      orderDirection: asc
      where: {
        settled: false
        id_gt: $afterId
      }
    ) {
      id
      borrower
      kickTime
      debtRemaining
      collateralRemaining
      neutralPrice
      debt
      collateral
      pool {
        id
      }
    }
  }
`;

async function getChainwideLiquidationAuctionsPage(
  subgraphUrl: string,
  first: number = 100,
  afterId: string = '',
  options?: SubgraphRequestOptions
) {
  const result = await requestSubgraph<
    GetChainwideLiquidationAuctionsResponse,
    { first: number; afterId: string }
  >({
    subgraphUrl,
    document: getChainwideLiquidationAuctionsQuery,
    variables: { first, afterId },
    options,
  });
  return result;
}

async function getChainwideLiquidationAuctions(
  subgraphUrl: string,
  pageSize: number = 100,
  maxPages: number = 100,
  options?: SubgraphRequestOptions
) {
  const liquidationAuctions = await paginateSubgraphCursor({
    pageSize,
    maxPages,
    truncationWarning: `Chain-wide liquidation discovery reached maxPages=${maxPages} with pageSize=${pageSize}; results may be truncated`,
    fetchPage: async (afterId) => {
      const pageResult = await getChainwideLiquidationAuctionsPage(
        subgraphUrl,
        pageSize,
        afterId,
        options
      );
      return pageResult.liquidationAuctions;
    },
    getCursor: (auction) => auction.id,
    missingCursorWarning:
      'Chain-wide liquidation discovery response omitted auction id; stopping pagination early to avoid unstable cursors',
  });

  return { liquidationAuctions };
}


export interface BucketTakeLPAwardItem {
  id: string;
  index: number;
  taker: string;
  lpAwarded: {
    lpAwardedTaker: string;
    lpAwardedKicker: string;
    kicker: string;
  };
  blockTimestamp: string;
}

export interface GetBucketTakeLPAwardsResponse {
  bucketTakes: BucketTakeLPAwardItem[];
}

const GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE = 1000;
const GET_BUCKET_TAKE_LP_AWARDS_MAX_PAGES = 100;

// Composite (blockTimestamp, id) cursor. Ordering by blockTimestamp guarantees
// chronological forward progress; the `id_gt` tie-breaker handles multiple
// events sharing the same timestamp. Subgraph event ids are txHash-logIndex
// which are NOT time-monotonic, so an id-only cursor would permanently filter
// events whose random tx hash lex-sorts below the cursor.
//
// Pagination relies on Graph Node's implementation-detail behavior of breaking
// ties by `id ASC` when the explicit `orderBy` doesn't fully order the result
// set. This is stable in practice (has been Graph Node's default for years)
// but is not part of the Graph Protocol spec. If ties ever become unstable,
// pagination across same-timestamp clusters larger than one page could miss
// or duplicate events; `seenEventIds` on the caller side catches duplicates
// but not misses.
const getBucketTakeLPAwardsQuery = gql`
  query GetBucketTakeLPAwards(
    $poolId: String!
    $signerId: Bytes!
    $cursorTs: BigInt!
    $cursorId: Bytes!
    $first: Int!
  ) {
    bucketTakes(
      first: $first
      orderBy: blockTimestamp
      orderDirection: asc
      where: {
        or: [
          {
            pool: $poolId
            taker: $signerId
            blockTimestamp_gt: $cursorTs
          }
          {
            pool: $poolId
            taker: $signerId
            blockTimestamp: $cursorTs
            id_gt: $cursorId
          }
          {
            pool: $poolId
            liquidationAuction_: { kicker: $signerId }
            blockTimestamp_gt: $cursorTs
          }
          {
            pool: $poolId
            liquidationAuction_: { kicker: $signerId }
            blockTimestamp: $cursorTs
            id_gt: $cursorId
          }
        ]
      }
    ) {
      id
      index
      taker
      lpAwarded {
        lpAwardedTaker
        lpAwardedKicker
        kicker
      }
      blockTimestamp
    }
  }
`;

async function getBucketTakeLPAwards(
  subgraphUrl: string,
  poolAddress: string,
  signerAddress: string,
  cursorBlockTimestamp: string,
  options?: SubgraphRequestOptions
): Promise<GetBucketTakeLPAwardsResponse> {
  const poolId = poolAddress.toLowerCase();
  const signerId = signerAddress.toLowerCase();
  const bucketTakes: BucketTakeLPAwardItem[] = [];

  // Within-call pagination advances a composite (pageTs, pageId) cursor between
  // pages so same-timestamp events are split deterministically by id. The
  // caller's `cursorBlockTimestamp` anchors the first page; subsequent pages
  // advance both fields from each page's last item.
  //
  // `pageId` uses `'0x'` (canonical empty-bytes hex) as the "before all ids"
  // sentinel. BucketTake.id is a `Bytes!` in the Ajna subgraph schema; the
  // query parameter is typed `Bytes!` to match, and an empty-bytes value
  // lexicographically precedes every real id (which are `txHash-logIndex`
  // hex-encoded and therefore always non-empty). Passing `''` here would
  // rely on Graph Node's silent String→Bytes coercion and is not portable.
  let pageTs = cursorBlockTimestamp;
  let pageId = '0x';

  for (let page = 0; page < GET_BUCKET_TAKE_LP_AWARDS_MAX_PAGES; page++) {
    const pageResult = await requestSubgraph<
      { bucketTakes: BucketTakeLPAwardItem[] },
      {
        poolId: string;
        signerId: string;
        cursorTs: string;
        cursorId: string;
        first: number;
      }
    >({
      subgraphUrl,
      document: getBucketTakeLPAwardsQuery,
      variables: {
        poolId,
        signerId,
        cursorTs: pageTs,
        cursorId: pageId,
        first: GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE,
      },
      options,
    });

    const pageItems = pageResult.bucketTakes;
    bucketTakes.push(...pageItems);

    if (
      page === GET_BUCKET_TAKE_LP_AWARDS_MAX_PAGES - 1 &&
      pageItems.length === GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE
    ) {
      logger.warn(
        `LP reward discovery reached maxPages=${GET_BUCKET_TAKE_LP_AWARDS_MAX_PAGES} with pageSize=${GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE} for pool=${poolId}; results may be truncated`
      );
    }

    if (pageItems.length < GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE) {
      break;
    }

    // Advance the composite cursor to the last item of this page. Because the
    // server returned results in (blockTimestamp asc, id asc) order, the last
    // item is the chronologically latest item of this page.
    const lastItem = pageItems[pageItems.length - 1];
    if (!lastItem.id || !lastItem.blockTimestamp) {
      logger.warn(
        'LP reward discovery response omitted id or blockTimestamp; stopping pagination early to avoid unstable cursors'
      );
      break;
    }
    pageTs = lastItem.blockTimestamp;
    pageId = lastItem.id.toLowerCase();
  }

  return { bucketTakes };
}

// Exported as default module to enable mocking in tests.
export default {
  getLoans,
  getLiquidations,
  getHighestMeaningfulBucket,
  getUnsettledAuctions,
  getChainwideLiquidationAuctionsPage,
  getChainwideLiquidationAuctions,
  getBucketTakeLPAwards,
};
