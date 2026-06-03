import 'dotenv/config';
import {
  KeeperConfig,
  PriceOriginPoolReference,
  PriceOriginSource,
  TokenToCollect,
} from '../src/config';

const config: KeeperConfig = {
  network: {
    rpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    subgraph: {
      url: `https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/9npza28cZyi8R94SJjm9Y3fuWeBZZK4CHr2r8NCvsr98`,
    },
    multicall: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      block: 5022,
    },
    tokenAddresses: {
      weth: '0x4200000000000000000000000000000000000006',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
  },
  signer: {
    keystore: '/path/to/your/keystore.json',
  },
  runtime: {
    dryRun: false,
    logLevel: 'info',
    delayBetweenRuns: 45,
  },
  pricing: {
    coinGeckoApiKey: process.env.COINGECKO_API_KEY,
  },
  discovery: {
    ...{
      enabled: true,
      take: {
        enabled: true,
        maxPoolsPerRun: 3,
        takeQuoteBudgetPerRun: 3,
        maxGasPriceGwei: 2,
        maxGasCostNative: 0.00005,
        // These are quote-token denominated. Leave them unset unless you explicitly
        // want native->quote conversion during policy checks.
        // maxGasCostQuote: 1,
        // minExpectedProfitQuote: 1,
        // If discovery.defaults.take enables factory external takes later, import
        // LiquiditySource and list every direct-DEX factory route that may execute:
        // allowedLiquiditySources: [LiquiditySource.UNISWAPV3, LiquiditySource.SUSHISWAP],
        // To compare aggregators against the best factory route for discovered takes:
        // allowedExternalTakePaths: ['oneinch', 'factory'],
        // allowedExternalTakePaths: ['factory', 'lifi'],
        // allowedExternalTakePaths: ['oneinch', 'factory', 'lifi'],
        // defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
        // externalTakeProbeTimeoutMs: 2_000,
        // externalTakeRouteSelectionMode: 'factory_first', // lower aggregator API use, can skip a better aggregator route
        // takeRouteQuoteBudgetPerCandidate: 2,
        // minProfitNative: '1000000000000000', // 0.001 ETH minimum net profit
        // LI.FI is an aggregator path, not a factory source. Before enabling it,
        // configure production dex.lifi allowlists, takers.contracts.Lifi, both
        // LI.FI production gates, and a conservative LI.FI gas override:
        // dexGasOverrides: {
        //   [LiquiditySource.SUSHISWAP]: '700000',
        //   [LiquiditySource.LIFI]: '900000',
        // },
        // validateRouteDeployments: true, // required for LI.FI and mixed factory/aggregator paths
        // gasPriceDriftToleranceBasisPoints: 2_000,
      },
      settlement: {
        enabled: true,
        maxPoolsPerRun: 3,
        maxGasPriceGwei: 2,
        maxGasCostNative: 0.00005,
        // This is quote-token denominated. Leave it unset unless you explicitly want
        // native->quote conversion across mixed quote assets.
        // maxGasCostQuote: 1,
      },
      dryRunNewPools: true,
      logSkips: true,
      hydrateCooldownSec: 900,
      // If you want an even smaller first blast radius, uncomment allowPools
      // and start with one or two known pools.
      // allowPools: [
      //   '0x63a366fc5976ff72999c89f69366f388b7d233e8',
      // ],
    },
    defaults: {
      take: {
        // First rollout: arb-take only for discovered pools.
        // Add liquiditySource + marketPriceFactor later if you want discovered external takes.
        // Keep allowSubsidy false unless you intentionally want defensive subsidized takes.
        // allowSubsidy: false,
        minCollateral: 0.01,
        hpbPriceFactor: 0.9,
      },
      settlement: {
        enabled: true,
        minAuctionAge: 21600,
        maxBucketDepth: 25,
        maxIterations: 5,
        checkBotIncentive: true,
      },
    },
  },
  ajna: {
    erc20PoolFactory: '0x214f62B5836D83f3D6c4f71F174209097B1A779C',
    erc721PoolFactory: '0xeefEC5d1Cc4bde97279d01D88eFf9e0fEe981769',
    poolUtils: '0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa',
    positionManager: '0x59710a4149A27585f1841b5783ac704a08274e64',
    ajnaToken: '0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47',
    grantFund: '',
    burnWrapper: '',
    lenderHelper: '',
  },
  manual: {
    pools: [
      {
        name: 'wstETH / WETH',
        address: '0x63a366fc5976ff72999c89f69366f388b7d233e8',
        price: {
          source: PriceOriginSource.FIXED,
          value: 1.15,
        },
        kick: {
          enabled: true,
          minDebt: 0.07,
          priceFactor: 0.9,
        },
        take: {
          minCollateral: 0.01,
          hpbPriceFactor: 0.9,
        },
        collectBond: true,
        collectLpReward: {
          redeemFirst: TokenToCollect.QUOTE,
          minAmountQuote: 0.001,
          minAmountCollateral: 1000,
        },
        settlement: {
          enabled: true,
          minAuctionAge: 18000,
          maxBucketDepth: 50,
          maxIterations: 10,
          checkBotIncentive: true,
        },
      },
      {
        name: 'WETH / USDC',
        address: '0x0b17159f2486f669a1f930926638008e2ccb4287',
        price: {
          source: PriceOriginSource.COINGECKO,
          query: 'price?ids=ethereum&vs_currencies=usd',
        },
        kick: {
          enabled: true,
          minDebt: 50,
          priceFactor: 0.95,
        },
        take: {
          minCollateral: 0.01,
          hpbPriceFactor: 0.9,
        },
        collectBond: true,
        collectLpReward: {
          redeemFirst: TokenToCollect.COLLATERAL,
          minAmountQuote: 1000,
          minAmountCollateral: 0.001,
        },
        settlement: {
          enabled: true,
          minAuctionAge: 18000,
          maxBucketDepth: 50,
          maxIterations: 10,
          checkBotIncentive: true,
        },
      },
      {
        name: 'cbETH / WETH',
        address: '0xcb1953ee28f89731c0ec088da0720fc282fcfa9c',
        price: {
          source: PriceOriginSource.POOL,
          reference: PriceOriginPoolReference.LUP,
        },
        kick: {
          enabled: true,
          minDebt: 0.08,
          priceFactor: 0.95,
        },
        take: {
          minCollateral: 0.01,
          hpbPriceFactor: 0.9,
        },
        collectBond: true,
        collectLpReward: {
          redeemFirst: TokenToCollect.QUOTE,
          minAmountQuote: 0.001,
          minAmountCollateral: 100,
        },
        settlement: {
          enabled: true,
          minAuctionAge: 18000,
          maxBucketDepth: 50,
          maxIterations: 10,
          checkBotIncentive: true,
        },
      },
    ],
  },
};

export default config;
