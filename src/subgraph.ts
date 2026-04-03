import { gql, request } from 'graphql-request';

export interface GetLoanResponse {
  loans: {
    borrower: string;
    thresholdPrice: number;
  }[];
}

async function getLoans(subgraphUrl: string, poolAddress: string) {
  const query = gql`
    query {
      loans (where: {inLiquidation: false, poolAddress: "${poolAddress.toLowerCase()}"}){
        borrower
        thresholdPrice
      }
    }
  `;

  const result: GetLoanResponse = await request(subgraphUrl, query);
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
  minCollateral: number
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

  const result: GetLiquidationResponse = await request(subgraphUrl, query);
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
  minDeposit: string
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

  const result: GetMeaningfulBucketResponse = await request(subgraphUrl, query);
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

async function getUnsettledAuctions(subgraphUrl: string, poolAddress: string) {
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

  const result: GetUnsettledAuctionsResponse = await request(subgraphUrl, query, {
    poolId: poolAddress.toLowerCase()
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
  skip: number = 0
) {
  const result: GetChainwideLiquidationAuctionsResponse = await request(
    subgraphUrl,
    getChainwideLiquidationAuctionsQuery,
    { first, skip }
  );
  return result;
}

async function getChainwideLiquidationAuctions(
  subgraphUrl: string,
  pageSize: number = 100,
  maxPages: number = 100
) {
  const liquidationAuctions: ChainwideLiquidationAuction[] = [];
  for (let page = 0; page < maxPages; page++) {
    const pageResult = await getChainwideLiquidationAuctionsPage(
      subgraphUrl,
      pageSize,
      page * pageSize
    );
    liquidationAuctions.push.apply(
      liquidationAuctions,
      pageResult.liquidationAuctions
    );
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
