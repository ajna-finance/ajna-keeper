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
    dryRun: true,
    logLevel: 'debug',
    delayBetweenRuns: 30,
    delayBetweenActions: 2,
  },
  dex: {
    oneInch: {
      routers: {
        8453: '0x1111111254EEB25477B68fb85Ed929f73A960582', // Base
      },
    },
    uniswapV3: {
      universalRouter: {
        universalRouterAddress: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
        wethAddress: '0x4200000000000000000000000000000000000006',
        permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
        poolFactoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
        quoterV2Address: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
        defaultFeeTier: 3000, // Preferred/default 0.3% fee tier
        // Omit candidateFeeTiers to auto-probe standard V3 tiers. Add it only to narrow/customize the probed set.
        // candidateFeeTiers: [500, 10000],
        defaultSlippage: 0.5, // 0.5% slippage
      },
    },
  },
  pricing: {
    coinGeckoApiKey: process.env.COINGECKO_API_KEY,
  },
  discovery: {
    ...{
      enabled: true,
      take: {
        enabled: true,
        maxPoolsPerRun: 10,
        takeQuoteBudgetPerRun: 5,
        maxGasPriceGwei: 5,
        maxGasCostNative: 0.0001,
        // Quote-denominated gas caps require native->quote conversion.
        // Leave them unset unless you explicitly want quote-token thresholds.
        // maxGasCostQuote: 0.01,
        // Set minExpectedProfitQuote only after discovered external takes are enabled.
        // minExpectedProfitQuote: 0.005,
      },
      settlement: {
        enabled: true,
        maxPoolsPerRun: 10,
        maxGasPriceGwei: 5,
        maxGasCostNative: 0.0001,
        // maxGasCostQuote: 0.01,
      },
      dryRunNewPools: true,
      logSkips: true,
    },
    defaults: {
      take: {
        // Start discovered pools on arb-take only.
        // Add liquiditySource + marketPriceFactor after external take contracts are deployed.
        // Keep allowSubsidy false unless you intentionally want defensive subsidized takes.
        // allowSubsidy: false,
        minCollateral: 0.01,
        hpbPriceFactor: 0.9,
      },
      settlement: {
        enabled: true,
        minAuctionAge: 18000,
        maxBucketDepth: 50,
        maxIterations: 10,
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
          minDebt: 0.07,
          priceFactor: 0.9,
        },
        take: {
          minCollateral: 0.01,
          hpbPriceFactor: 0.9,
          // External takes disabled for now - enable after contract deployment
          // liquiditySource: LiquiditySource.UNISWAPV3,
          // marketPriceFactor: 0.98,
          // allowSubsidy: false,
        },
        collectBond: true,
        collectLpReward: {
          redeemFirst: TokenToCollect.QUOTE,
          minAmountQuote: 0.001,
          minAmountCollateral: 1000,
        },
        settlement: {
          enabled: true,
          minAuctionAge: 18000, // 5 hours
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
