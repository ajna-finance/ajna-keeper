import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, Wallet, constants, ethers, providers, utils } from 'ethers';
import { network } from 'hardhat';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import * as erc20 from '../../src/erc20';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import { SushiSwapQuoteProvider } from '../../src/dex/providers/sushiswap-quote-provider';
import {
  getFactoryTakeQuoteEvaluation,
  takeLiquidationFactory,
} from '../../src/take/factory';
import { EXTERNAL_TAKE_REJECTION_REASONS } from '../../src/take/external-take-policy';
import { createFactoryQuoteProviderRuntimeCache } from '../../src/take/factory/shared';
import { resetHardhat, setBalance } from './test-utils';
import { AjnaKeeperTakerFactory__factory } from '../../typechain-types/factories/contracts/factories';
import {
  CurveKeeperTaker__factory,
  SushiSwapKeeperTaker__factory,
  UniswapV3KeeperTaker__factory,
} from '../../typechain-types/factories/contracts/takers';
import {
  MockAtomicSwapPool__factory,
  MockCurveSwapPool__factory,
  MockERC20__factory,
  MockPoolDeployer__factory,
  MockSushiSwapRouter__factory,
} from '../../typechain-types/factories/contracts/mocks';

const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
const AUCTION_PRICE = utils.parseEther('0.5');
const COLLATERAL_AMOUNT = utils.parseEther('10');
const QUOTE_AMOUNT_DUE = utils.parseEther('5');
const ROUTER_AMOUNT_OUT = utils.parseEther('7');
const APPROVED_MIN_OUT = utils.parseEther('6');
const QUOTE_TOKEN_SCALE = BigNumber.from(1);
const DEADLINE = 4_102_444_800;
const BORROWER = '0x000000000000000000000000000000000000b0b0';

function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

async function expectRevert(tx: Promise<unknown>, expectedMessage: string) {
  let caught: unknown;
  try {
    await tx;
  } catch (error) {
    caught = error;
  }

  expect(caught).to.be.instanceOf(Error);
  expect((caught as Error).message).to.contain(expectedMessage);
}

