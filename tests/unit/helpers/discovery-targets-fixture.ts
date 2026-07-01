import { KeeperConfig } from '../../../src/config';

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
  discovery: {
    enabled: true,
    take: true,
    settlement: true,
    logSkips: true,
    defaults: {
      take: {
        minCollateral: 0.1,
        hpbPriceFactor: 0.98,
      },
      settlement: {
        enabled: true,
        minAuctionAge: 3600,
        maxBucketDepth: 50,
        maxIterations: 5,
        checkBotIncentive: true,
      },
    },
  },
};
