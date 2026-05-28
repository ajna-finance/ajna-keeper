import { expect } from 'chai';
import { FungiblePool } from '@ajna-finance/sdk';
import { BigNumber, Wallet, constants, providers, utils } from 'ethers';
import { network } from 'hardhat';
import {
  CurvePoolType,
  LiquiditySource,
  PoolConfig,
  PriceOriginSource,
} from '../../../src/config';
import {
  createFactoryQuoteProviderRuntimeCache,
  FactoryExecutionConfig,
  takeLiquidationFactory,
} from '../../../src/take/factory';
import { ExternalTakeQuoteEvaluation } from '../../../src/take/types';
import { RequireFields } from '../../../src/utils';
import { setBalance } from '../test-utils';
import { AjnaKeeperTakerFactory } from '../../../typechain-types/contracts/factories';
import {
  CurveKeeperTaker,
  SushiSwapKeeperTaker,
  UniswapV3KeeperTaker,
} from '../../../typechain-types/contracts/takers';
import { AjnaKeeperTakerFactory__factory } from '../../../typechain-types/factories/contracts/factories';
import {
  CurveKeeperTaker__factory,
  SushiSwapKeeperTaker__factory,
  UniswapV3KeeperTaker__factory,
} from '../../../typechain-types/factories/contracts/takers';
import {
  MockAtomicSwapPool,
  MockERC20,
} from '../../../typechain-types/contracts/mocks';
import {
  MockAtomicSwapPool__factory,
  MockCurveSwapPool__factory,
  MockERC20__factory,
  MockPoolDeployer__factory,
  MockSushiSwapRouter__factory,
  MockSwapRouter02__factory,
  MockSwapRouter__factory,
} from '../../../typechain-types/factories/contracts/mocks';

export const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
export const AUCTION_PRICE = utils.parseEther('0.5');
export const COLLATERAL_AMOUNT = utils.parseEther('10');
export const QUOTE_AMOUNT_DUE = utils.parseEther('5');
export const ROUTER_AMOUNT_OUT = utils.parseEther('7');
export const APPROVED_MIN_OUT = utils.parseEther('6');
export const QUOTE_TOKEN_SCALE = BigNumber.from(1);
export const USDC_QUOTE_TOKEN_SCALE = BigNumber.from('1000000000000');
export const USDC_QUOTE_AMOUNT_DUE = BigNumber.from('5000000');
export const USDC_ROUTER_AMOUNT_OUT = BigNumber.from('7000000');
export const USDC_APPROVED_MIN_OUT = BigNumber.from('6000000');
export const DEADLINE = 4_102_444_800;
export const BORROWER = '0x000000000000000000000000000000000000b0b0';

interface FactoryPoolView {
  name: string;
  poolAddress: string;
  collateralAddress: string;
  quoteAddress: string;
  contract: MockAtomicSwapPool;
}

export interface FactoryHarness {
  owner: Wallet;
  collateralToken: MockERC20;
  quoteToken: MockERC20;
  pool: MockAtomicSwapPool;
  factory: AjnaKeeperTakerFactory;
  uniswapTaker: UniswapV3KeeperTaker;
  sushiTaker: SushiSwapKeeperTaker;
  curveTaker: CurveKeeperTaker;
  quoteAmountDue: BigNumber;
}

function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

export async function deployFactoryHarness(options?: {
  quoteDecimals?: number;
  quoteTokenScale?: BigNumber;
  quoteAmountDue?: BigNumber;
}): Promise<FactoryHarness> {
  const quoteDecimals = options?.quoteDecimals ?? 18;
  const quoteTokenScale = options?.quoteTokenScale ?? QUOTE_TOKEN_SCALE;
  const quoteAmountDue = options?.quoteAmountDue ?? QUOTE_AMOUNT_DUE;
  const provider = getProvider();
  const owner = Wallet.createRandom().connect(provider);
  await setBalance(owner.address, utils.parseEther('100').toHexString());

  const collateralToken = await new MockERC20__factory(owner).deploy(
    'Mock Collateral',
    'MCOLL',
    18
  );
  await collateralToken.deployed();

  const quoteToken = await new MockERC20__factory(owner).deploy(
    'Mock Quote',
    'MQUOTE',
    quoteDecimals
  );
  await quoteToken.deployed();

  const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
  await poolDeployer.deployed();

  const pool = await new MockAtomicSwapPool__factory(owner).deploy(
    collateralToken.address,
    quoteToken.address,
    quoteTokenScale
  );
  await pool.deployed();
  await pool.setQuoteAmountDue(quoteAmountDue);
  await collateralToken.mint(pool.address, COLLATERAL_AMOUNT.mul(10));

  await poolDeployer.setDeployedPool(
    ERC20_NON_SUBSET_HASH,
    collateralToken.address,
    quoteToken.address,
    pool.address
  );

  const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
    poolDeployer.address
  );
  await factory.deployed();

  const uniswapTaker = await new UniswapV3KeeperTaker__factory(owner).deploy(
    poolDeployer.address,
    factory.address
  );
  await uniswapTaker.deployed();

  const sushiTaker = await new SushiSwapKeeperTaker__factory(owner).deploy(
    poolDeployer.address,
    factory.address
  );
  await sushiTaker.deployed();

  const curveTaker = await new CurveKeeperTaker__factory(owner).deploy(
    poolDeployer.address,
    factory.address
  );
  await curveTaker.deployed();

  await factory.setTaker(LiquiditySource.UNISWAPV3, uniswapTaker.address);
  await factory.setTaker(LiquiditySource.SUSHISWAP, sushiTaker.address);
  await factory.setTaker(LiquiditySource.CURVE, curveTaker.address);

  return {
    owner,
    collateralToken,
    quoteToken,
    pool,
    factory,
    uniswapTaker,
    sushiTaker,
    curveTaker,
    quoteAmountDue,
  };
}