describe('Production route selection fork verification', function () {
  this.timeout(300_000);

  beforeEach(async function () {
    const forkNetwork = process.env.FORK_NETWORK || 'mainnet';
    if (!['mainnet', 'base'].includes(forkNetwork)) {
      this.skip();
    }
    await resetHardhat();
  });

  afterEach(() => {
    sinon.restore();
  });

  async function deployFactoryHarness() {
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
      18
    );
    await quoteToken.deployed();

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const pool = await new MockAtomicSwapPool__factory(owner).deploy(
      collateralToken.address,
      quoteToken.address,
      QUOTE_TOKEN_SCALE
    );
    await pool.deployed();
    await pool.setQuoteAmountDue(QUOTE_AMOUNT_DUE);
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
    };
  }

  async function expectSuccessfulFactoryTake(params: {
    source: LiquiditySource;
    poolType?: CurvePoolType;
  }) {
    const {
      owner,
      collateralToken,
      quoteToken,
      pool,
      factory,
      uniswapTaker,
      sushiTaker,
      curveTaker,
    } = await deployFactoryHarness();

    const poolQuoteBefore = await quoteToken.balanceOf(pool.address);
    const poolCollateralBefore = await collateralToken.balanceOf(pool.address);
    const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);
    const takeCountBefore = await pool.takeCount();

    let swapRouter: string;
    let swapDetails: string;
    let takerAddress: string;

    if (params.source === LiquiditySource.UNISWAPV3) {
      const router = await new MockSushiSwapRouter__factory(owner).deploy(
        ROUTER_AMOUNT_OUT
      );
      await router.deployed();
      await quoteToken.mint(router.address, ROUTER_AMOUNT_OUT);

      swapRouter = router.address;
      swapDetails = utils.defaultAbiCoder.encode(
        ['(address,address,uint24,uint256,uint256)'],
        [[router.address, quoteToken.address, 500, APPROVED_MIN_OUT, DEADLINE]]
      );
      takerAddress = uniswapTaker.address;
    } else if (params.source === LiquiditySource.SUSHISWAP) {
      const router = await new MockSushiSwapRouter__factory(owner).deploy(
        ROUTER_AMOUNT_OUT
      );
      await router.deployed();
      await quoteToken.mint(router.address, ROUTER_AMOUNT_OUT);

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
      (await quoteToken.allowance(takerAddress, pool.address)).eq(
        constants.Zero
      )
    ).to.be.true;
  }

  it('executes Uniswap V3 factory takes with selected fee tier and bound min-out', async () => {
    await expectSuccessfulFactoryTake({
      source: LiquiditySource.UNISWAPV3,
    });
  });

  it('executes SushiSwap factory takes with selected fee tier and bound min-out', async () => {
    await expectSuccessfulFactoryTake({
      source: LiquiditySource.SUSHISWAP,
    });
  });

  it('executes Curve factory takes through stable and crypto dispatch', async () => {
    await expectSuccessfulFactoryTake({
      source: LiquiditySource.CURVE,
      poolType: CurvePoolType.STABLE,
    });
    await expectSuccessfulFactoryTake({
      source: LiquiditySource.CURVE,
      poolType: CurvePoolType.CRYPTO,
    });
  });

  it('fails stale factory routes without clearing collateral or weakening min-out', async () => {
    const { owner, quoteToken, collateralToken, pool, factory, sushiTaker } =
      await deployFactoryHarness();
    const staleAmountOut = QUOTE_AMOUNT_DUE.add(utils.parseEther('0.1'));
    const router = await new MockSushiSwapRouter__factory(owner).deploy(
      staleAmountOut
    );
    await router.deployed();
    await quoteToken.mint(router.address, staleAmountOut);

    const poolQuoteBefore = await quoteToken.balanceOf(pool.address);
    const poolCollateralBefore = await collateralToken.balanceOf(pool.address);
    const swapDetails = utils.defaultAbiCoder.encode(
      ['uint24', 'uint256', 'uint256'],
      [500, APPROVED_MIN_OUT, DEADLINE]
    );

    await expectRevert(
      factory.takeWithAtomicSwap(
        pool.address,
        BORROWER,
        AUCTION_PRICE,
        COLLATERAL_AMOUNT,
        LiquiditySource.SUSHISWAP,
        router.address,
        swapDetails
      ),
      'SushiSwap swap failed'
    );

    expect((await pool.takeCount()).eq(constants.Zero)).to.be.true;
    expect((await quoteToken.balanceOf(pool.address)).eq(poolQuoteBefore)).to.be
      .true;
    expect(
      (await collateralToken.balanceOf(pool.address)).eq(poolCollateralBefore)
    ).to.be.true;
    expect(
      (await quoteToken.allowance(sushiTaker.address, pool.address)).eq(
        constants.Zero
      )
    ).to.be.true;
  });

  it('fails closed when the route quote budget skips a later viable fee tier', async () => {
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
      .returns('0x7777777777777777777777777777777777777777');
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'getQuote').callsFake(
      async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) =>
        ({
          success: true,
          dstAmount: ethers.utils.parseUnits(feeTier === 500 ? '130' : '80', 6),
        }) as any
    );
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

    const pool = {
      name: 'Budget Exhaustion Pool',
      collateralAddress: '0x1111111111111111111111111111111111111111',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      contract: {
        quoteTokenScale: sinon.stub().resolves(BigNumber.from('1000000000000')),
      },
    };

    const evaluation = await getFactoryTakeQuoteEvaluation(
      pool as any,
      ethers.utils.parseEther('100'),
      ethers.utils.parseEther('1'),
      {
        name: 'Budget Exhaustion Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      } as any,
      {
        universalRouterOverrides: {
          universalRouterAddress: '0x3333333333333333333333333333333333333333',
          poolFactoryAddress: '0x4444444444444444444444444444444444444444',
          defaultFeeTier: 3000,
          candidateFeeTiers: [500],
          wethAddress: '0x5555555555555555555555555555555555555555',
          quoterV2Address: '0x6666666666666666666666666666666666666666',
        },
      } as any,
      Wallet.createRandom().connect(getProvider()) as any,
      createFactoryQuoteProviderRuntimeCache(),
      {
        routeQuoteBudgetPerCandidate: 1,
      }
    );

    expect(evaluation.isTakeable).to.be.false;
    expect(evaluation.reason).to.contain('skipped by route quote budget');
    expect(evaluation.reason).to.contain('UNISWAPV3:500');
  });

  it('waits for marketPriceFactor range, then selects and executes the best route', async () => {
    const { owner, collateralToken, quoteToken, pool, factory, sushiTaker } =
      await deployFactoryHarness();
    const collateral = utils.parseEther('1');
    const beforeRangeAuctionPrice = utils.parseEther('119');
    const inRangeAuctionPrice = utils.parseEther('117.8');
    const uniswapAmountOut = utils.parseEther('119.5');
    const sushiAmountOut = utils.parseEther('120');

    const uniswapRouter = await new MockSushiSwapRouter__factory(owner).deploy(
      uniswapAmountOut
    );
    await uniswapRouter.deployed();
    await quoteToken.mint(uniswapRouter.address, uniswapAmountOut);

    const sushiRouter = await new MockSushiSwapRouter__factory(owner).deploy(
      sushiAmountOut
    );
    await sushiRouter.deployed();
    await quoteToken.mint(sushiRouter.address, sushiAmountOut);

    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
      .returns('0x7777777777777777777777777777777777777777');
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: uniswapAmountOut,
      } as any);
    sinon.stub(SushiSwapQuoteProvider.prototype, 'initialize').resolves(true);
    sinon.stub(SushiSwapQuoteProvider.prototype, 'poolExists').resolves(true);
    const sushiQuoteStub = sinon
      .stub(SushiSwapQuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: sushiAmountOut,
      } as any);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

    const poolView = {
      name: 'Market Factor Crossing Pool',
      poolAddress: pool.address,
      collateralAddress: collateralToken.address,
      quoteAddress: quoteToken.address,
      contract: pool,
    };
    const poolConfig = {
      name: 'Market Factor Crossing Pool',
      take: {
        liquiditySource: LiquiditySource.UNISWAPV3,
        marketPriceFactor: 0.99,
      },
    };
    const config = {
      universalRouterOverrides: {
        swapRouter02Address: uniswapRouter.address,
        poolFactoryAddress: '0x4444444444444444444444444444444444444444',
        defaultFeeTier: 3000,
        candidateFeeTiers: [],
        wethAddress: quoteToken.address,
        quoterV2Address: '0x6666666666666666666666666666666666666666',
        defaultSlippage: 1.0,
      },
      sushiswapRouterOverrides: {
        swapRouterAddress: sushiRouter.address,
        quoterV2Address: '0x9999999999999999999999999999999999999999',
        factoryAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        defaultFeeTier: 500,
        candidateFeeTiers: [],
        wethAddress: quoteToken.address,
        defaultSlippage: 1.0,
      },
    };
    const routeSelection = {
      allowedLiquiditySources: [
        LiquiditySource.UNISWAPV3,
        LiquiditySource.SUSHISWAP,
      ],
      routeProfitabilityContext: {
        routeExecutionCostQuoteRawBySource: {
          [LiquiditySource.UNISWAPV3]: utils.parseEther('0.1'),
          [LiquiditySource.SUSHISWAP]: utils.parseEther('0.05'),
        },
      },
    };
    const runtimeCache = createFactoryQuoteProviderRuntimeCache();

    const beforeRangeEvaluation = await getFactoryTakeQuoteEvaluation(
      poolView as any,
      beforeRangeAuctionPrice,
      collateral,
      poolConfig as any,
      config as any,
      owner,
      runtimeCache,
      routeSelection
    );

    expect(beforeRangeEvaluation.isTakeable).to.equal(false);
    expect(beforeRangeEvaluation.reason).to.contain(
      EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold
    );

    const inRangeEvaluation = await getFactoryTakeQuoteEvaluation(
      poolView as any,
      inRangeAuctionPrice,
      collateral,
      poolConfig as any,
      config as any,
      owner,
      runtimeCache,
      routeSelection
    );

    expect(inRangeEvaluation.isTakeable, inRangeEvaluation.reason).to.equal(
      true
    );
    expect(inRangeEvaluation.selectedLiquiditySource).to.equal(
      LiquiditySource.SUSHISWAP
    );
    expect(inRangeEvaluation.selectedFeeTier).to.equal(500);
    expect(
      inRangeEvaluation.routeProfitability?.expectedNetProfitQuoteRaw?.eq(
        sushiAmountOut.sub(inRangeAuctionPrice).sub(utils.parseEther('0.05'))
      )
    ).to.be.true;

    await pool.setQuoteAmountDue(inRangeAuctionPrice);
    const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);
    const takeCountBefore = await pool.takeCount();

    const executed = await takeLiquidationFactory({
      pool: poolView as any,
      poolConfig: poolConfig as any,
      signer: owner,
      liquidation: {
        borrower: BORROWER,
        hpbIndex: 0,
        collateral,
        auctionPrice: inRangeAuctionPrice,
        isTakeable: true,
        isArbTakeable: false,
        externalTakeQuoteEvaluation: inRangeEvaluation,
      },
      config: {
        dryRun: false,
        keeperTakerFactory: factory.address,
        universalRouterOverrides: config.universalRouterOverrides,
        sushiswapRouterOverrides: config.sushiswapRouterOverrides,
        runtimeCache,
      },
    });

    expect(executed).to.equal(true);
    expect((await pool.takeCount()).eq(takeCountBefore.add(1))).to.be.true;
    expect(await pool.lastCallee()).to.equal(sushiTaker.address);
    expect(await pool.lastBorrower()).to.equal(BORROWER);
    expect((await pool.lastCollateralTaken()).eq(collateral)).to.be.true;
    expect(
      (await quoteToken.balanceOf(owner.address)).eq(
        ownerQuoteBefore.add(sushiAmountOut.sub(inRangeAuctionPrice))
      )
    ).to.be.true;
    expect(uniswapQuoteStub.calledTwice).to.be.true;
    expect(sushiQuoteStub.calledTwice).to.be.true;
  });
});
