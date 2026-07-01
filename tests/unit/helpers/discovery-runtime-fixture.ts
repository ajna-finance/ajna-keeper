import { ethers } from 'ethers';
import sinon from 'sinon';
import { AjnaSDK } from '@ajna-finance/sdk';
import { KeeperConfig } from '../../../src/config';
import { createDiscoveryRuntime } from '../../../src/discovery/runtime';
import type { DiscoveredTakeTargetStats } from '../../../src/discovery/take-executor';
import {
  normalizeAddress,
  PoolHydrationCooldowns,
  PoolMap,
} from '../../../src/discovery/targets';

export interface TestPoolHandle {
  name: string;
  poolAddress: string;
  collateralAddress?: string;
  quoteAddress?: string;
}

type PoolLoader = (poolAddress: string) => Promise<TestPoolHandle>;

export const BASE_CONFIG: KeeperConfig = {
  network: {
    rpcUrl: 'http://localhost:8545',
    subgraph: {
      url: 'http://example-subgraph',
    },
  },
  signer: {
    keystore: '/tmp/keeper.json',
  },
  runtime: {
    logLevel: 'debug',
    delayBetweenRuns: 1,
  },
  ajna: {
    erc20PoolFactory: '0x0000000000000000000000000000000000000001',
    erc721PoolFactory: '0x0000000000000000000000000000000000000002',
    poolUtils: '0x0000000000000000000000000000000000000003',
    positionManager: '0x0000000000000000000000000000000000000004',
    ajnaToken: '0x0000000000000000000000000000000000000005',
  },
  manual: {
    pools: [],
  },
};

export function makeDiscoveredTakeTargetStats(
  overrides: Partial<DiscoveredTakeTargetStats> = {}
): DiscoveredTakeTargetStats {
  return {
    candidateCount: 0,
    approvedTakeDecisions: 0,
    approvedArbTakeDecisions: 0,
    approvedUniswapV3TakeDecisions: 0,
    approvedCurveTakeDecisions: 0,
    evaluationSkips: 0,
    revalidationSkips: 0,
    executionSkips: 0,
    gasPolicyRejects: 0,
    profitFloorRejects: 0,
    arbProfitUnavailableRejects: 0,
    executedExternalTakes: 0,
    executedArbTakes: 0,
    executedUniswapV3Takes: 0,
    executedCurveTakes: 0,
    dryRunExternalTakes: 0,
    dryRunArbTakes: 0,
    dryRunUniswapV3Takes: 0,
    dryRunCurveTakes: 0,
    externalTakeByPath: {},
    externalTakeByProvider: {},
    hybridFallbackAttempts: 0,
    hybridFallbackSuccesses: 0,
    hybridGasQuoteFallbackAttempts: 0,
    hybridGasQuoteFallbackSuccesses: 0,
    hotAuctionCandidateRemovals: 0,
    ...overrides,
  };
}

function poolPairKey(pool: TestPoolHandle): string | undefined {
  if (!pool.collateralAddress || !pool.quoteAddress) {
    return undefined;
  }
  return `${normalizeAddress(pool.collateralAddress)}:${normalizeAddress(pool.quoteAddress)}`;
}

export function makeAjnaFactoryWithPoolLoader(
  getPoolByAddress:
    | PoolLoader
    | sinon.SinonStub<[string], Promise<TestPoolHandle>>,
  deployedPools: TestPoolHandle[]
): AjnaSDK {
  const deployedPoolAddresses = new Map<string, string>();
  for (const pool of deployedPools) {
    const key = poolPairKey(pool);
    if (key) {
      deployedPoolAddresses.set(key, normalizeAddress(pool.poolAddress));
    }
  }
  const getPoolAddress = sinon
    .stub()
    .callsFake(async (collateralAddress: string, quoteAddress: string) => {
      return (
        deployedPoolAddresses.get(
          `${normalizeAddress(collateralAddress)}:${normalizeAddress(quoteAddress)}`
        ) ?? ethers.constants.AddressZero
      );
    });

  const loadingGetPoolByAddress = sinon
    .stub()
    .callsFake(async (poolAddress: string) => {
      return await getPoolByAddress(poolAddress);
    });

  return {
    fungiblePoolFactory: {
      getPoolByAddress: loadingGetPoolByAddress,
      getPoolAddress,
    },
  } as unknown as AjnaSDK;
}

export function makeAjnaFactoryWithHydratedPools(
  pools: TestPoolHandle[]
): AjnaSDK {
  const poolByAddress = new Map(
    pools.map((pool) => [normalizeAddress(pool.poolAddress), pool])
  );
  const getPoolByAddress = sinon
    .stub()
    .callsFake(async (poolAddress: string) => {
      const pool = poolByAddress.get(normalizeAddress(poolAddress));
      if (!pool) {
        throw new Error(`test pool not configured: ${poolAddress}`);
      }
      return pool;
    });

  return makeAjnaFactoryWithPoolLoader(getPoolByAddress, pools);
}

export function createTestDiscoveryRuntime(params: {
  config: KeeperConfig;
  ajna?: AjnaSDK;
  poolMap?: PoolMap;
  signer?: Record<string, unknown>;
  takeWriteTransport?: unknown;
  hydrationCooldowns?: PoolHydrationCooldowns;
  discoverySnapshotState?: unknown;
}) {
  const ajna = params.ajna ?? ({} as AjnaSDK);

  const signer = {
    getChainId: sinon.stub().resolves(1),
    ...(params.signer ?? {}),
  } as any;

  return createDiscoveryRuntime({
    ajna,
    poolMap: params.poolMap ?? new Map(),
    config: params.config,
    signer: signer as any,
    takeWriteTransport: params.takeWriteTransport as any,
    hydrationCooldowns: params.hydrationCooldowns ?? new Map(),
    discoverySnapshotState: params.discoverySnapshotState as any,
  });
}
