import { KeeperConfig, LiquiditySource } from '../../../src/config';

export const baseRoutePreflightConfig = (): KeeperConfig => ({
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
    take: {
      enabled: true,
      validateRouteDeployments: true,
    },
    defaults: {
      take: {
        liquiditySource: LiquiditySource.UNISWAPV3,
        marketPriceFactor: 0.99,
      },
    },
  },
  takers: {
    router: '0x1111111111111111111111111111111111111111',
    contracts: {
      UniswapV3: '0x2222222222222222222222222222222222222222',
    },
  },
  dex: {
    uniswapV3: {
      router: {
        swapRouter02Address: '0x3333333333333333333333333333333333333333',
        poolFactoryAddress: '0x5555555555555555555555555555555555555555',
        quoterV2Address: '0x6666666666666666666666666666666666666666',
        wethAddress: '0x7777777777777777777777777777777777777777',
      },
    },
  },
});
