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

async function getLoans(
  subgraphUrl: string,
  poolAddress: string,
  options?: SubgraphRequestOptions
) {
  const query = gql`
    query {
      loans (where: {inLiquidation: false, poolAddress: "${poolAddress.toLowerCase()}"}){
        borrower
        thresholdPrice
      }
    }
  `;

  const result = await requestSubgraph<GetLoanResponse>({
    subgraphUrl,
    document: query,
    options,
  });
  return result;
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
  query GetChainwideLiquidationAuctions($first: Int!, $skip: Int!) {
    liquidationAuctions(
      first: $first
      skip: $skip
      orderBy: kickTime
      orderDirection: desc
      where: {
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
      pool {
        id
      }
    }
  }
`;

async function getChainwideLiquidationAuctionsPage(
  subgraphUrl: string,
  first: number = 100,
  skip: number = 0,
  options?: SubgraphRequestOptions
) {
  const result = await requestSubgraph<
    GetChainwideLiquidationAuctionsResponse,
    { first: number; skip: number }
  >({
    subgraphUrl,
    document: getChainwideLiquidationAuctionsQuery,
    variables: { first, skip },
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
  for (let page = 0; page < maxPages; page++) {
    const pageResult = await getChainwideLiquidationAuctionsPage(
      subgraphUrl,
      pageSize,
      page * pageSize,
      options
    );
    liquidationAuctions.push.apply(
      liquidationAuctions,
      pageResult.liquidationAuctions
    );
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
