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
  createDirectDexQuoteProviderRuntimeCache,
  DirectDexExecutionConfig,
  takeLiquidationDirectDex,
} from '../../../src/take/direct-dex';
import { deriveApprovedMinOutRaw } from '../../../src/take/direct-dex/route-amounts';
import { ApprovedDirectDexQuoteEvaluation } from '../../../src/take/types';
import { RequireFields } from '../../../src/utils';
import { setBalance } from '../test-utils';
import { singleExternalTakeExecutionPlan } from '../../helpers/external-take-plan';
import { TakerRouter } from '../../../typechain-types/contracts/factories';
import {
  CurveKeeperTaker,
  UniswapV3KeeperTaker,
} from '../../../typechain-types/contracts/takers';
import { TakerRouter__factory } from '../../../typechain-types/factories/contracts/factories';
import {
  CurveKeeperTaker__factory,
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

interface DirectDexPoolView {
  name: string;
  poolAddress: string;
  collateralAddress: string;
  quoteAddress: string;
  contract: MockAtomicSwapPool;
}

export interface DirectDexHarness {
  owner: Wallet;
  collateralToken: MockERC20;
  quoteToken: MockERC20;
  pool: MockAtomicSwapPool;
  router: TakerRouter;
  uniswapTaker: UniswapV3KeeperTaker;
  curveTaker: CurveKeeperTaker;
  quoteAmountDue: BigNumber;
}

function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

export async function deployDirectDexHarness(options?: {
  quoteDecimals?: number;
  quoteTokenScale?: BigNumber;
  quoteAmountDue?: BigNumber;
}): Promise<DirectDexHarness> {
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

  const router = await new TakerRouter__factory(owner).deploy(
    poolDeployer.address
  );
  await router.deployed();

  const uniswapTaker = await new UniswapV3KeeperTaker__factory(owner).deploy(
    poolDeployer.address,
    router.address
  );
  await uniswapTaker.deployed();

  const curveTaker = await new CurveKeeperTaker__factory(owner).deploy(
    poolDeployer.address,
    router.address
  );
  await curveTaker.deployed();

  await router.setTaker(LiquiditySource.UNISWAPV3, uniswapTaker.address);
  await router.setTaker(LiquiditySource.CURVE, curveTaker.address);

  return {
    owner,
    collateralToken,
    quoteToken,
    pool,
    router,
    uniswapTaker,
    curveTaker,
    quoteAmountDue,
  };
}

export function buildDirectDexPoolView(params: {
  pool: MockAtomicSwapPool;
  collateralToken: { address: string };
  quoteToken: { address: string };
  name?: string;
}): DirectDexPoolView {
  return {
    name: params.name ?? 'Direct DEX Route Pool',
    poolAddress: params.pool.address,
    collateralAddress: params.collateralToken.address,
    quoteAddress: params.quoteToken.address,
    contract: params.pool,
  };
}

export function asFungiblePool(poolView: DirectDexPoolView): FungiblePool {
  return poolView as unknown as FungiblePool;
}

export function buildDirectDexTakePoolConfig(
  poolView: DirectDexPoolView,
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

async function snapshotDirectDexState(params: {
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

async function expectDirectDexStateUnchanged(
  params: {
    pool: MockAtomicSwapPool;
    collateralToken: MockERC20;
    quoteToken: MockERC20;
    takerAddress: string;
  },
  before: Awaited<ReturnType<typeof snapshotDirectDexState>>
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

export function buildApprovedDirectDexQuoteEvaluation(params: {
  source: LiquiditySource;
  quoteAmountRaw: BigNumber;
  routeMinOutRaw: BigNumber;
  profitMinOutRaw?: BigNumber;
  approvedMinOutRaw?: BigNumber;
  selectedFeeTier?: number;
  curvePool?: {
    address: string;
    poolType: CurvePoolType;
    tokenInIndex: number;
    tokenOutIndex: number;
  };
}): ApprovedDirectDexQuoteEvaluation & { routeExecutionFloorRaw: BigNumber } {
  const approvedMinOutRaw =
    params.approvedMinOutRaw ??
    deriveApprovedMinOutRaw({
      routeMinOutRaw: params.routeMinOutRaw,
      profitMinOutRaw: params.profitMinOutRaw,
    });
  if (!approvedMinOutRaw) {
    throw new Error('Test direct DEX quote evaluation missing approved min-out');
  }

  const base = {
    isTakeable: true as const,
    externalTakePath: 'direct_dex' as const,
    quoteAmountRaw: params.quoteAmountRaw,
    routeMinOutRaw: params.routeMinOutRaw,
    profitMinOutRaw: params.profitMinOutRaw,
    routeExecutionFloorRaw: approvedMinOutRaw,
    approvedMinOutRaw,
    reason: 'test-approved route',
  };
  if (params.source === LiquiditySource.UNISWAPV3) {
    if (params.selectedFeeTier === undefined) {
      throw new Error('Test Uniswap V3 direct DEX quote missing fee tier');
    }
    return {
      ...base,
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: params.selectedFeeTier,
    };
  }
  if (params.source === LiquiditySource.CURVE) {
    if (!params.curvePool) {
      throw new Error('Test Curve direct DEX quote missing curve pool');
    }
    return {
      ...base,
      selectedLiquiditySource: LiquiditySource.CURVE,
      curvePool: params.curvePool,
    };
  }
  throw new Error(`Unsupported test direct DEX quote source: ${params.source}`);
}

export async function deployFundedSwapRouter02(
  harness: DirectDexHarness,
  amountOut: BigNumber
) {
  const router = await new MockSwapRouter02__factory(harness.owner).deploy(
    amountOut
  );
  await router.deployed();
  await harness.quoteToken.mint(router.address, amountOut);
  return router;
}

interface CurvePoolSelection {
  address: string;
  poolType: CurvePoolType;
  tokenInIndex: number;
  tokenOutIndex: number;
}

interface DirectDexRouteExecutionFixture {
  takerAddress: string;
  configOverrides: Pick<
    DirectDexExecutionConfig,
    'uniswapV3RouterOverrides' | 'curveRouterOverrides'
  >;
  curvePool?: CurvePoolSelection;
}

interface DirectDexRouteExecutionSetup {
  harness: DirectDexHarness;
  routerAmountOut: BigNumber;
  selectedFeeTier?: number;
}

async function prepareUniswapDirectDexRouteExecution(
  params: DirectDexRouteExecutionSetup
): Promise<DirectDexRouteExecutionFixture> {
  const { harness } = params;
  const router = await deployFundedSwapRouter02(
    harness,
    params.routerAmountOut
  );
  return {
    takerAddress: harness.uniswapTaker.address,
    configOverrides: {
      uniswapV3RouterOverrides: {
        swapRouter02Address: router.address,
        poolFactoryAddress: '0x4444444444444444444444444444444444444444',
        wethAddress: harness.quoteToken.address,
        quoterV2Address: '0x6666666666666666666666666666666666666666',
        defaultFeeTier: params.selectedFeeTier ?? 500,
      },
    },
  };
}

async function prepareUniswapNonSwapRouterExecution(
  params: DirectDexRouteExecutionSetup
): Promise<DirectDexRouteExecutionFixture> {
  const { harness } = params;
  const router = await new MockSwapRouter__factory(harness.owner).deploy(1, 1);
  await router.deployed();
  await harness.quoteToken.mint(router.address, params.routerAmountOut);
  return {
    takerAddress: harness.uniswapTaker.address,
    configOverrides: {
      uniswapV3RouterOverrides: {
        swapRouter02Address: router.address,
        poolFactoryAddress: '0x4444444444444444444444444444444444444444',
        wethAddress: harness.quoteToken.address,
        quoterV2Address: '0x6666666666666666666666666666666666666666',
        defaultFeeTier: params.selectedFeeTier ?? 500,
      },
    },
  };
}

async function prepareCurveDirectDexRouteExecution(
  params: DirectDexRouteExecutionSetup
): Promise<DirectDexRouteExecutionFixture> {
  const { harness } = params;
  const curvePool = await new MockCurveSwapPool__factory(harness.owner).deploy(
    harness.collateralToken.address,
    params.routerAmountOut
  );
  await curvePool.deployed();
  await curvePool.setTokenOut(harness.quoteToken.address);
  await harness.quoteToken.mint(curvePool.address, params.routerAmountOut);
  return {
    takerAddress: harness.curveTaker.address,
    configOverrides: {
      curveRouterOverrides: {},
    },
    curvePool: {
      address: curvePool.address,
      poolType: CurvePoolType.STABLE,
      tokenInIndex: 0,
      tokenOutIndex: 1,
    },
  };
}

async function prepareDirectDexRouteExecution(params: {
  source: LiquiditySource;
  routerAmountOut: BigNumber;
  selectedFeeTier?: number;
  harness: DirectDexHarness;
}): Promise<DirectDexRouteExecutionFixture> {
  switch (params.source) {
    case LiquiditySource.UNISWAPV3:
      return await prepareUniswapDirectDexRouteExecution(params);
    case LiquiditySource.CURVE:
      return await prepareCurveDirectDexRouteExecution(params);
    default:
      throw new Error(`Unsupported direct DEX route source ${params.source}`);
  }
}

interface RejectedDirectDexExecutionParams {
  source: LiquiditySource;
  routerAmountOut: BigNumber;
  routeMinOutRaw: BigNumber;
  profitMinOutRaw?: BigNumber;
  approvedMinOutRaw?: BigNumber;
  quoteAmountRaw: BigNumber;
  selectedFeeTier?: number;
  expectedFailureReason?: string | RegExp;
}

async function expectRejectedDirectDexExecutionWithPreparedRoute(
  params: RejectedDirectDexExecutionParams & {
    prepareRoute: (
      setup: DirectDexRouteExecutionSetup
    ) => Promise<DirectDexRouteExecutionFixture>;
  }
) {
  const harness = await deployDirectDexHarness();
  const { owner, collateralToken, quoteToken, pool, router } = harness;
  const route = await params.prepareRoute({
    harness,
    routerAmountOut: params.routerAmountOut,
    selectedFeeTier: params.selectedFeeTier,
  });

  const config: DirectDexExecutionConfig = {
    dryRun: false,
    keeperTakerRouter: router.address,
    runtimeCache: createDirectDexQuoteProviderRuntimeCache(),
    ...route.configOverrides,
  };
  const executionFailures: Array<{ preBroadcast: boolean; error?: string }> =
    [];
  config.onDirectDexExecutionFailure = (failure) => {
    executionFailures.push(failure);
  };

  const poolView = buildDirectDexPoolView({
    pool,
    collateralToken,
    quoteToken,
    name: 'Rejected Direct DEX Route Pool',
  });
  const before = await snapshotDirectDexState({
    pool,
    collateralToken,
    quoteToken,
    takerAddress: route.takerAddress,
  });
  const quoteEvaluation = buildApprovedDirectDexQuoteEvaluation({
    source: params.source,
    quoteAmountRaw: params.quoteAmountRaw,
    routeMinOutRaw: params.routeMinOutRaw,
    profitMinOutRaw: params.profitMinOutRaw,
    approvedMinOutRaw: params.approvedMinOutRaw,
    selectedFeeTier:
      params.source === LiquiditySource.CURVE
        ? undefined
        : (params.selectedFeeTier ?? 500),
    curvePool: route.curvePool,
  });

  const executed = await takeLiquidationDirectDex({
    pool: asFungiblePool(poolView),
    poolConfig: buildDirectDexTakePoolConfig(poolView, params.source),
    signer: owner,
    liquidation: {
      borrower: BORROWER,
      hpbIndex: 0,
      collateral: COLLATERAL_AMOUNT,
      auctionPrice: AUCTION_PRICE,
      isTakeable: true,
      isArbTakeable: false,
      externalTakeExecutionPlan:
        singleExternalTakeExecutionPlan(quoteEvaluation),
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
  await expectDirectDexStateUnchanged(
    { pool, collateralToken, quoteToken, takerAddress: route.takerAddress },
    before
  );
}

export async function expectDirectDexExecutionRejectedWithoutStateMutation(
  params: RejectedDirectDexExecutionParams
) {
  await expectRejectedDirectDexExecutionWithPreparedRoute({
    ...params,
    prepareRoute: async (setup) =>
      await prepareDirectDexRouteExecution({ ...setup, source: params.source }),
  });
}

export async function expectUniswapNonSwapRouterExecutionRejectedWithoutStateMutation(
  params: Omit<RejectedDirectDexExecutionParams, 'source'>
) {
  await expectRejectedDirectDexExecutionWithPreparedRoute({
    ...params,
    source: LiquiditySource.UNISWAPV3,
    prepareRoute: prepareUniswapNonSwapRouterExecution,
  });
}

export async function expectSuccessfulDirectDexTake(params: {
  source: LiquiditySource;
  poolType?: CurvePoolType;
}) {
  const harness = await deployDirectDexHarness();
  const {
    owner,
    collateralToken,
    quoteToken,
    pool,
    router: takerRouter,
    uniswapTaker,
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

  const tx = await takerRouter.takeWithAtomicSwap(
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