export function buildFactoryPoolView(params: {
  pool: MockAtomicSwapPool;
  collateralToken: { address: string };
  quoteToken: { address: string };
  name?: string;
}): FactoryPoolView {
  return {
    name: params.name ?? 'Factory Route Pool',
    poolAddress: params.pool.address,
    collateralAddress: params.collateralToken.address,
    quoteAddress: params.quoteToken.address,
    contract: params.pool,
  };
}

export function asFungiblePool(poolView: FactoryPoolView): FungiblePool {
  return poolView as unknown as FungiblePool;
}

export function buildFactoryTakePoolConfig(
  poolView: FactoryPoolView,
  source: LiquiditySource
): RequireFields<PoolConfig, 'take'> {
  return {
    name: poolView.name,
    address: poolView.poolAddress,
    price: {
      source: PriceOriginSource.FIXED,
      value: 1,
    },
    take: {
      liquiditySource: source,
      marketPriceFactor: 0.99,
    },
  };
}

async function snapshotFactoryState(params: {
  pool: MockAtomicSwapPool;
  collateralToken: MockERC20;
  quoteToken: MockERC20;
  takerAddress: string;
}) {
  return {
    poolQuote: await params.quoteToken.balanceOf(params.pool.address),
    poolCollateral: await params.collateralToken.balanceOf(params.pool.address),
    takeCount: await params.pool.takeCount(),
    poolAllowance: await params.quoteToken.allowance(
      params.takerAddress,
      params.pool.address
    ),
  };
}

async function expectFactoryStateUnchanged(
  params: {
    pool: MockAtomicSwapPool;
    collateralToken: MockERC20;
    quoteToken: MockERC20;
    takerAddress: string;
  },
  before: Awaited<ReturnType<typeof snapshotFactoryState>>
) {
  expect(
    (await params.quoteToken.balanceOf(params.pool.address)).eq(
      before.poolQuote
    )
  ).to.be.true;
  expect(
    (await params.collateralToken.balanceOf(params.pool.address)).eq(
      before.poolCollateral
    )
  ).to.be.true;
  expect((await params.pool.takeCount()).eq(before.takeCount)).to.be.true;
  expect(
    (
      await params.quoteToken.allowance(
        params.takerAddress,
        params.pool.address
      )
    ).eq(before.poolAllowance)
  ).to.be.true;
}

export function buildApprovedFactoryQuoteEvaluation(params: {
  source: LiquiditySource;
  quoteAmountRaw: BigNumber;
  routeMinOutRaw: BigNumber;
  profitMinOutRaw?: BigNumber;
  fallbackApprovedMinOutRaw?: BigNumber;
  selectedFeeTier?: number;
  curvePool?: {
    address: string;
    poolType: CurvePoolType;
    tokenInIndex: number;
    tokenOutIndex: number;
  };
}): ExternalTakeQuoteEvaluation {
  const approvedMinOutRaw =
    params.fallbackApprovedMinOutRaw ??
    (params.profitMinOutRaw && params.profitMinOutRaw.gt(params.routeMinOutRaw)
      ? params.profitMinOutRaw
      : params.routeMinOutRaw);

  return {
    isTakeable: true,
    externalTakePath: 'factory',
    quoteAmountRaw: params.quoteAmountRaw,
    selectedLiquiditySource: params.source,
    selectedFeeTier: params.selectedFeeTier,
    routeMinOutRaw: params.routeMinOutRaw,
    profitMinOutRaw: params.profitMinOutRaw,
    approvedMinOutRaw,
    curvePool: params.curvePool,
    reason: 'test-approved route',
  };
}

