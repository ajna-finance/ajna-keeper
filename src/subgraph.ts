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
  const loans: GetLoanResponse['loans'] = [];
  const poolId = poolAddress.toLowerCase();
  let afterBorrower = '';

  for (let page = 0; page < GET_LOANS_MAX_PAGES; page++) {
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
    loans.push(...pageResult.loans);

    if (
      page === GET_LOANS_MAX_PAGES - 1 &&
      pageResult.loans.length === GET_LOANS_PAGE_SIZE
    ) {
      logger.warn(
        `Loan discovery reached maxPages=${GET_LOANS_MAX_PAGES} with pageSize=${GET_LOANS_PAGE_SIZE} for pool=${poolId}; results may be truncated`
      );
    }

    if (pageResult.loans.length < GET_LOANS_PAGE_SIZE) {
      break;
    }

    afterBorrower = pageResult.loans[pageResult.loans.length - 1].borrower.toLowerCase();
  }

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

async function getLiquidations(
  subgraphUrl: string,
  poolAddress: string,
  minCollateral: number,
  options?: SubgraphRequestOptions
) {
  // TODO: Should probably sort auctions by kickTime so that we kick the most profitable auctions first.
  const query = gql`
    query {
      pool (id: "${poolAddress.toLowerCase()}") {
        hpb
        hpbIndex
        liquidationAuctions (where: {collateralRemaining_gt: "${minCollateral}"}) {
          borrower
        }
      }
    }
  `;

  const result = await requestSubgraph<GetLiquidationResponse>({
    subgraphUrl,
    document: query,
    options,
  });
  return result;
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

async function getUnsettledAuctions(
  subgraphUrl: string,
  poolAddress: string,
  options?: SubgraphRequestOptions
) {
  const query = gql`
    query GetUnsettledAuctions($poolId: String!) {
      liquidationAuctions(
        where: {
          pool: $poolId,
          settled: false
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

  const result = await requestSubgraph<GetUnsettledAuctionsResponse, { poolId: string }>({
    subgraphUrl,
    document: query,
    variables: {
      poolId: poolAddress.toLowerCase(),
    },
    options,
  });
  return result;
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
  const liquidationAuctions: ChainwideLiquidationAuction[] = [];
  let afterId = '';
  for (let page = 0; page < maxPages; page++) {
    const pageResult = await getChainwideLiquidationAuctionsPage(
      subgraphUrl,
      pageSize,
      afterId,
      options
    );
    liquidationAuctions.push.apply(
      liquidationAuctions,
      pageResult.liquidationAuctions
    );
    const lastAuction =
      pageResult.liquidationAuctions[pageResult.liquidationAuctions.length - 1];
    if (lastAuction?.id) {
      afterId = lastAuction.id;
    } else if (lastAuction) {
      logger.warn(
        'Chain-wide liquidation discovery response omitted auction id; stopping pagination early to avoid unstable cursors'
      );
      break;
    }
    if (
      page === maxPages - 1 &&
      pageResult.liquidationAuctions.length === pageSize
    ) {
      logger.warn(
        `Chain-wide liquidation discovery reached maxPages=${maxPages} with pageSize=${pageSize}; results may be truncated`
      );
    }
    if (pageResult.liquidationAuctions.length < pageSize) {
      break;
    }
  }

  return { liquidationAuctions };
}


// Exported as default module to enable mocking in tests.
export default { 
  getLoans, 
  getLiquidations, 
  getHighestMeaningfulBucket, 
  getUnsettledAuctions,
  getChainwideLiquidationAuctionsPage,
  getChainwideLiquidationAuctions,
};
