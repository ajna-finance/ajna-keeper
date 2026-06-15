// Tier-2 full-loop Base-fork keeper harness.
//
// This is the ONLY test that drives the real keeper discovery loop
// (`handleDiscoveredTakeTarget`) end to end on a fork with ALL external-take
// providers enabled — 1inch + factory (Uniswap/Curve) + LI.FI — so the
// hybrid ranking and fallback are exercised against REAL aggregator routes
// (li.quest + 1inch APIs) and real on-chain DEX liquidity. Every other fork
// test (production-route-selection, live-liquidity-execution, base-cadc-replay,
// lifi-fork-execution-canary) bypasses the discovery loop and disables the
// aggregator paths.
//
// It is env-gated (RUN_HYBRID_FORK_LOOP=true) and skips cleanly otherwise, like
// the other fork canaries, so the default suite never runs it or touches the
// network.
//
// PREREQUISITES (operator-supplied; this CANNOT run without them):
//   - A Base archive RPC: AJNA_AGENT_RPC_URL | AJNA_RPC_URL_BASE | BASE_RPC_URL,
//     or ALCHEMY_API_KEY (resolved by hardhat.config.ts::baseRpcUrl()).
//   - AJNA_AGENT_HYBRID_FORK_CONFIG: path to a reviewed production keeper config
//     that enables all three paths — production `dex.lifi` with Base-keyed
//     callTargetAllowlist/approvalSpenderAllowlist/selectorAllowlist and concrete
//     allowExchanges; `dex.oneInch.routers[8453]`; `dex.uniswapV3.router` (all
//     four Base addresses); `network.tokenAddresses.weth`; and
//     `takers.{factory, oneInch, contracts.{UniswapV3, Lifi}}`.
//   - Base whales (must hold the relevant token at BASE_FORK_BLOCK):
//       AJNA_AGENT_HYBRID_LENDER_WHALE   (holds the pool's quote token)
//       AJNA_AGENT_HYBRID_BORROWER_WHALE (holds the pool's collateral token)
//       AJNA_AGENT_HYBRID_KICKER_WHALE   (optional; defaults to the lender whale)
//
// Defaults target the Base WETH/USDC Ajna pool. The position-construction
// amounts (deposit/borrow/collateral/warp) are economic knobs and will likely
// need tuning for your pinned BASE_FORK_BLOCK so that at least one real route
// clears the keeper's profit floor; the test warps the auction down up to
// AJNA_AGENT_HYBRID_MAX_WARPS times and reports what it finds. Defaults to
// dry-run (the keeper evaluates + ranks all three providers and logs "would
// take" without submitting); set AJNA_AGENT_HYBRID_FORK_LIVE_TAKE=true for a
// real on-chain take with balance-delta assertions.

import { AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { expect } from 'chai';
import { BigNumber, Contract, Wallet, constants, utils } from 'ethers';
import { network } from 'hardhat';
import {
  TakerRouter__factory,
  CurveKeeperTaker__factory,
  OneInchAggregatorKeeperTaker__factory,
  UniswapV3KeeperTaker__factory,
} from '../../typechain-types';
import {
  MockAtomicSwapPool__factory,
  MockPoolDeployer__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { LifiKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import ERC20_ABI from '../../src/abis/erc20.abi.json';
import {
  KeeperConfig,
  LiquiditySource,
  PoolConfig,
  PriceOriginSource,
  configureAjna,
  readConfigFile,
} from '../../src/config';
import { validateAutoDiscoverConfig } from '../../src/config/validation';
import { SECONDS_PER_DAY } from '../../src/constants';
import {
  assertLifiToolsContainFilters,
  fetchLifiQuote,
  fetchLifiTools,
  normalizeLifiExchangeFilters,
  validateLifiQuote,
} from '../../src/dex/lifi';
import { handleDiscoveredTakeTarget } from '../../src/discovery/handlers';
import { createDiscoveryRpcCache } from '../../src/discovery/rpc-cache';
import type { DiscoveredTakeTargetStats } from '../../src/discovery/take-executor';
import { getDiscoveryExecutionConfig } from '../../src/discovery/types';
import { ResolvedTakeTarget } from '../../src/discovery/targets';
import { getLoansToKick } from '../../src/kick';
import { poolKick } from '../../src/transactions';
import { NonceTracker } from '../../src/nonce';
import {
  DiscoveryReadTransports,
  SubgraphReader,
} from '../../src/read-transports';
import { arrayFromAsync, RequireFields, weiToDecimaled } from '../../src/utils';
import { depositQuoteToken, drawDebt } from './loan-helpers';
import {
  makeGetHighestMeaningfulBucket,
  makeGetLiquidationsFromSdk,
  makeGetLoansFromSdk,
  overrideGetHighestMeaningfulBucket,
  overrideGetLiquidations,
  overrideGetLoans,
} from './subgraph-mock';
import {
  getProvider,
  impersonateSigner,
  increaseTime,
  resetHardhat,
  setBalance,
} from './test-utils';
import {
  HYBRID_FORK_CONFIG_ENV,
  HybridForkFixture,
  ProductionLifiDexConfig,
  buildForcedDiscoveryPolicy,
  defaultSourceForHybridPaths,
  getHybridLifiApiKey,
  loadHybridForkFixture,
  optionalHybridEnv,
  requireDefaultHybridLifiApiBaseUrl,
  requireHybridEnv,
  requireProductionLifi,
  shouldRunLifiCallbackProof,
} from './helpers/hybrid-fork-loop-config';

const RUN_HYBRID_FORK_LOOP = process.env.RUN_HYBRID_FORK_LOOP === 'true';
const HYBRID_FORK_TIMEOUT_MS = 900_000;
const BASE_CHAIN_ID = 8453;
const FIXTURE_SUBGRAPH_SENTINEL_URL = 'http://hybrid-fork-loop.invalid';
const BASE_WETH = utils.getAddress(
  '0x4200000000000000000000000000000000000006'
);
const BASE_USDC = utils.getAddress(
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
);
const DEFAULT_LIFI_CALLBACK_PROOF_WETH_AMOUNT_RAW = '1000000000000000';
const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
const LIFI_CALLBACK_PROOF_BORROWER = utils.getAddress(
  '0x00000000000000000000000000000000000000b0'
);
const WETH_ABI = [
  'function deposit() payable',
  'function transfer(address to,uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
];
const QUOTE_TOKEN_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
];

// Ajna's Base mainnet deployment (must match hardhat fork addresses).
const BASE_AJNA_CONFIG = {
  erc20PoolFactory: '0x214f62B5836D83f3D6c4f71F174209097B1A779C',
  erc721PoolFactory: '0xeefEC5d1Cc4bde97279d01D88eFf9e0fEe981769',
  poolUtils: '0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa',
  positionManager: '0x59710a4149A27585f1841b5783ac704a08274e64',
  ajnaToken: '0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47',
  grantFund: '',
  burnWrapper: '',
  lenderHelper: '',
};

function optionalEnv(...names: string[]): string | undefined {
  return optionalHybridEnv(process.env, ...names);
}

function requireConfiguredBaseForkRpc(): void {
  const forkUrl = (network.config as { forking?: { url?: unknown } }).forking
    ?.url;
  if (
    typeof forkUrl !== 'string' ||
    forkUrl.trim().length === 0 ||
    /\b(undefined|null)\b/i.test(forkUrl)
  ) {
    throw new Error(
      'Base fork RPC is required for RUN_HYBRID_FORK_LOOP=true before hardhat_reset; set AJNA_AGENT_RPC_URL, AJNA_RPC_URL_BASE, BASE_RPC_URL, or ALCHEMY_API_KEY for the configured Base fork URL'
    );
  }
}

async function loadHybridKeeperConfig(): Promise<KeeperConfig> {
  const configPath = requireHybridEnv(
    process.env,
    HYBRID_FORK_CONFIG_ENV,
    'path to a reviewed production keeper config enabling oneinch + factory + lifi'
  );
  return readConfigFile(configPath);
}

// Subgraph reader that serves the keeper's discovery loop from the fork pool,
// rather than a real subgraph (mirrors run-fixture-keeper-harness.ts).
function makeFixtureSubgraphReader(
  pool: FungiblePool,
  borrower: string
): SubgraphReader {
  const getLoans = makeGetLoansFromSdk(pool);
  const getLiquidations = makeGetLiquidationsFromSdk(pool);
  return {
    cacheKey: `hybrid-fork:${pool.poolAddress}:${borrower.toLowerCase()}`,
    getLoans(poolAddress) {
      return getLoans(FIXTURE_SUBGRAPH_SENTINEL_URL, poolAddress);
    },
    getLiquidations(poolAddress, minCollateral) {
      return getLiquidations(
        FIXTURE_SUBGRAPH_SENTINEL_URL,
        poolAddress,
        minCollateral
      );
    },
    async getHighestMeaningfulBucket() {
      return { buckets: [] } as never;
    },
    async getUnsettledAuctions() {
      return { liquidationAuctions: [] } as never;
    },
    async getChainwideLiquidationAuctions() {
      return { liquidationAuctions: [] } as never;
    },
    async getBucketTakeLPAwards() {
      return { bucketTakeLPAwards: [] } as never;
    },
    async getSubgraphMeta() {
      return {
        block: { number: 0, timestamp: Math.floor(SECONDS_PER_DAY) },
      } as never;
    },
  };
}

// One router registers all direct DEX and calldata-aggregator takers so every
// provider can win execution, not just compete in ranking.
async function deployHybridFactorySystem(signer: Wallet) {
  const factory = await new TakerRouter__factory(signer).deploy(
    BASE_AJNA_CONFIG.erc20PoolFactory
  );
  await factory.deployed();
  const oneInchTaker = await new OneInchAggregatorKeeperTaker__factory(
    signer
  ).deploy(BASE_AJNA_CONFIG.erc20PoolFactory, factory.address);
  const uniswapTaker = await new UniswapV3KeeperTaker__factory(signer).deploy(
    BASE_AJNA_CONFIG.erc20PoolFactory,
    factory.address
  );
  const curveTaker = await new CurveKeeperTaker__factory(signer).deploy(
    BASE_AJNA_CONFIG.erc20PoolFactory,
    factory.address
  );
  const lifiTaker = await new LifiKeeperTaker__factory(signer).deploy(
    BASE_AJNA_CONFIG.erc20PoolFactory,
    factory.address
  );
  for (const taker of [oneInchTaker, uniswapTaker, curveTaker, lifiTaker]) {
    await taker.deployed();
  }
  await (
    await factory.setTaker(LiquiditySource.ONEINCH, oneInchTaker.address)
  ).wait();
  await (
    await factory.setTaker(LiquiditySource.UNISWAPV3, uniswapTaker.address)
  ).wait();
  await (
    await factory.setTaker(LiquiditySource.CURVE, curveTaker.address)
  ).wait();
  await (
    await factory.setTaker(LiquiditySource.LIFI, lifiTaker.address)
  ).wait();
  return {
    factory,
    oneInchTaker,
    uniswapTaker,
    curveTaker,
    lifiTaker,
  };
}

// Configure the freshly deployed LI.FI taker's on-chain allowlists from the
// reviewed production config (mirrors lifi-fork-execution-canary.test.ts).
async function configureLifiTakerAllowlists(
  taker: Contract,
  lifi: ProductionLifiDexConfig
): Promise<void> {
  const callTargets = lifi.callTargetAllowlist?.[BASE_CHAIN_ID] ?? [];
  const spenders = lifi.approvalSpenderAllowlist?.[BASE_CHAIN_ID] ?? [];
  const selectorsByTarget = lifi.selectorAllowlist?.[BASE_CHAIN_ID] ?? {};
  if (
    callTargets.length === 0 ||
    spenders.length === 0 ||
    Object.keys(selectorsByTarget).length === 0
  ) {
    throw new Error(
      `Reviewed config dex.lifi must define callTargetAllowlist/approvalSpenderAllowlist/selectorAllowlist for chain ${BASE_CHAIN_ID}`
    );
  }
  for (const target of callTargets) {
    await (await taker.setCallTarget(target, true)).wait();
  }
  for (const spender of spenders) {
    await (await taker.setApprovalSpender(spender, true)).wait();
  }
  for (const [target, selectors] of Object.entries(selectorsByTarget)) {
    for (const selector of selectors) {
      await (await taker.setCallSelector(target, selector, true)).wait();
    }
  }
}

function encodeLifiSwapDetails(params: {
  approvalSpender: string;
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amountInTokenUnits: BigNumber;
  amountOutMinimum: BigNumber;
  callData: string;
}): string {
  return utils.defaultAbiCoder.encode(
    [
      'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)',
    ],
    [params]
  );
}

async function runLifiCallbackExecutionProof(params: {
  provider: ReturnType<typeof getProvider>;
  owner: Wallet;
  lifi: ProductionLifiDexConfig;
}): Promise<void> {
  requireDefaultHybridLifiApiBaseUrl(params.lifi.apiBaseUrl);
  const fromToken = utils.getAddress(
    optionalEnv('AJNA_AGENT_HYBRID_LIFI_CALLBACK_FROM_TOKEN') ?? BASE_WETH
  );
  const toToken = utils.getAddress(
    optionalEnv('AJNA_AGENT_HYBRID_LIFI_CALLBACK_TO_TOKEN') ?? BASE_USDC
  );
  if (fromToken.toLowerCase() !== BASE_WETH.toLowerCase()) {
    throw new Error(
      'AJNA_AGENT_HYBRID_LIFI_CALLBACK_FROM_TOKEN currently must be Base WETH so the fork proof can fund the callback source asset locally'
    );
  }
  const fromAmount = BigNumber.from(
    optionalEnv('AJNA_AGENT_HYBRID_LIFI_CALLBACK_FROM_AMOUNT_RAW') ??
      DEFAULT_LIFI_CALLBACK_PROOF_WETH_AMOUNT_RAW
  );
  if (!fromAmount.gt(0)) {
    throw new Error(
      'AJNA_AGENT_HYBRID_LIFI_CALLBACK_FROM_AMOUNT_RAW must be > 0'
    );
  }
  const profitFloorRaw = BigNumber.from(
    optionalEnv('AJNA_AGENT_HYBRID_LIFI_CALLBACK_PROFIT_FLOOR_RAW') ?? '1'
  );
  if (!profitFloorRaw.gt(0)) {
    throw new Error(
      'AJNA_AGENT_HYBRID_LIFI_CALLBACK_PROFIT_FLOOR_RAW must be > 0'
    );
  }

  const pool = await new MockAtomicSwapPool__factory(params.owner).deploy(
    fromToken,
    toToken,
    1
  );
  await pool.deployed();
  const poolDeployer = await new MockPoolDeployer__factory(
    params.owner
  ).deploy();
  await poolDeployer.deployed();
  await poolDeployer.setDeployedPool(
    ERC20_NON_SUBSET_HASH,
    fromToken,
    toToken,
    pool.address
  );
  const factory = await new TakerRouter__factory(
    params.owner
  ).deploy(poolDeployer.address);
  await factory.deployed();
  const taker = await new LifiKeeperTaker__factory(params.owner).deploy(
    poolDeployer.address,
    factory.address
  );
  await taker.deployed();
  await (await factory.setTaker(LiquiditySource.LIFI, taker.address)).wait();

  const takerContract = new Contract(
    taker.address,
    LifiKeeperTaker__factory.abi,
    params.owner
  );
  await configureLifiTakerAllowlists(takerContract, params.lifi);

  const apiKey = getHybridLifiApiKey(params.lifi);
  const toolsResponse = await fetchLifiTools({
    config: params.lifi,
    apiKey,
  });
  assertLifiToolsContainFilters({
    filters: normalizeLifiExchangeFilters(params.lifi),
    toolsResponse,
  });

  const quoteResult = await fetchLifiQuote({
    config: params.lifi,
    apiKey,
    request: {
      chainId: BASE_CHAIN_ID,
      fromToken,
      toToken,
      fromAmount: fromAmount.toString(),
      fromAddress: taker.address,
      toAddress: taker.address,
      slippage: params.lifi.defaultSlippage ?? 0.005,
      maxPriceImpact: params.lifi.maxPriceImpact,
    },
  });
  const approvedQuote = validateLifiQuote({
    quote: quoteResult.data,
    chainId: BASE_CHAIN_ID,
    fromToken,
    toToken,
    fromAmount,
    takerAddress: taker.address,
    allowedExchangeTools: params.lifi.allowExchanges,
    callTargetAllowlist: params.lifi.callTargetAllowlist[BASE_CHAIN_ID],
    approvalSpenderAllowlist:
      params.lifi.approvalSpenderAllowlist[BASE_CHAIN_ID],
    selectorAllowlist: params.lifi.selectorAllowlist[BASE_CHAIN_ID],
    feeCostPolicy: params.lifi.feeCostPolicy,
  });

  const weth = new Contract(fromToken, WETH_ABI, params.owner);
  const quoteToken = new Contract(toToken, QUOTE_TOKEN_ABI, params.owner);
  await weth.deposit({ value: fromAmount });
  await weth.transfer(pool.address, fromAmount);
  expect((await weth.balanceOf(taker.address)).eq(0)).to.equal(true);
  expect((await quoteToken.balanceOf(taker.address)).eq(0)).to.equal(true);

  const quoteAmountDue = approvedQuote.routeMinOutRaw;
  const approvedMinOutRaw = quoteAmountDue.add(profitFloorRaw);
  if (approvedQuote.quoteAmountRaw.lt(approvedMinOutRaw)) {
    throw new Error(
      'hybrid LI.FI callback proof quote cannot satisfy route min-out plus profit floor'
    );
  }
  await pool.setQuoteAmountDue(quoteAmountDue);
  const details = encodeLifiSwapDetails({
    approvalSpender: approvedQuote.approvalSpender,
    srcToken: approvedQuote.srcToken,
    dstToken: approvedQuote.dstToken,
    dstReceiver: approvedQuote.dstReceiver,
    amountInTokenUnits: approvedQuote.amountInTokenUnits,
    amountOutMinimum: approvedMinOutRaw,
    callData: approvedQuote.transactionRequest.data,
  });
  const auctionPriceWad = quoteAmountDue
    .mul(constants.WeiPerEther)
    .add(fromAmount)
    .sub(1)
    .div(fromAmount);

  await factory.takeWithAtomicSwap(
    pool.address,
    LIFI_CALLBACK_PROOF_BORROWER,
    auctionPriceWad,
    fromAmount,
    LiquiditySource.LIFI,
    approvedQuote.transactionTarget,
    details
  );

  expect((await pool.takeCount()).eq(1)).to.equal(true);
  expect(
    (await quoteToken.balanceOf(pool.address)).eq(quoteAmountDue)
  ).to.equal(true);
  expect((await weth.balanceOf(taker.address)).eq(0)).to.equal(true);
  expect((await quoteToken.balanceOf(taker.address)).eq(0)).to.equal(true);
  expect(
    (await weth.allowance(taker.address, approvedQuote.approvalSpender)).eq(0)
  ).to.equal(true);
  expect(
    (await quoteToken.allowance(taker.address, pool.address)).eq(0)
  ).to.equal(true);
  expect(
    (await quoteToken.balanceOf(params.owner.address)).gte(profitFloorRaw)
  ).to.equal(true);
}

function buildKickPoolConfig(
  fixture: HybridForkFixture
): RequireFields<PoolConfig, 'kick' | 'take'> {
  return {
    address: fixture.poolAddress,
    price: { source: PriceOriginSource.FIXED, value: fixture.depositPrice },
    kick: { enabled: true, minDebt: 0, priceFactor: 0.99 },
    take: {
      minCollateral: fixture.minCollateral,
      hpbPriceFactor: 0.9,
      liquiditySource: LiquiditySource.UNISWAPV3,
      marketPriceFactor: fixture.marketPriceFactor,
    },
  } as RequireFields<PoolConfig, 'kick' | 'take'>;
}

async function constructUnderwaterAuction(params: {
  pool: FungiblePool;
  fixture: HybridForkFixture;
}): Promise<void> {
  const { pool, fixture } = params;
  await depositQuoteToken({
    pool,
    owner: fixture.lenderWhale,
    amount: fixture.depositQuoteAmount,
    price: fixture.depositPrice,
  });
  await drawDebt({
    pool,
    owner: fixture.borrowerWhale,
    amountToBorrow: fixture.borrowAmount,
    collateralToPledge: fixture.collateralToPledge,
  });
  await increaseTime(fixture.timeToKick);

  const loansToKick = await arrayFromAsync(
    getLoansToKick({
      pool,
      poolConfig: buildKickPoolConfig(fixture),
      config: { subgraphUrl: '', coinGeckoApiKey: '' },
    })
  );
  expect(
    loansToKick.length,
    'expected at least one kickable loan after interest accrual; tune AJNA_AGENT_HYBRID_BORROW_AMOUNT / COLLATERAL_PLEDGE / TIME_TO_KICK_DAYS'
  ).to.be.greaterThan(0);

  const loanToKick = loansToKick[0];
  const kicker = await impersonateSigner(fixture.kickerWhale);
  await setBalance(fixture.kickerWhale, utils.parseEther('100').toHexString());
  // Approve the liquidation bond and kick directly via poolKick so an on-chain
  // revert surfaces here. The keeper's kick() wrapper catches and swallows the
  // revert (returning normally), which would otherwise leave the harness with no
  // auction and a confusing "loop never ran" failure downstream.
  const quoteToken = new Contract(pool.quoteAddress, ERC20_ABI, kicker);
  await (
    await quoteToken.approve(pool.poolAddress, constants.MaxUint256)
  ).wait();
  await poolKick(pool, kicker, loanToKick.borrower);
  const kickedStatus = await pool
    .getLiquidation(loanToKick.borrower)
    .getStatus();
  expect(
    Number(kickedStatus.kickTime ?? 0) > 0 || kickedStatus.collateral.gt(0),
    'kick did not create an active auction'
  ).to.equal(true);
  await increaseTime(fixture.timeAfterKick);
}

function buildHybridTakeTarget(params: {
  pool: FungiblePool;
  borrower: string;
  fixture: HybridForkFixture;
  kickTime: number;
  collateralWad: BigNumber;
  debtWad: BigNumber;
  neutralPriceWad: BigNumber;
}): ResolvedTakeTarget {
  const collateral = String(weiToDecimaled(params.collateralWad));
  const debt = String(weiToDecimaled(params.debtWad));
  return {
    source: 'discovered',
    poolAddress: params.pool.poolAddress,
    name: 'Hybrid Fork Pool',
    dryRun: !params.fixture.liveTake,
    take: {
      minCollateral: params.fixture.minCollateral,
      liquiditySource: defaultSourceForHybridPaths(params.fixture.paths),
      marketPriceFactor: params.fixture.marketPriceFactor,
    },
    candidates: [
      {
        poolAddress: params.pool.poolAddress,
        borrower: params.borrower,
        kickTime: Number.isFinite(params.kickTime) ? params.kickTime : 0,
        debtRemaining: debt,
        collateralRemaining: collateral,
        neutralPrice: String(weiToDecimaled(params.neutralPriceWad)),
        debt,
        collateral,
        heuristicScore: 0,
      },
    ],
  };
}

function summarizeProviderOutcome(stats: DiscoveredTakeTargetStats): string {
  return JSON.stringify(
    {
      candidateCount: stats.candidateCount,
      externalTakeByPath: stats.externalTakeByPath,
      hybridFallbackAttempts: stats.hybridFallbackAttempts,
      hybridFallbackSuccesses: stats.hybridFallbackSuccesses,
    },
    null,
    2
  );
}

describe('Hybrid Base-fork discovery loop (oneinch + factory + lifi)', function () {
  this.timeout(HYBRID_FORK_TIMEOUT_MS);

  before(async function () {
    if (!RUN_HYBRID_FORK_LOOP) {
      this.skip();
    }
    if (network.name !== 'hardhat') {
      throw new Error('hybrid fork loop must run on the hardhat network');
    }
    if ((process.env.FORK_NETWORK ?? 'mainnet') !== 'base') {
      throw new Error('hybrid fork loop currently requires FORK_NETWORK=base');
    }
    if (Number(process.env.HARDHAT_CHAIN_ID ?? '31337') !== BASE_CHAIN_ID) {
      throw new Error('hybrid fork loop requires HARDHAT_CHAIN_ID=8453');
    }
    requireConfiguredBaseForkRpc();
    // Fail fast if the reviewed config cannot support all three paths.
    const keeperConfig = await loadHybridKeeperConfig();
    const fixture = loadHybridForkFixture();
    validateAutoDiscoverConfig(
      { ...keeperConfig, discovery: buildForcedDiscoveryPolicy(fixture) },
      BASE_CHAIN_ID
    );
    await resetHardhat();
  });

  beforeEach(async () => {
    await resetHardhat();
    NonceTracker.clearNonces();
  });

  it('runs handleDiscoveredTakeTarget with all three providers competing on real routes', async function () {
    const keeperConfig = await loadHybridKeeperConfig();
    const fixture = loadHybridForkFixture();
    if (!keeperConfig.dex?.lifi) {
      throw new Error('reviewed config must define dex.lifi');
    }
    const lifi = requireProductionLifi(keeperConfig.dex.lifi);

    const provider = getProvider();
    const signer = Wallet.createRandom().connect(provider);
    await setBalance(signer.address, utils.parseEther('100').toHexString());

    configureAjna(BASE_AJNA_CONFIG as never);
    const pool = await new AjnaSDK(
      provider
    ).fungiblePoolFactory.getPoolByAddress(fixture.poolAddress);
    // Serve the discovery loop from the fork pool, not a real subgraph.
    overrideGetLoans(makeGetLoansFromSdk(pool));
    overrideGetLiquidations(makeGetLiquidationsFromSdk(pool));
    overrideGetHighestMeaningfulBucket(makeGetHighestMeaningfulBucket(pool));

    const { factory, oneInchTaker, uniswapTaker, curveTaker, lifiTaker } =
      await deployHybridFactorySystem(signer);
    await configureLifiTakerAllowlists(
      new Contract(lifiTaker.address, LifiKeeperTaker__factory.abi, signer),
      lifi
    );
    if (shouldRunLifiCallbackProof(fixture)) {
      await runLifiCallbackExecutionProof({ provider, owner: signer, lifi });
    }

    await constructUnderwaterAuction({ pool, fixture });

    // Build the discovery execution config from the reviewed config, but force
    // the all-three-paths policy and point at the freshly deployed factory.
    const execBase = getDiscoveryExecutionConfig({
      ...keeperConfig,
      discovery: buildForcedDiscoveryPolicy(fixture),
    });
    const readRpc = { getGasPrice: () => provider.getGasPrice() };
    const transports: DiscoveryReadTransports = {
      subgraph: makeFixtureSubgraphReader(pool, fixture.borrowerWhale),
      readRpc,
    };

    const quoteToken = new Contract(pool.quoteAddress, ERC20_ABI, provider);
    const ownerQuoteBefore: BigNumber = await quoteToken.balanceOf(
      signer.address
    );
    const collateralBefore: BigNumber = (
      await pool.getLiquidation(fixture.borrowerWhale).getStatus()
    ).collateral;

    // Warp the dutch auction down until a route clears (or maxWarps reached).
    let stats: DiscoveredTakeTargetStats | undefined;
    let executed = false;
    for (let attempt = 0; attempt <= fixture.maxWarps; attempt += 1) {
      const status = await pool
        .getLiquidation(fixture.borrowerWhale)
        .getStatus();
      if (!status.collateral.gt(0)) {
        break;
      }
      // Fresh rpcCache per attempt; deliberately do NOT force-open the 1inch
      // circuit (unlike run-fixture-keeper-harness) so real 1inch routes compete.
      const rpcCache = await createDiscoveryRpcCache({
        signer,
        readRpc,
        includeFactoryQuoteProviders: true,
      });
      stats = await handleDiscoveredTakeTarget({
        pool,
        signer,
        transports,
        rpcCache,
        target: buildHybridTakeTarget({
          pool,
          borrower: fixture.borrowerWhale,
          fixture,
          kickTime: Math.floor(Number(status.kickTime ?? 0)),
          collateralWad: status.collateral,
          debtWad: status.debtToCover ?? BigNumber.from(0),
          neutralPriceWad: status.neutralPrice ?? BigNumber.from(0),
        }),
        config: {
          ...execBase,
          dryRun: !fixture.liveTake,
          keeperTakerRouter: factory.address,
          oneInchAggregatorTaker: oneInchTaker.address,
          lifiTaker: lifiTaker.address,
          takerContracts: {
            ...execBase.takerContracts,
            OneInchAggregator: oneInchTaker.address,
            Lifi: lifiTaker.address,
            UniswapV3: uniswapTaker.address,
            Curve: curveTaker.address,
          },
        },
      });
      const executedNow =
        (stats.executedExternalTakes ?? 0) > 0 ||
        (stats.dryRunExternalTakes ?? 0) > 0;
      // eslint-disable-next-line no-console
      console.log(
        `[hybrid-fork-loop] attempt ${attempt} auctionPrice=${weiToDecimaled(
          status.price
        )} -> ${summarizeProviderOutcome(stats)}`
      );
      if (executedNow) {
        executed = true;
        break;
      }
      await increaseTime(fixture.warpSeconds);
    }

    expect(
      stats,
      'expected the discovery loop to run at least once'
    ).to.not.equal(undefined);
    expect(
      executed,
      'no external take path became takeable within AJNA_AGENT_HYBRID_MAX_WARPS; tune deposit/borrow/warp economics for your fork block'
    ).to.equal(true);

    if (fixture.liveTake) {
      // A real take executed: auction collateral fell and the keeper did not
      // lose quote token (it earned at least the enforced profit floor).
      const after = await pool
        .getLiquidation(fixture.borrowerWhale)
        .getStatus();
      expect(
        after.collateral.lt(collateralBefore),
        'expected the live take to reduce auction collateral'
      ).to.equal(true);
      const ownerQuoteAfter: BigNumber = await quoteToken.balanceOf(
        signer.address
      );
      expect(ownerQuoteAfter.gte(ownerQuoteBefore)).to.equal(true);
      // No residual LI.FI taker collateral allowance after a successful take
      // (only meaningful if the winning route was LI.FI; harmless otherwise).
      const collateralToken = new Contract(
        pool.collateralAddress,
        ERC20_ABI,
        provider
      );
      for (const spender of lifi.approvalSpenderAllowlist?.[BASE_CHAIN_ID] ??
        []) {
        expect(
          (await collateralToken.allowance(lifiTaker.address, spender)).eq(0)
        ).to.equal(true);
      }
    }
  });
});
