import 'dotenv/config';
import { FeeAmount } from '@uniswap/v3-sdk';
import {
  KeeperConfig,
  PriceOriginPoolReference,
  PriceOriginSource,
  RewardActionLabel,
  TokenToCollect,
  LiquiditySource, // Import for external takes
  PostAuctionDex, // Import for LP reward swaps
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
      avax: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      weth: '0x4200000000000000000000000000000000000006',
    },
  },
  signer: {
    keystore: '/path/to/your/keystore.json',
  },
  runtime: {
    dryRun: true,
    logLevel: 'info',
    delayBetweenRuns: 15,
  },
  dex: {
    oneInch: {
      routers: {
        1: '0x1111111254EEB25477B68fb85Ed929f73A960582', // Ethereum
        8453: '0x1111111254EEB25477B68fb85Ed929f73A960582', // Base
        43114: '0x1111111254EEB25477B68fb85Ed929f73A960582', // Avalanche
      },
      connectorTokens: [
        '0x24de8771bc5ddb3362db529fc3358f2df3a0e346',
        '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
        '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
        '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
      ],
    },
    uniswapV3: {
      router: {
        swapRouter02Address: '0x2626664c2603336E57B271c5C0b26F421741e481', // Base SwapRouter02 for direct DEX external takes
        wethAddress: '0x4200000000000000000000000000000000000006', // WETH on Base
        defaultFeeTier: 3000, // Preferred/default 0.3% fee tier
        candidateFeeTiers: [500, 10000], // Optional: narrow/customize probed tiers; defaultFeeTier is always included
        defaultSlippage: 0.5, // 0.5% slippage tolerance
        poolFactoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // Base pool factory
        quoterV2Address: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // QuoterV2 for accurate pricing
      },
    },
  },
  // External-take taker contracts. Required whenever a pool's `take` sets a
  // `liquiditySource` (ONEINCH / UNISWAPV3 / CURVE / LIFI / SUSHI_AGGREGATOR):
  // deploy the keeper router + per-provider takers (see production_setup_guide.md)
  // and fill these in. The two pools below that enable external takes (ONEINCH,
  // CURVE) reference OneInchAggregator and Curve here.
  takers: {
    router: '0xYourTakerRouterAddress',
    contracts: {
      UniswapV3: '0xYourUniswapV3Taker',
      Curve: '0xYourCurveTaker',
      OneInchAggregator: '0xYourOneInchAggregatorTaker',
      Lifi: '0xYourLifiTaker',
    },
  },
  pricing: {
    coinGeckoApiKey: process.env.COINGECKO_API_KEY,
  },
  rewards: {
    defaultLpReward: {
      redeemFirst: TokenToCollect.QUOTE,
      minAmountQuote: 0.001,
      minAmountCollateral: 0.001,
      rewardActionQuote: {
        action: RewardActionLabel.EXCHANGE,
        address: '0xquoteTokenAddress', // token address of the quote token being swapped
        targetToken: 'weth',
        slippage: 1,
        dexProvider: PostAuctionDex.UNISWAP_V3,
        fee: FeeAmount.LOW,
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

          // External Takes Example - uncomment and configure after contract deployment
          // liquiditySource: LiquiditySource.ONEINCH,      // Use 1inch (requires takers.router + takers.contracts.OneInchAggregator)
          // liquiditySource: LiquiditySource.UNISWAPV3,    // Use Uniswap V3 (requires takers.router)
          // liquiditySource: LiquiditySource.CURVE,    // Use Curve (requires takers.router)
          // liquiditySource: LiquiditySource.LIFI,         // Use LI.FI same-chain aggregation
          // Requires takers.router, takers.contracts.Lifi, production dex.lifi allowlists, and LI.FI production gates.
          // marketPriceFactor: 0.98,                       // Take when auction < market * 0.98
          // allowSubsidy: false,                           // Default: require route-derived repayment + gas/profit coverage
        },
        collectBond: true,
        collectLpReward: {
          redeemFirst: TokenToCollect.QUOTE,
          minAmountQuote: 0.001,
          minAmountCollateral: 1000,
          rewardActionQuote: {
            action: RewardActionLabel.EXCHANGE,
            address: '0xaddressOfWstETH',
            targetToken: 'weth',
            slippage: 1,
            dexProvider: PostAuctionDex.UNISWAP_V3, // Options: ONEINCH, UNISWAP_V3, CURVE
            fee: FeeAmount.LOW,
          },
        },
        // Settlement configuration - handles completed auctions and bad debt
        settlement: {
          enabled: true, // Enable automatic settlement
          minAuctionAge: 18000, // Wait 5 hours before settling (18000 seconds)
          maxBucketDepth: 50, // Process up to 50 buckets per settlement call
          maxIterations: 10, // Maximum settlement iterations per auction
          checkBotIncentive: true, // Only settle auctions this bot kicked (has bond rewards)
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

          // Example external take configuration for major pool
          // liquiditySource: LiquiditySource.ONEINCH,     // 1inch aggregator path
          // liquiditySource: LiquiditySource.LIFI,        // LI.FI aggregator path after production canary/fork gates
          // liquiditySource: LiquiditySource.CURVE,    // Use Curve (requires takers.router)
          // marketPriceFactor: 0.99,  // More conservative for volatile pairs
          // allowSubsidy: false,      // Set true only for reviewed defensive pools
        },
        collectBond: true,
        // Example of a per-pool override on top of `defaultLpReward`.
        // Only `redeemFirst` and `rewardActionCollateral` diverge from the
        // default; `minAmountQuote`, `minAmountCollateral`, and
        // `rewardActionQuote` fall through to the chain-wide default.
        collectLpReward: {
          redeemFirst: TokenToCollect.COLLATERAL,
          rewardActionCollateral: {
            action: RewardActionLabel.TRANSFER,
            to: '0x0000000000000000000000000000000000000000',
          },
        },
        // Settlement disabled for this pool - bonds may be locked longer
        // settlement: {
        //   enabled: false,
        // },
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
      },
      {
        name: 'savUSD / USDC',
        address: '0x936e0fdec18d4dc5055b3e091fa063bc75d6215c',
        price: {
          source: PriceOriginSource.FIXED,
          value: 1.01,
        },
        kick: {
          enabled: true,
          minDebt: 0.07,
          priceFactor: 0.99,
        },
        take: {
          minCollateral: 0.07,
          hpbPriceFactor: 0.98,

          // Stable pair external take example - multiple options
          liquiditySource: LiquiditySource.ONEINCH, // 1inch for aggregation
          // liquiditySource: LiquiditySource.LIFI,      // LI.FI for reviewed same-chain aggregation; external-take only, not LP rewards
          // liquiditySource: LiquiditySource.CURVE,    // Use Curve (requires takers.router)
          marketPriceFactor: 0.98, // Stable pairs can be more aggressive
          allowSubsidy: false,
        },
        collectBond: true,
        collectLpReward: {
          redeemFirst: TokenToCollect.QUOTE,
          minAmountQuote: 0.001,
          minAmountCollateral: 0.05,
          rewardActionCollateral: {
            action: RewardActionLabel.EXCHANGE,
            address: '0x06d47F3fb376649c3A9Dafe069B3D6E35572219E',
            targetToken: 'usdc',
            slippage: 1,
            dexProvider: PostAuctionDex.ONEINCH, // Options: ONEINCH, UNISWAP_V3, CURVE
          },
        },
        // Settlement with longer wait time for stable pools
        settlement: {
          enabled: true,
          minAuctionAge: 18000, // Wait 5 hours for stable pools
          maxBucketDepth: 100, // Process more buckets for stable pools
          maxIterations: 5, // Fewer iterations expected for stable pools
          checkBotIncentive: false, // Settle ANY auction for pool health
        },
      },
      {
        name: 'Example Curve Pool',
        address: '0x[example-pool-address]',
        price: {
          source: PriceOriginSource.FIXED,
          value: 1.0,
        },
        kick: {
          enabled: true,
          minDebt: 0.1,
          priceFactor: 0.99,
        },
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.95,

          // Curve external take configuration
          liquiditySource: LiquiditySource.CURVE,
          marketPriceFactor: 0.99, // Take when auction < market * 0.99
          allowSubsidy: false,
        },
        collectBond: true,
        collectLpReward: {
          redeemFirst: TokenToCollect.COLLATERAL,
          minAmountQuote: 0.001,
          minAmountCollateral: 0.001,
          rewardActionCollateral: {
            action: RewardActionLabel.EXCHANGE,
            address: '0x[collateral-token-address]',
            targetToken: 'usdc',
            slippage: 10,
            dexProvider: PostAuctionDex.CURVE,
            fee: FeeAmount.LOW, // 0.05% fee tier
          },
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