export async function deployFundedSwapRouter02(
  harness: FactoryHarness,
  amountOut: BigNumber
) {
  const router = await new MockSwapRouter02__factory(harness.owner).deploy(
    amountOut
  );
  await router.deployed();
  await harness.quoteToken.mint(router.address, amountOut);
  return router;
}

export async function deployFundedSushiRouter(
  harness: FactoryHarness,
  amountOut: BigNumber
) {
  const router = await new MockSushiSwapRouter__factory(harness.owner).deploy(
    amountOut
  );
  await router.deployed();
  await harness.quoteToken.mint(router.address, amountOut);
  return router;
}

export async function expectFactoryExecutionRejectedWithoutStateMutation(params: {
  source: LiquiditySource;
  routerAmountOut: BigNumber;
  routeMinOutRaw: BigNumber;
  profitMinOutRaw?: BigNumber;
  fallbackApprovedMinOutRaw?: BigNumber;
  quoteAmountRaw: BigNumber;
  selectedFeeTier?: number;
  wrongUniswapRouter?: boolean;
  expectedFailureReason?: string | RegExp;
}) {
  const harness = await deployFactoryHarness();
  const {
    owner,
    collateralToken,
    quoteToken,
    pool,
    factory,
    uniswapTaker,
    sushiTaker,
    curveTaker,
  } = harness;

  let takerAddress: string;
  const config: FactoryExecutionConfig = {
    dryRun: false,
    keeperTakerFactory: factory.address,
    runtimeCache: createFactoryQuoteProviderRuntimeCache(),
  };
  const executionFailures: Array<{ preBroadcast: boolean; error?: string }> = [];
  config.onFactoryExecutionFailure = (failure) => {
    executionFailures.push(failure);
  };
  let curvePoolSelection:
    | {
        address: string;
        poolType: CurvePoolType;
        tokenInIndex: number;
        tokenOutIndex: number;
      }
    | undefined;

  if (params.source === LiquiditySource.UNISWAPV3) {
    takerAddress = uniswapTaker.address;
    if (params.wrongUniswapRouter) {
      const wrongRouter = await new MockSwapRouter__factory(owner).deploy(1, 1);
      await wrongRouter.deployed();
      await quoteToken.mint(wrongRouter.address, params.routerAmountOut);
      config.uniswapV3RouterOverrides = {
        swapRouter02Address: wrongRouter.address,
        poolFactoryAddress: '0x4444444444444444444444444444444444444444',
        wethAddress: quoteToken.address,
        quoterV2Address: '0x6666666666666666666666666666666666666666',
        defaultFeeTier: params.selectedFeeTier ?? 500,
      };
    } else {
      const router = await deployFundedSwapRouter02(
        harness,
        params.routerAmountOut
      );
      config.uniswapV3RouterOverrides = {
        swapRouter02Address: router.address,
        poolFactoryAddress: '0x4444444444444444444444444444444444444444',
        wethAddress: quoteToken.address,
        quoterV2Address: '0x6666666666666666666666666666666666666666',
        defaultFeeTier: params.selectedFeeTier ?? 500,
      };
    }
  } else if (params.source === LiquiditySource.SUSHISWAP) {
    takerAddress = sushiTaker.address;
    const router = await deployFundedSushiRouter(harness, params.routerAmountOut);
    config.sushiswapRouterOverrides = {
      swapRouterAddress: router.address,
      quoterV2Address: '0x9999999999999999999999999999999999999999',
      factoryAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      wethAddress: quoteToken.address,
      defaultFeeTier: params.selectedFeeTier ?? 500,
    };
  } else {
    takerAddress = curveTaker.address;
    const curvePool = await new MockCurveSwapPool__factory(owner).deploy(
      collateralToken.address,
      params.routerAmountOut
    );
    await curvePool.deployed();
    await curvePool.setTokenOut(quoteToken.address);
    await quoteToken.mint(curvePool.address, params.routerAmountOut);
    curvePoolSelection = {
      address: curvePool.address,
      poolType: CurvePoolType.STABLE,
      tokenInIndex: 0,
      tokenOutIndex: 1,
    };
    config.curveRouterOverrides = {};
  }

  const poolView = buildFactoryPoolView({
    pool,
    collateralToken,
    quoteToken,
    name: 'Rejected Factory Route Pool',
  });
  const before = await snapshotFactoryState({
    pool,
    collateralToken,
    quoteToken,
    takerAddress,
  });
  const quoteEvaluation = buildApprovedFactoryQuoteEvaluation({
    source: params.source,
    quoteAmountRaw: params.quoteAmountRaw,
    routeMinOutRaw: params.routeMinOutRaw,
    profitMinOutRaw: params.profitMinOutRaw,
    fallbackApprovedMinOutRaw: params.fallbackApprovedMinOutRaw,
    selectedFeeTier:
      params.source === LiquiditySource.CURVE
        ? undefined
        : (params.selectedFeeTier ?? 500),
    curvePool: curvePoolSelection,
  });

  const executed = await takeLiquidationFactory({
    pool: asFungiblePool(poolView),
    poolConfig: buildFactoryTakePoolConfig(poolView, params.source),
    signer: owner,
    liquidation: {
      borrower: BORROWER,
      hpbIndex: 0,
      collateral: COLLATERAL_AMOUNT,
      auctionPrice: AUCTION_PRICE,
      isTakeable: true,
      isArbTakeable: false,
      externalTakeQuoteEvaluation: quoteEvaluation,
    },
    config,
  });

  expect(executed).to.equal(false);
  if (params.expectedFailureReason) {
    expect(executionFailures.length).to.be.greaterThan(0);
    const failureMessage = executionFailures
      .map((failure) => failure.error ?? '')
      .join('\n');
    if (typeof params.expectedFailureReason === 'string') {
      expect(failureMessage).to.include(params.expectedFailureReason);
    } else {
      expect(failureMessage).to.match(params.expectedFailureReason);
    }
  }
  await expectFactoryStateUnchanged(
    { pool, collateralToken, quoteToken, takerAddress },
    before
  );
}

