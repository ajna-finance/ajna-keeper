import { KeeperConfig, LiquiditySource } from '../../src/config';

export const baseAutoDiscoverConfig = (): KeeperConfig => ({
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
  writes: {},
  discovery: {
    enabled: true,
    take: true,
    settlement: false,
    defaults: {
      take: {
        liquiditySource: LiquiditySource.UNISWAPV3,
        marketPriceFactor: 0.99,
      },
    },
  },
  takers: {
    router: '0x1234567890123456789012345678901234567890',
    contracts: {
      UniswapV3: '0x3333333333333333333333333333333333333333',
    },
  },
  dex: {
    oneInch: {},
    uniswapV3: {
      router: {
        swapRouter02Address: '0x5555555555555555555555555555555555555555',
        poolFactoryAddress: '0x7777777777777777777777777777777777777777',
        quoterV2Address: '0x1212121212121212121212121212121212121212',
        wethAddress: '0x4200000000000000000000000000000000000006',
        defaultFeeTier: 3000,
      },
    },
  },
});

export const configureOneInchAggregatorTake = (
  config: KeeperConfig
): void => {
  const callTarget = '0x6666666666666666666666666666666666666666';
  config.takers = {
    ...config.takers,
    router:
      config.takers?.router ?? '0x1234567890123456789012345678901234567890',
    contracts: {
      ...config.takers?.contracts,
      OneInchAggregator: '0x1234567890123456789012345678901234567890',
    },
  };
  config.dex = {
    ...config.dex,
    oneInch: {
      ...config.dex?.oneInch,
      callTargetAllowlist: {
        1: [callTarget],
      },
      approvalSpenderAllowlist: {
        1: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      },
      selectorAllowlist: {
        1: {
          [callTarget]: ['0x12345678'],
        },
      },
    },
  };
};

export const configureSushiAggregatorTake = (
  config: KeeperConfig
): void => {
  const callTarget = '0x8888888888888888888888888888888888888888';
  config.takers = {
    ...config.takers,
    router:
      config.takers?.router ?? '0x1234567890123456789012345678901234567890',
    contracts: {
      ...config.takers?.contracts,
      SushiAggregator: '0x9999999999999999999999999999999999999999',
    },
  };
  config.dex = {
    ...config.dex,
    sushiAggregator: {
      mode: 'production',
      callTargetAllowlist: {
        1: [callTarget],
      },
      approvalSpenderAllowlist: {
        1: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      },
      selectorAllowlist: {
        1: {
          [callTarget]: ['0x12345678'],
        },
      },
    },
  };
};
