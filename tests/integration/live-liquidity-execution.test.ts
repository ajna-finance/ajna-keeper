import { AjnaSDK, FungiblePool, Provider } from '@ajna-finance/sdk';
import { expect } from 'chai';
import { BigNumber, Contract, utils, Wallet } from 'ethers';
import {
  AjnaKeeperTakerFactory__factory,
  CurveKeeperTaker__factory,
  SushiSwapKeeperTaker__factory,
  UniswapV3KeeperTaker__factory,
} from '../../typechain-types';
import ERC20_ABI from '../../src/abis/erc20.abi.json';
import {
  configureAjna,
  LiquiditySource,
  PoolConfig,
  UniversalRouterOverrides,
} from '../../src/config';
import { SECONDS_PER_DAY } from '../../src/constants';
import { getLoansToKick, kick } from '../../src/kick';
import { NonceTracker } from '../../src/nonce';
import {
  createFactoryQuoteProviderRuntimeCache,
  getFactoryTakeQuoteEvaluation,
  takeLiquidationFactory,
} from '../../src/take/factory';
import {
  filterFactoryRouteCandidatesByAvailability,
  getFactoryRouteCandidates,
} from '../../src/take/factory/shared';
import { EXTERNAL_TAKE_REJECTION_REASONS } from '../../src/take/external-take-policy';
import { TakeLiquidationPlan } from '../../src/take/types';
import { arrayFromAsync, RequireFields, weiToDecimaled } from '../../src/utils';
import { depositQuoteToken, drawDebt } from './loan-helpers';
import './subgraph-mock';
import {
  makeGetHighestMeaningfulBucket,
  makeGetLiquidationsFromSdk,
  makeGetLoansFromSdk,
  overrideGetHighestMeaningfulBucket,
  overrideGetLiquidations,
  overrideGetLoans,
} from './subgraph-mock';
import { MAINNET_CONFIG, USER1_MNEMONIC } from './test-config';
import {
  getProvider,
  impersonateSigner,
  increaseTime,
  resetHardhat,
  setBalance,
} from './test-utils';

const RUN_LIVE_LIQUIDITY_E2E = process.env.RUN_LIVE_LIQUIDITY_E2E === 'true';
const LIVE_LIQUIDITY_TIMEOUT_MS = 300_000;

interface LiveLiquidityFixture {
  name: string;
  forkNetwork: 'mainnet';
  poolConfig: RequireFields<PoolConfig, 'kick' | 'take'>;
  borrower: string;
  lender: string;
  kicker: string;
  depositQuoteAmount: number;
  depositPrice: number;
  borrowAmount: number;
  collateralToPledge: number;
  timeToKick: number;
  timeAfterKick: number;
  quoteToken: string;
  uniswap: UniversalRouterOverrides;
  routeQuoteBudgetPerCandidate?: number;
  minimumAvailableUniswapRoutes?: number;
}

const MAINNET_UNISWAP_SOL_WETH_FIXTURE: LiveLiquidityFixture = {
  name: 'mainnet SOL/WETH Ajna take through real Uniswap V3 liquidity',
  forkNetwork: 'mainnet',
  poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
  borrower: MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress,
  lender: MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress,
  kicker: MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2,
  depositQuoteAmount: 1,
  depositPrice: 0.07,
  borrowAmount: 0.9,
  collateralToPledge: 14,
  timeToKick: SECONDS_PER_DAY * 365 * 2,
  timeAfterKick: SECONDS_PER_DAY,
  quoteToken: MAINNET_CONFIG.SOL_WETH_POOL.quoteAddress,
  uniswap: {
    // Pinned for the mainnet fork block used by MAINNET_CONFIG.BLOCK_NUMBER.
    universalRouterAddress: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    poolFactoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoterV2Address: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    wethAddress: MAINNET_CONFIG.WETH_ADDRESS,
    defaultFeeTier: 3000,
    candidateFeeTiers: [3000],
    defaultSlippage: 1.0,
  },
};

const MAINNET_UNISWAP_SOL_WETH_AUTOPROBE_FIXTURE: LiveLiquidityFixture = {
  ...MAINNET_UNISWAP_SOL_WETH_FIXTURE,
  name: 'mainnet SOL/WETH Ajna take with automatic Uniswap V3 fee-tier probing',
  uniswap: {
    ...MAINNET_UNISWAP_SOL_WETH_FIXTURE.uniswap,
    candidateFeeTiers: undefined,
  },
  routeQuoteBudgetPerCandidate: 4,
  minimumAvailableUniswapRoutes: 2,
};

async function getAjnaPool(
  provider: Provider,
  fixture: LiveLiquidityFixture
): Promise<FungiblePool> {
  configureAjna(MAINNET_CONFIG.AJNA_CONFIG);
  const ajna = new AjnaSDK(provider);
  const pool = await ajna.fungiblePoolFactory.getPoolByAddress(
    fixture.poolConfig.address
  );
  overrideGetLoans(makeGetLoansFromSdk(pool));
  overrideGetLiquidations(makeGetLiquidationsFromSdk(pool));
  overrideGetHighestMeaningfulBucket(makeGetHighestMeaningfulBucket(pool));
  return pool;
}

