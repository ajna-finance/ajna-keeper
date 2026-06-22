import 'dotenv/config';
import {
  KeeperConfig,
  RewardActionLabel,
  PriceOriginSource,
  TokenToCollect,
  LiquiditySource, // Import for external takes
  PostAuctionDex, // NEW: Import for LP reward swaps
} from '../src/config';
import { FeeAmount } from '@uniswap/v3-sdk';

const config: KeeperConfig = {
  network: {
    rpcUrl: `https://avax-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    subgraph: {
      url: `https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/YOUR_AVALANCHE_SUBGRAPH_ID`,
    },
    multicall: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      block: 11907934,
    },
    tokenAddresses: {
      avax: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // Native AVAX
      wavax: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // Wrapped AVAX
      usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // USDC on Avalanche
      savusd: '0x06d47F3fb376649c3A9Dafe069B3D6E35572219E', // savUSD on Avalanche
      usd_t1: '0x9a522edA6e9420CD15143b1610193E6a657A7dBd', // Your USD_T1 token
      usd_t2: '0xAD47a9b2Bc081D074EC25A0953DDC11E650b1784', // Your USD_T2 token
    },
  },
  signer: {
    keystore: '/path/to/your/keystore.json',
  },
  runtime: {
    dryRun: false,
    logLevel: 'debug',
    delayBetweenRuns: 15,
  },
  dex: {
    oneInch: {
      routers: {
        43114: '0x111111125421ca6dc452d289314280a0f8842a65', // Avalanche
      },
      connectorTokens: [
        '0x24de8771bc5ddb3362db529fc3358f2df3a0e346',
        '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
        '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
        '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
      ],
      // REQUIRED for the live ONEINCH external take below (runtime.dryRun is
      // false): without this production allowlist policy the take is rejected
      // and the factory deploy refuses to provision the taker. The 1inch router
      // is the call target + approval spender; supply the reviewed selector(s).
      callTargetAllowlist: { 43114: ['0x111111125421ca6dc452d289314280a0f8842a65'] },
      approvalSpenderAllowlist: { 43114: ['0x111111125421ca6dc452d289314280a0f8842a65'] },
      selectorAllowlist: {
        43114: { '0x111111125421ca6dc452d289314280a0f8842a65': ['0x[reviewed-selector]'] },
      },
    },
    uniswapV3: {
      router: {
        swapRouter02Address: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE', // Avalanche SwapRouter02 for direct DEX external takes
        wethAddress: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // wrapped AVAX as intermediary token
        defaultFeeTier: 3000, // 0.3% as default for this chain
        defaultSlippage: 0.5, // 0.5% as default slippage
        poolFactoryAddress: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
        quoterV2Address: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
      },
      // REQUIRED for UNISWAP_V3 LP-reward swaps: the reward action below uses
      // PostAuctionDex.UNISWAP_V3, which fails closed at reward time without a
      // universalRouter block. Supply your chain's Universal Router address.
      universalRouter: {
        universalRouterAddress: '0x[your-chain-universal-router-address]',
        permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', // canonical Permit2 (same on all chains)
        wethAddress: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
        poolFactoryAddress: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
        quoterV2Address: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
        defaultFeeTier: 3000,
        defaultSlippage: 0.5,
      },
    },
  },
  takers: {
    router: '0x[DEPLOY_WITH_deploy-factory-system.ts]',
    contracts: {
      OneInchAggregator: '0x[DEPLOYED_ONEINCH_AGGREGATOR_TAKER_ADDRESS]',
    },
  },
  pricing: {
    coinGeckoApiKey: process.env.COINGECKO_API_KEY,
  },
  ajna: {
    erc20PoolFactory: '0x2aA2A6e6B4b20f496A4Ed65566a6FD13b1b8A17A',
    erc721PoolFactory: '0xB3d773147A086A23fB72dcc03828C66DcE5D6627',
    poolUtils: '0x9e407019C07b50e8D7C2d0E2F796C4eCb0F485b3',
    positionManager: '0x0bf183a32614b3Cd11C0268441D96047D05967e0',
    ajnaToken: '0xE055Ee581c637C419e55B8d5fFBA84375546f70f',
    grantFund: '',
    burnWrapper: '',
    lenderHelper: '',
  },
  manual: {
    pools: [
      {
        name: 'savusd / usdc',
        address: '0x936e0fdec18d4dc5055b3e091fa063bc75d6215c',
        price: {
          source: PriceOriginSource.FIXED,
          value: 1.04,
        },
        kick: {
          enabled: true,
          minDebt: 0.07,
          priceFactor: 0.99,
        },
        take: {
          minCollateral: 0.07,
          hpbPriceFactor: 0.9,

          // External Takes via 1inch (requires takers.router and takers.contracts.OneInchAggregator)
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.98, // Take when auction price < market * 0.98
          allowSubsidy: false,
        },
        collectBond: true,
        collectLpReward: {
          redeemFirst: TokenToCollect.QUOTE,
          minAmountQuote: 0.01, // don't redeem LP for less than a penny
          minAmountCollateral: 0.05, // don't redeem LP for less than what it may cost to swap collateral for USDC
          rewardActionCollateral: {
            action: RewardActionLabel.EXCHANGE,
            address: '0x06d47F3fb376649c3A9Dafe069B3D6E35572219E', // Token to swap (savUSD)
            targetToken: 'usdc', // Target token (USDC)
            slippage: 1, // Slippage percentage (0-100)
            dexProvider: PostAuctionDex.ONEINCH, // NEW: Use enum instead of useOneInch: true
          },
        },
        // Settlement configuration for stable pools - conservative settings
        settlement: {
          enabled: true, // Enable settlement
          minAuctionAge: 18000, // Wait 5 hours for stable pools (18000 seconds)
          maxBucketDepth: 100, // Process more buckets for stable pools
          maxIterations: 8, // More iterations may be needed for complex settlements
          checkBotIncentive: false, // Settle even without kicker rewards for stable pools, being altruistic for the pool
        },
      },
      {
        name: 'USD_T1 / USD_T2',
        address: '0x87250b9d571aac691f9a14205ecd2a0259f0bf72',
        price: {
          source: PriceOriginSource.FIXED, // Use fixed price for simpler testing
          value: 0.99, // Static price ratio USD_T1/USD_T2
        },
        kick: {
          enabled: true,
          minDebt: 0.1, // Minimum debt in USD_T2 to kick
          priceFactor: 0.99, // Kick when NP * 0.99 > current price
        },
        take: {
          minCollateral: 0.1, // Enable arbTake when collateral >= 0.1
          hpbPriceFactor: 0.99, // ArbTake when price < hpb * 0.99

          // OPTION: Could also use 1inch for external takes here
          // liquiditySource: LiquiditySource.ONEINCH,
          // marketPriceFactor: 0.98,
          // allowSubsidy: false,
        },
        collectBond: true, // Collect liquidation bonds
        collectLpReward: {
          redeemFirst: TokenToCollect.COLLATERAL, // For kickers, redeem collateral first
          minAmountQuote: 0.001, // Minimum quote to redeem
          minAmountCollateral: 0.001, // Minimum collateral to redeem
          // Configure collateral to use Uniswap V3 to get back quote_token (no external contracts needed for LP rewards)
          rewardActionCollateral: {
            action: RewardActionLabel.EXCHANGE,
            address: '0x9a522edA6e9420CD15143b1610193E6a657A7dBd', // USD_T1
            targetToken: 'usd_t2', // Or keep as USD_T1 if preferred
            slippage: 2,
            dexProvider: PostAuctionDex.UNISWAP_V3, // NEW: Use enum instead of useOneInch: false
            fee: FeeAmount.MEDIUM,
          },
        },
        // Settlement configuration for test tokens - standard settings
        settlement: {
          enabled: true, // Enable settlement
          minAuctionAge: 3600, // Wait 1 hour before settling (3600 seconds)
          maxBucketDepth: 50, // Process 50 buckets per settlement call
          maxIterations: 10, // Max 10 settlement iterations
          checkBotIncentive: true, // Only settle if bot has rewards to claim
        },
      },
    ],
  },
};

export default config;
