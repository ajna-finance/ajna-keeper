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
  onTruncated?: () => void;
  // Starting cursor for the first page. Defaults to '' (begin). Callers that
  // persist a cross-cycle cursor pass it here so pagination resumes forward
  // instead of restarting at the beginning on every call.
  initialCursor?: string;
}): Promise<TItem[]> {
  const items: TItem[] = [];
  let cursor = params.initialCursor ?? '';

  for (let page = 0; page < params.maxPages; page++) {
    const pageItems = await params.fetchPage(cursor);
    items.push(...pageItems);

    if (
      page === params.maxPages - 1 &&
      pageItems.length === params.pageSize
    ) {
      logger.warn(params.truncationWarning);
      if (params.onTruncated) params.onTruncated();
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
  truncated: boolean;
}

const GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE = 1000;
const GET_BUCKET_TAKE_LP_AWARDS_MAX_PAGES = 100;

const getBucketTakeLPAwardsQuery = gql`
  query GetBucketTakeLPAwards(
    $poolId: String!
    $signerId: Bytes!
    $sinceTimestamp: BigInt!
    $first: Int!
    $afterId: String!
  ) {
    bucketTakes(
      first: $first
      orderBy: id
      orderDirection: asc
      where: {
        or: [
          {
            pool: $poolId
            taker: $signerId
            blockTimestamp_gte: $sinceTimestamp
            id_gt: $afterId
          }
          {
            pool: $poolId
            liquidationAuction_: { kicker: $signerId }
            blockTimestamp_gte: $sinceTimestamp
            id_gt: $afterId
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
  sinceBlockTimestamp: string,
  afterId: string,
  options?: SubgraphRequestOptions
): Promise<GetBucketTakeLPAwardsResponse> {
  const poolId = poolAddress.toLowerCase();
  const signerId = signerAddress.toLowerCase();
  let truncated = false;

  const bucketTakes = await paginateSubgraphCursor<BucketTakeLPAwardItem>({
    pageSize: GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE,
    maxPages: GET_BUCKET_TAKE_LP_AWARDS_MAX_PAGES,
    initialCursor: afterId,
    truncationWarning: `LP reward discovery reached maxPages=${GET_BUCKET_TAKE_LP_AWARDS_MAX_PAGES} with pageSize=${GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE} for pool=${poolId}; results may be truncated`,
    onTruncated: () => {
      truncated = true;
    },
    fetchPage: async (afterId) => {
      const pageResult = await requestSubgraph<
        { bucketTakes: BucketTakeLPAwardItem[] },
        {
          poolId: string;
          signerId: string;
          sinceTimestamp: string;
          first: number;
          afterId: string;
        }
      >({
        subgraphUrl,
        document: getBucketTakeLPAwardsQuery,
        variables: {
          poolId,
          signerId,
          sinceTimestamp: sinceBlockTimestamp,
          first: GET_BUCKET_TAKE_LP_AWARDS_PAGE_SIZE,
          afterId,
        },
        options,
      });
      return pageResult.bucketTakes;
    },
    getCursor: (item) => item.id.toLowerCase(),
    missingCursorWarning:
      'LP reward discovery response omitted bucketTake id; stopping pagination early to avoid unstable cursors',
  });

  return { bucketTakes, truncated };
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