async function deployFactorySystem(signer: Wallet) {
  const factory = await new AjnaKeeperTakerFactory__factory(signer).deploy(
    MAINNET_CONFIG.AJNA_CONFIG.erc20PoolFactory
  );
  await factory.deployed();

  const uniswapTaker = await new UniswapV3KeeperTaker__factory(signer).deploy(
    MAINNET_CONFIG.AJNA_CONFIG.erc20PoolFactory,
    factory.address
  );
  await uniswapTaker.deployed();

  const sushiTaker = await new SushiSwapKeeperTaker__factory(signer).deploy(
    MAINNET_CONFIG.AJNA_CONFIG.erc20PoolFactory,
    factory.address
  );
  await sushiTaker.deployed();

  const curveTaker = await new CurveKeeperTaker__factory(signer).deploy(
    MAINNET_CONFIG.AJNA_CONFIG.erc20PoolFactory,
    factory.address
  );
  await curveTaker.deployed();

  await factory.setTaker(LiquiditySource.UNISWAPV3, uniswapTaker.address);
  await factory.setTaker(LiquiditySource.SUSHISWAP, sushiTaker.address);
  await factory.setTaker(LiquiditySource.CURVE, curveTaker.address);

  return {
    factory,
    uniswapTaker,
    sushiTaker,
    curveTaker,
  };
}

async function createLiveAjnaLiquidation(params: {
  pool: FungiblePool;
  fixture: LiveLiquidityFixture;
}) {
  const { pool, fixture } = params;
  await depositQuoteToken({
    pool,
    owner: fixture.lender,
    amount: fixture.depositQuoteAmount,
    price: fixture.depositPrice,
  });
  await drawDebt({
    pool,
    owner: fixture.borrower,
    amountToBorrow: fixture.borrowAmount,
    collateralToPledge: fixture.collateralToPledge,
  });
  await increaseTime(fixture.timeToKick);

  const loansToKick = await arrayFromAsync(
    getLoansToKick({
      pool,
      poolConfig: fixture.poolConfig,
      config: { subgraphUrl: '', coinGeckoApiKey: '' },
    })
  );
  expect(
    loansToKick.length,
    'expected at least one kickable loan'
  ).to.be.greaterThan(0);

  const kickSigner = await impersonateSigner(fixture.kicker);
  await setBalance(fixture.kicker, utils.parseEther('100').toHexString());
  await kick({
    pool,
    signer: kickSigner,
    loanToKick: loansToKick[0],
    config: { dryRun: false },
  });

  await increaseTime(fixture.timeAfterKick);
}

async function buildLiveFactoryLiquidationPlan(params: {
  pool: FungiblePool;
  borrower: string;
  quoteEvaluation: TakeLiquidationPlan['externalTakeQuoteEvaluation'];
}): Promise<TakeLiquidationPlan> {
  const liquidationStatus = await params.pool
    .getLiquidation(params.borrower)
    .getStatus();
  const { hpbIndex } = await params.pool.getPrices();

  return {
    borrower: params.borrower,
    hpbIndex,
    collateral: liquidationStatus.collateral,
    auctionPrice: liquidationStatus.price,
    isTakeable: true,
    isArbTakeable: false,
    externalTakeQuoteEvaluation: params.quoteEvaluation,
  };
}

function buildLiveUniswapPoolConfig(
  fixture: LiveLiquidityFixture,
  marketPriceFactor: number
) {
  return {
    ...fixture.poolConfig,
    take: {
      minCollateral: 1e-8,
      liquiditySource: LiquiditySource.UNISWAPV3,
      marketPriceFactor,
    },
  };
}

async function expectLiveUniswapRoutesAvailable(params: {
  fixture: LiveLiquidityFixture;
  pool: FungiblePool;
  signer: Wallet;
  runtimeCache: ReturnType<typeof createFactoryQuoteProviderRuntimeCache>;
}) {
  const minimumAvailableRoutes =
    params.fixture.minimumAvailableUniswapRoutes ?? 1;
  const routes = getFactoryRouteCandidates({
    defaultLiquiditySource: LiquiditySource.UNISWAPV3,
    config: {
      universalRouterOverrides: params.fixture.uniswap,
    },
  });
  expect(
    routes.length,
    'expected configured Uniswap route candidates'
  ).to.be.greaterThan(0);

  const { availableRoutes } =
    await filterFactoryRouteCandidatesByAvailability({
      routes,
      pool: params.pool,
      signer: params.signer,
      config: {
        universalRouterOverrides: params.fixture.uniswap,
      },
      runtimeCache: params.runtimeCache,
    });

  expect(
    availableRoutes.length,
    `expected at least ${minimumAvailableRoutes} initialized real Uniswap V3 pool(s)`
  ).to.be.at.least(minimumAvailableRoutes);
}

