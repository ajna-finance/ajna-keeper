import 'dotenv/config';
import {
  KeeperConfig,
  PriceOriginPoolReference,
  PriceOriginSource,
  TokenToCollect,
} from './src/config-types';

const config: KeeperConfig = {
  // Keep the existing manual keeper behavior live.
  // Newly discovered pools stay dry-run until autoDiscover.dryRunNewPools is removed.
  dryRun: false,
  logLevel: 'info',

  ethRpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  // Optional: route take tx submission through a dedicated private/write RPC.
  // Kick, settlement, LP, and bond flows continue using ethRpcUrl until write transport
  // hardening is expanded beyond take.
  // takeWrite: {
  //   mode: 'private_rpc',
  //   rpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_PRIVATE_TX_KEY}`,
  // },
  // Or route take submission through a JSON-RPC private relay.
  // takeWrite: {
  //   mode: 'relay',
  //   relay: {
  //     url: process.env.BASE_PRIVATE_RELAY_URL!,
  //     sendMethod: 'eth_sendPrivateTransaction',
  //     maxBlockNumberOffset: 25,
  //   },
  // },
  subgraphUrl: `https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/9npza28cZyi8R94SJjm9Y3fuWeBZZK4CHr2r8NCvsr98`,
  keeperKeystore: '/path/to/your/keystore.json',

  multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  multicallBlock: 5022,

  // Conservative cadence for a first rollout.
  delayBetweenRuns: 45,
  delayBetweenActions: 3,

  tokenAddresses: {
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
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

  coinGeckoApiKey: process.env.COINGECKO_API_KEY,

  autoDiscover: {
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

  discoveredDefaults: {
    take: {
      // First rollout: arb-take only for discovered pools.
      // Add liquiditySource + marketPriceFactor later if you want discovered external takes.
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
};

export default config;
