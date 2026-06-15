import 'dotenv/config';
import { KeeperConfig, LiquiditySource } from '../src/config';

// Example Base config that enables ALL THREE external-take paths
// (oneinch + factory + lifi) for the env-gated `npm run hybrid-fork-loop`
// harness and the LI.FI canaries.
//
// The `dex.lifi` allowlist below was determined empirically from the live
// LI.FI API for Base WETH/USDC same-chain quotes (`GET https://li.quest/v1/quote`,
// fromChain=toChain=8453, denyBridges=all, allowDestinationCall=false):
//   - transactionRequest.to / estimate.approvalAddress are always the canonical
//     LI.FI Diamond 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE.
//   - the executable selector is always 0x5fd9ae2e (LI.FI fee-collection+swap
//     facet), regardless of the underlying exchange tool.
//   - the underlying exchange tool varies (sushiswap / nordstern / fly, ...);
//     since the keeper sends `allowExchanges` as a constraint to li.quest, the
//     returned tool is always within this list.
// Re-confirm with `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true npm run lifi-route-canary -- --config <this file>`
// before relying on it; LI.FI rotates facets and may add exchanges over time.
//
// NOTE: `takers.*` addresses below are PLACEHOLDERS. The hybrid-fork-loop harness
// deploys fresh factory + takers on the fork and overrides these at runtime, and
// the route-shape canary is no-broadcast. For real production use, replace them
// with your deployed contract addresses and run the production enablement gates.

const LIFI_DIAMOND_BASE = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const LIFI_FEE_COLLECTION_SWAP_SELECTOR = '0x5fd9ae2e';

const config: KeeperConfig = {
  network: {
    rpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    subgraph: {
      // The hybrid-fork-loop harness monkey-patches subgraph reads to the fork
      // pool; this sentinel guarantees a loud DNS failure if anything bypasses it.
      url: 'http://hybrid-fork.invalid',
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
    // Placeholder — the fork harness uses an in-process random wallet.
    keystore: '/path/to/your/keystore.json',
  },
  runtime: {
    dryRun: true,
    logLevel: 'debug',
    delayBetweenRuns: 30,
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
  pricing: {
    coinGeckoApiKey: process.env.COINGECKO_API_KEY,
  },
  dex: {
    oneInch: {
      routers: {
        8453: '0x1111111254EEB25477B68fb85Ed929f73A960582',
      },
    },
    uniswapV3: {
      router: {
        swapRouter02Address: '0x2626664c2603336E57B271c5C0b26F421741e481',
        wethAddress: '0x4200000000000000000000000000000000000006',
        poolFactoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
        quoterV2Address: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
        defaultFeeTier: 3000,
        defaultSlippage: 0.5,
      },
    },
    lifi: {
      mode: 'production',
      defaultSlippage: 0.005,
      feeCostPolicy: 'included_only',
      allowExchanges: ['sushiswap', 'nordstern', 'fly'],
      callTargetAllowlist: {
        8453: [LIFI_DIAMOND_BASE],
      },
      approvalSpenderAllowlist: {
        8453: [LIFI_DIAMOND_BASE],
      },
      selectorAllowlist: {
        8453: {
          [LIFI_DIAMOND_BASE]: [LIFI_FEE_COLLECTION_SWAP_SELECTOR],
        },
      },
    },
  },
  takers: {
    // Placeholders — the hybrid-fork-loop harness deploys + registers fresh
    // contracts on the fork and overrides keeperTakerRouter/taker contracts
    // at runtime. Replace with deployed addresses for real production use.
    router: '0x0000000000000000000000000000000000000F00',
    contracts: {
      OneInchAggregator: '0x0000000000000000000000000000000000000F01',
      UniswapV3: '0x0000000000000000000000000000000000000F02',
      Lifi: '0x0000000000000000000000000000000000000F03',
    },
  },
  discovery: {
    enabled: true,
    take: {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch', 'lifi'],
      externalTakeRouteSelectionMode: 'maximize_profit',
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      validateRouteDeployments: true,
      dexGasOverrides: { [LiquiditySource.LIFI]: '900000' },
      maxGasCostNative: 0.05,
    },
    defaults: {
      take: {
        liquiditySource: LiquiditySource.UNISWAPV3,
        marketPriceFactor: 0.99,
        minCollateral: 0.0001,
      },
    },
  },
  manual: {
    pools: [],
  },
};

export default config;