async function executeLiveUniswapFixture(fixture: LiveLiquidityFixture) {
  const provider = getProvider();
  expect(await provider.getBlockNumber()).to.equal(MAINNET_CONFIG.BLOCK_NUMBER);

  const signer = Wallet.fromMnemonic(USER1_MNEMONIC).connect(provider);
  await setBalance(signer.address, utils.parseEther('100').toHexString());
  const pool = await getAjnaPool(provider, fixture);
  const quoteToken = new Contract(fixture.quoteToken, ERC20_ABI, provider);
  const { factory } = await deployFactorySystem(signer);

  await createLiveAjnaLiquidation({ pool, fixture });

  const liquidationStatus = await pool
    .getLiquidation(fixture.borrower)
    .getStatus();
  expect(
    liquidationStatus.collateral.gt(0),
    'expected kicked liquidation collateral'
  ).to.be.true;

  const runtimeCache = createFactoryQuoteProviderRuntimeCache();
  await expectLiveUniswapRoutesAvailable({
    fixture,
    pool,
    signer,
    runtimeCache,
  });

  const routeQuoteBudgetPerCandidate =
    fixture.routeQuoteBudgetPerCandidate ?? 1;
  const restrictiveQuoteEvaluation = await getFactoryTakeQuoteEvaluation(
    pool,
    liquidationStatus.price,
    liquidationStatus.collateral,
    buildLiveUniswapPoolConfig(fixture, 0.000001),
    {
      universalRouterOverrides: fixture.uniswap,
    },
    signer,
    runtimeCache,
    {
      routeQuoteBudgetPerCandidate: 1,
    }
  );
  expect(restrictiveQuoteEvaluation.isTakeable).to.equal(false);
  expect(restrictiveQuoteEvaluation.reason).to.contain(
    EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold
  );

  const poolConfig = buildLiveUniswapPoolConfig(fixture, 0.99);
  const quoteEvaluation = await getFactoryTakeQuoteEvaluation(
    pool,
    liquidationStatus.price,
    liquidationStatus.collateral,
    poolConfig,
    {
      universalRouterOverrides: fixture.uniswap,
    },
    signer,
    runtimeCache,
    {
      routeQuoteBudgetPerCandidate,
    }
  );

  expect(quoteEvaluation.isTakeable, quoteEvaluation.reason).to.be.true;
  expect(quoteEvaluation.selectedLiquiditySource).to.equal(
    LiquiditySource.UNISWAPV3
  );
  expect(quoteEvaluation.selectedFeeTier).to.be.a('number');
  expect(
    quoteEvaluation.quoteAmountRaw!.gt(
      quoteEvaluation.routeProfitability!.auctionRepayRequirementQuoteRaw!
    ),
    'route quote should exceed Ajna repayment floor before execution'
  ).to.be.true;

  const liquidation = await buildLiveFactoryLiquidationPlan({
    pool,
    borrower: fixture.borrower,
    quoteEvaluation,
  });
  const signerQuoteBefore: BigNumber = await quoteToken.balanceOf(
    signer.address
  );

  const executed = await takeLiquidationFactory({
    pool,
    poolConfig,
    signer,
    liquidation,
    config: {
      dryRun: false,
      keeperTakerFactory: factory.address,
      universalRouterOverrides: fixture.uniswap,
      runtimeCache,
    },
  });

  expect(executed).to.equal(true);
  const finalLiquidationStatus = await pool
    .getLiquidation(fixture.borrower)
    .getStatus();
  expect(weiToDecimaled(finalLiquidationStatus.collateral)).to.equal(0);

  const signerQuoteAfter: BigNumber = await quoteToken.balanceOf(
    signer.address
  );
  expect(
    signerQuoteAfter.gt(signerQuoteBefore),
    `expected recovered WETH profit, before=${weiToDecimaled(
      signerQuoteBefore
    )}, after=${weiToDecimaled(signerQuoteAfter)}`
  ).to.be.true;
}

describe('Live liquidity end-to-end factory execution', function () {
  this.timeout(LIVE_LIQUIDITY_TIMEOUT_MS);

  before(function () {
    if (!RUN_LIVE_LIQUIDITY_E2E) {
      this.skip();
    }
    if ((process.env.FORK_NETWORK || 'mainnet') !== 'mainnet') {
      this.skip();
    }
  });

  beforeEach(async () => {
    await resetHardhat();
    NonceTracker.clearNonces();
  });

  it('executes a pinned Ajna liquidation through real Uniswap V3 liquidity', async () => {
    await executeLiveUniswapFixture(MAINNET_UNISWAP_SOL_WETH_FIXTURE);
  });

  it('executes a live Ajna liquidation after automatic Uniswap V3 fee-tier probing', async () => {
    await executeLiveUniswapFixture(
      MAINNET_UNISWAP_SOL_WETH_AUTOPROBE_FIXTURE
    );
  });
});
