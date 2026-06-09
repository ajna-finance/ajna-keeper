import { FungiblePool } from '@ajna-finance/sdk';
import { ethers } from 'ethers';
import type { SubgraphReader } from '../../src/read-transports';
import subgraphModule, {
  GetLiquidationResponse,
  GetLoanResponse,
} from '../../src/subgraph';
import type { ChainwideLiquidationAuction } from '../../src/subgraph';
import { isBenignNoLiquidationError } from '../no-spend-harness-helpers';
import { FIXTURE_SUBGRAPH_SENTINEL_URL } from './fixture-constants';

export function overrideGetLoans(
  fn: typeof subgraphModule.getLoans
): () => void {
  const originalGetLoans = subgraphModule.getLoans;
  subgraphModule.getLoans = fn;
  return () => {
    subgraphModule.getLoans = originalGetLoans;
  };
}

export function overrideGetLiquidations(
  fn: typeof subgraphModule.getLiquidations
): () => void {
  const originalGetLiquidations = subgraphModule.getLiquidations;
  subgraphModule.getLiquidations = fn;
  return () => {
    subgraphModule.getLiquidations = originalGetLiquidations;
  };
}

export function makeGetLoansFromFixture(
  pool: FungiblePool,
  borrower: string
): typeof subgraphModule.getLoans {
  return async (): Promise<GetLoanResponse> => {
    const loan = await pool.getLoan(borrower);
    if ((loan as any).isKicked) {
      return { loans: [] };
    }
    return {
      loans: [
        {
          borrower,
          thresholdPrice: Number(loan.thresholdPrice.toString()) / 1e18,
        },
      ],
    };
  };
}

export function makeGetLiquidationsFromFixture(
  pool: FungiblePool,
  borrower: string
): typeof subgraphModule.getLiquidations {
  return async (
    _subgraphUrl: string,
    _poolAddress: string,
    minCollateral: number
  ): Promise<GetLiquidationResponse> => {
    const { hpb, hpbIndex } = await pool.getPrices();
    try {
      const liquidation = await pool.getLiquidation(borrower);
      const status = await liquidation.getStatus();
      const collateral = Number(status.collateral.toString()) / 1e18;
      return {
        pool: {
          hpb: Number(hpb.toString()) / 1e18,
          hpbIndex,
          liquidationAuctions: collateral > minCollateral ? [{ borrower }] : [],
        },
      };
    } catch (error) {
      if (!isBenignNoLiquidationError(error)) {
        throw error;
      }
      return {
        pool: {
          hpb: Number(hpb.toString()) / 1e18,
          hpbIndex,
          liquidationAuctions: [],
        },
      };
    }
  };
}

export function makeFixtureSubgraphReader(
  pool: FungiblePool,
  borrower: string,
  provider?: ethers.providers.Provider
): SubgraphReader {
  const getLoans = makeGetLoansFromFixture(pool, borrower);
  const getLiquidations = makeGetLiquidationsFromFixture(pool, borrower);
  const getChainwideAuction = async (): Promise<ChainwideLiquidationAuction[]> => {
    try {
      const liquidation = await pool.getLiquidation(borrower);
      const status = await liquidation.getStatus();
      if (!status.collateral.gt(0)) {
        return [];
      }
      const debtToCover = (status as any).debtToCover;
      return [
        {
          id: `${pool.poolAddress.toLowerCase()}-${borrower.toLowerCase()}`,
          borrower,
          kickTime: '0',
          debtRemaining: debtToCover?.toString?.() ?? '0',
          collateralRemaining: status.collateral.toString(),
          neutralPrice: '0',
          debt: debtToCover?.toString?.() ?? '0',
          collateral: status.collateral.toString(),
          pool: {
            id: pool.poolAddress.toLowerCase(),
          },
        },
      ];
    } catch (error) {
      if (!isBenignNoLiquidationError(error)) {
        throw error;
      }
      return [];
    }
  };
  return {
    cacheKey: `fixture:${pool.poolAddress}:${borrower.toLowerCase()}`,
    getLoans(poolAddress) {
      return getLoans(FIXTURE_SUBGRAPH_SENTINEL_URL, poolAddress);
    },
    getLiquidations(poolAddress, minCollateral) {
      return getLiquidations(
        FIXTURE_SUBGRAPH_SENTINEL_URL,
        poolAddress,
        minCollateral
      );
    },
    async getHighestMeaningfulBucket() {
      return { buckets: [] } as any;
    },
    async getUnsettledAuctions() {
      return { liquidationAuctions: [] } as any;
    },
    async getChainwideLiquidationAuctions() {
      return { liquidationAuctions: await getChainwideAuction() };
    },
    async getBucketTakeLPAwards() {
      return { bucketTakeLPAwards: [] } as any;
    },
    async getSubgraphMeta() {
      if (provider) {
        const block = await provider.getBlock('latest');
        return {
          block: {
            number: block.number,
            timestamp: block.timestamp,
          },
          deployment: 'fixture-local',
          hasIndexingErrors: false,
        } as any;
      }
      return {
        block: {
          number: 0,
          timestamp: Math.floor(Date.now() / 1000),
        },
      } as any;
    },
  };
}