export async function expectSuccessfulFactoryTake(params: {
  source: LiquiditySource;
  poolType?: CurvePoolType;
}) {
  const harness = await deployFactoryHarness();
  const {
    owner,
    collateralToken,
    quoteToken,
    pool,
    factory,
    uniswapTaker,
    sushiTaker,
    curveTaker,
  } = harness;

  const poolQuoteBefore = await quoteToken.balanceOf(pool.address);
  const poolCollateralBefore = await collateralToken.balanceOf(pool.address);
  const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);
  const takeCountBefore = await pool.takeCount();

  let swapRouter: string;
  let swapDetails: string;
  let takerAddress: string;

  if (params.source === LiquiditySource.UNISWAPV3) {
    const router = await deployFundedSwapRouter02(harness, ROUTER_AMOUNT_OUT);

    swapRouter = router.address;
    swapDetails = utils.defaultAbiCoder.encode(
      ['(address,address,uint24,uint256,uint256)'],
      [[router.address, quoteToken.address, 500, APPROVED_MIN_OUT, DEADLINE]]
    );
    takerAddress = uniswapTaker.address;
  } else if (params.source === LiquiditySource.SUSHISWAP) {
    const router = await deployFundedSushiRouter(harness, ROUTER_AMOUNT_OUT);

    swapRouter = router.address;
    swapDetails = utils.defaultAbiCoder.encode(
      ['uint24', 'uint256', 'uint256'],
      [500, APPROVED_MIN_OUT, DEADLINE]
    );
    takerAddress = sushiTaker.address;
  } else {
    const curvePool = await new MockCurveSwapPool__factory(owner).deploy(
      collateralToken.address,
      ROUTER_AMOUNT_OUT
    );
    await curvePool.deployed();
    await curvePool.setTokenOut(quoteToken.address);
    await quoteToken.mint(curvePool.address, ROUTER_AMOUNT_OUT);

    swapRouter = curvePool.address;
    swapDetails = utils.defaultAbiCoder.encode(
      ['address', 'uint8', 'uint8', 'uint8', 'uint256', 'uint256'],
      [
        curvePool.address,
        params.poolType === CurvePoolType.CRYPTO ? 1 : 0,
        0,
        1,
        APPROVED_MIN_OUT,
        DEADLINE,
      ]
    );
    takerAddress = curveTaker.address;
  }

  const tx = await factory.takeWithAtomicSwap(
    pool.address,
    BORROWER,
    AUCTION_PRICE,
    COLLATERAL_AMOUNT,
    params.source,
    swapRouter,
    swapDetails
  );
  await tx.wait();

  expect((await pool.takeCount()).eq(takeCountBefore.add(1))).to.be.true;
  expect(await pool.lastBorrower()).to.equal(BORROWER);
  expect(await pool.lastCallee()).to.equal(takerAddress);
  expect((await pool.lastCollateralTaken()).eq(COLLATERAL_AMOUNT)).to.be.true;
  expect(
    (await quoteToken.balanceOf(pool.address)).eq(
      poolQuoteBefore.add(QUOTE_AMOUNT_DUE)
    )
  ).to.be.true;
  expect(
    (await collateralToken.balanceOf(pool.address)).eq(
      poolCollateralBefore.sub(COLLATERAL_AMOUNT)
    )
  ).to.be.true;
  expect(
    (await quoteToken.balanceOf(owner.address)).eq(
      ownerQuoteBefore.add(ROUTER_AMOUNT_OUT.sub(QUOTE_AMOUNT_DUE))
    )
  ).to.be.true;
  expect(
    (await quoteToken.allowance(takerAddress, pool.address)).eq(constants.Zero)
  ).to.be.true;
}
