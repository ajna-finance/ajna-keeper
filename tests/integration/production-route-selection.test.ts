import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, Wallet, constants, ethers, utils } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import * as erc20 from '../../src/erc20';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import {
  getDirectDexTakeQuoteEvaluation,
  takeLiquidationDirectDex,
} from '../../src/take/direct-dex';
import { bindExternalTakeRouteForCandidate } from '../../src/take/external-take/quote-approval-rules';
import { EXTERNAL_TAKE_REJECTION_REASONS } from '../../src/take/external-take/policy';
import { createDirectDexQuoteProviderRuntimeCache } from '../../src/take/direct-dex/runtime-cache';
import { singleExternalTakeExecutionPlan } from '../helpers/external-take-plan';
import { getProvider, resetHardhat } from './test-utils';
import {
  APPROVED_MIN_OUT,
  asFungiblePool,
  AUCTION_PRICE,
  BORROWER,
  buildApprovedDirectDexQuoteEvaluation,
  buildDirectDexPoolView,
  buildDirectDexTakePoolConfig,
  COLLATERAL_AMOUNT,
  DEADLINE,
  deployDirectDexHarness,
  deployFundedSwapRouter02,
  expectDirectDexExecutionRejectedWithoutStateMutation,
  expectSuccessfulDirectDexTake,
  expectUniswapNonSwapRouterExecutionRejectedWithoutStateMutation,
  QUOTE_AMOUNT_DUE,
  ROUTER_AMOUNT_OUT,
  USDC_APPROVED_MIN_OUT,
  USDC_QUOTE_AMOUNT_DUE,
  USDC_QUOTE_TOKEN_SCALE,
  USDC_ROUTER_AMOUNT_OUT,
} from './helpers/direct-dex-route-harness';

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

  it('executes Uniswap V3 direct DEX takes with selected fee tier and bound min-out', async () => {
    await expectSuccessfulDirectDexTake({
      source: LiquiditySource.UNISWAPV3,
    });
  });

  // Direct-SushiSwap direct DEX take case removed with the direct Sushi path; the
  // Uniswap V3 and Curve cases cover direct DEX execution.

  it('executes Curve direct DEX takes through stable and crypto dispatch', async () => {
    await expectSuccessfulDirectDexTake({
      source: LiquiditySource.CURVE,
      poolType: CurvePoolType.STABLE,
    });
    await expectSuccessfulDirectDexTake({
      source: LiquiditySource.CURVE,
      poolType: CurvePoolType.CRYPTO,
    });
  });

  it('executes Uniswap direct DEX takes with non-18-decimal quote token raw units', async () => {
    const harness = await deployDirectDexHarness({
      quoteDecimals: 6,
      quoteTokenScale: USDC_QUOTE_TOKEN_SCALE,
      quoteAmountDue: USDC_QUOTE_AMOUNT_DUE,
    });
    const {
      owner,
      collateralToken,
      quoteToken,
      pool,
      router: takerRouter,
      uniswapTaker,
    } = harness;

    const swapRouter = await deployFundedSwapRouter02(
      harness,
      USDC_ROUTER_AMOUNT_OUT
    );

    const poolQuoteBefore = await quoteToken.balanceOf(pool.address);
    const poolCollateralBefore = await collateralToken.balanceOf(pool.address);
    const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);
    const takeCountBefore = await pool.takeCount();
    const poolView = buildDirectDexPoolView({
      pool,
      collateralToken,
      quoteToken,
      name: 'USDC Quote Direct DEX Route Pool',
    });
    const quoteEvaluation = buildApprovedDirectDexQuoteEvaluation({
      source: LiquiditySource.UNISWAPV3,
      quoteAmountRaw: USDC_ROUTER_AMOUNT_OUT,
      routeMinOutRaw: USDC_APPROVED_MIN_OUT,
      selectedFeeTier: 500,
    });

    const executed = await takeLiquidationDirectDex({
      pool: asFungiblePool(poolView),
      poolConfig: buildDirectDexTakePoolConfig(
        poolView,
        LiquiditySource.UNISWAPV3
      ),
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
      config: {
        dryRun: false,
        keeperTakerRouter: takerRouter.address,
        uniswapV3RouterOverrides: {
          swapRouter02Address: swapRouter.address,
          poolFactoryAddress: '0x4444444444444444444444444444444444444444',
          wethAddress: quoteToken.address,
          quoterV2Address: '0x6666666666666666666666666666666666666666',
          defaultFeeTier: 500,
        },
        runtimeCache: createDirectDexQuoteProviderRuntimeCache(),
      },
    });

    expect(executed).to.equal(true);
    expect((await pool.takeCount()).eq(takeCountBefore.add(1))).to.be.true;
    expect(
      (await quoteToken.balanceOf(pool.address)).eq(
        poolQuoteBefore.add(USDC_QUOTE_AMOUNT_DUE)
      )
    ).to.be.true;
    expect(
      (await collateralToken.balanceOf(pool.address)).eq(
        poolCollateralBefore.sub(COLLATERAL_AMOUNT)
      )
    ).to.be.true;
    expect(
      (await quoteToken.balanceOf(owner.address)).eq(
        ownerQuoteBefore.add(USDC_ROUTER_AMOUNT_OUT.sub(USDC_QUOTE_AMOUNT_DUE))
      )
    ).to.be.true;
    expect(
      (await quoteToken.allowance(uniswapTaker.address, pool.address)).eq(
        constants.Zero
      )
    ).to.be.true;
  });

  it('rejects direct DEX routes that underdeliver below the configured profit floor', async () => {
    const routeFloor = QUOTE_AMOUNT_DUE.add(utils.parseEther('0.2'));
    const profitFloor = APPROVED_MIN_OUT;
    const underDeliveredOutput = profitFloor.sub(1);

    for (const source of [LiquiditySource.UNISWAPV3, LiquiditySource.CURVE]) {
      await expectDirectDexExecutionRejectedWithoutStateMutation({
        source,
        routerAmountOut: underDeliveredOutput,
        routeMinOutRaw: routeFloor,
        profitMinOutRaw: profitFloor,
        approvedMinOutRaw: routeFloor,
        quoteAmountRaw: ROUTER_AMOUNT_OUT,
        selectedFeeTier: 500,
        expectedFailureReason:
          /insufficient output amount|InsufficientQuoteReceived/i,
      });
    }
  });

  it('fails closed when a Universal Router-style address is configured as SwapRouter02', async () => {
    await expectUniswapNonSwapRouterExecutionRejectedWithoutStateMutation({
      routerAmountOut: ROUTER_AMOUNT_OUT,
      routeMinOutRaw: APPROVED_MIN_OUT,
      quoteAmountRaw: ROUTER_AMOUNT_OUT,
      selectedFeeTier: 500,
      expectedFailureReason:
        /estimate|revert|function selector|missing revert data|UNPREDICTABLE_GAS_LIMIT/i,
    });
  });

  it('fails stale direct DEX routes without clearing collateral or weakening min-out', async () => {
    const harness = await deployDirectDexHarness();
    const {
      quoteToken,
      collateralToken,
      pool,
      router: takerRouter,
      uniswapTaker,
    } = harness;
    // Router delivers below the encoded min-out, so the swap reverts inside the
    // router and the take fails closed without mutating pool state.
    const staleAmountOut = QUOTE_AMOUNT_DUE.add(utils.parseEther('0.1'));
    const swapRouter = await deployFundedSwapRouter02(harness, staleAmountOut);

    const poolQuoteBefore = await quoteToken.balanceOf(pool.address);
    const poolCollateralBefore = await collateralToken.balanceOf(pool.address);
    const swapDetails = utils.defaultAbiCoder.encode(
      ['(address,address,uint24,uint256,uint256)'],
      [
        [
          swapRouter.address,
          quoteToken.address,
          500,
          APPROVED_MIN_OUT,
          DEADLINE,
        ],
      ]
    );

    await expectRevert(
      takerRouter.takeWithAtomicSwap(
        pool.address,
        BORROWER,
        AUCTION_PRICE,
        COLLATERAL_AMOUNT,
        LiquiditySource.UNISWAPV3,
        swapRouter.address,
        swapDetails
      ),
      'insufficient output amount'
    );

    expect((await pool.takeCount()).eq(constants.Zero)).to.be.true;
    expect((await quoteToken.balanceOf(pool.address)).eq(poolQuoteBefore)).to.be
      .true;
    expect(
      (await collateralToken.balanceOf(pool.address)).eq(poolCollateralBefore)
    ).to.be.true;
    expect(
      (await quoteToken.allowance(uniswapTaker.address, pool.address)).eq(
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

    const evaluation = await getDirectDexTakeQuoteEvaluation(
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
        uniswapV3RouterOverrides: {
          swapRouter02Address: '0x3333333333333333333333333333333333333333',
          poolFactoryAddress: '0x4444444444444444444444444444444444444444',
          defaultFeeTier: 3000,
          candidateFeeTiers: [500],
          wethAddress: '0x5555555555555555555555555555555555555555',
          quoterV2Address: '0x6666666666666666666666666666666666666666',
        },
      } as any,
      Wallet.createRandom().connect(getProvider()) as any,
      createDirectDexQuoteProviderRuntimeCache(),
      {
        routeQuoteBudgetPerCandidate: 1,
      }
    );

    expect(evaluation.isTakeable).to.be.false;
    expect(evaluation.reason).to.contain('skipped by route quote budget');
    expect(evaluation.reason).to.contain('UNISWAPV3:500');
  });

  it('waits for marketPriceFactor range, then selects and executes the route', async () => {
    // Migrated off the direct-Sushi two-source variant: this exercises the
    // marketPriceFactor range gating plus end-to-end execution on UniswapV3.
    // Multi-source best-route selection is covered by the
    // hybrid-external-take-selection unit tests.
    const harness = await deployDirectDexHarness();
    const {
      owner,
      collateralToken,
      quoteToken,
      pool,
      router: takerRouter,
      uniswapTaker,
    } = harness;
    const collateral = utils.parseEther('1');
    const beforeRangeAuctionPrice = utils.parseEther('119');
    const inRangeAuctionPrice = utils.parseEther('117.8');
    const uniswapAmountOut = utils.parseEther('120');

    const uniswapRouter = await deployFundedSwapRouter02(
      harness,
      uniswapAmountOut
    );

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
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

    const poolView = buildDirectDexPoolView({
      pool,
      collateralToken,
      quoteToken,
      name: 'Market Factor Crossing Pool',
    });
    const poolConfig = buildDirectDexTakePoolConfig(
      poolView,
      LiquiditySource.UNISWAPV3
    );
    const config = {
      uniswapV3RouterOverrides: {
        swapRouter02Address: uniswapRouter.address,
        poolFactoryAddress: '0x4444444444444444444444444444444444444444',
        defaultFeeTier: 3000,
        candidateFeeTiers: [],
        wethAddress: quoteToken.address,
        quoterV2Address: '0x6666666666666666666666666666666666666666',
        defaultSlippage: 1.0,
      },
    };
    const routeSelection = {
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      routeProfitabilityContext: {
        routeExecutionCostQuoteRawBySource: {
          [LiquiditySource.UNISWAPV3]: utils.parseEther('0.1'),
        },
      },
    };
    const runtimeCache = createDirectDexQuoteProviderRuntimeCache();

    const beforeRangeEvaluation = await getDirectDexTakeQuoteEvaluation(
      asFungiblePool(poolView),
      beforeRangeAuctionPrice,
      collateral,
      poolConfig,
      config,
      owner,
      runtimeCache,
      routeSelection
    );

    expect(beforeRangeEvaluation.isTakeable).to.equal(false);
    expect(beforeRangeEvaluation.reason).to.contain(
      EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold
    );

    const inRangeEvaluation = await getDirectDexTakeQuoteEvaluation(
      asFungiblePool(poolView),
      inRangeAuctionPrice,
      collateral,
      poolConfig,
      config,
      owner,
      runtimeCache,
      routeSelection
    );

    expect(inRangeEvaluation.isTakeable, inRangeEvaluation.reason).to.equal(
      true
    );
    expect(inRangeEvaluation.selectedLiquiditySource).to.equal(
      LiquiditySource.UNISWAPV3
    );
    expect(
      inRangeEvaluation.routeProfitability?.expectedNetProfitQuoteRaw?.eq(
        uniswapAmountOut.sub(inRangeAuctionPrice).sub(utils.parseEther('0.1'))
      )
    ).to.be.true;
    const boundInRangeEvaluation = bindExternalTakeRouteForCandidate({
      quoteEvaluation: inRangeEvaluation,
      poolName: poolView.name,
      borrower: BORROWER,
    });
    if (!boundInRangeEvaluation.bound) {
      throw new Error(boundInRangeEvaluation.reason);
    }

    await pool.setQuoteAmountDue(inRangeAuctionPrice);
    const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);
    const takeCountBefore = await pool.takeCount();

    const executed = await takeLiquidationDirectDex({
      pool: asFungiblePool(poolView),
      poolConfig,
      signer: owner,
      liquidation: {
        borrower: BORROWER,
        hpbIndex: 0,
        collateral,
        auctionPrice: inRangeAuctionPrice,
        isTakeable: true,
        isArbTakeable: false,
        externalTakeExecutionPlan: singleExternalTakeExecutionPlan(
          boundInRangeEvaluation.quoteEvaluation
        ),
      },
      config: {
        dryRun: false,
        keeperTakerRouter: takerRouter.address,
        uniswapV3RouterOverrides: config.uniswapV3RouterOverrides,
        runtimeCache,
      },
    });

    expect(executed).to.equal(true);
    expect((await pool.takeCount()).eq(takeCountBefore.add(1))).to.be.true;
    expect(await pool.lastCallee()).to.equal(uniswapTaker.address);
    expect(await pool.lastBorrower()).to.equal(BORROWER);
    expect((await pool.lastCollateralTaken()).eq(collateral)).to.be.true;
    expect(
      (await quoteToken.balanceOf(owner.address)).eq(
        ownerQuoteBefore.add(uniswapAmountOut.sub(inRangeAuctionPrice))
      )
    ).to.be.true;
    expect(uniswapQuoteStub.calledTwice).to.be.true;
  });
});
