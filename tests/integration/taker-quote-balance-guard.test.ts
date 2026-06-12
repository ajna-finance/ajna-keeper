import { expect } from 'chai';
import { constants, utils } from 'ethers';
import { AjnaKeeperTaker__factory } from '../../typechain-types/factories/contracts';
import {
  MockCurveSwapPool__factory,
  MockOneInchUnderdeliveryRouter__factory,
  MockSushiSwapRouter__factory,
  MockSwapRouter__factory,
} from '../../typechain-types/factories/contracts/mocks';
import {
  CURVE_DETAILS_TYPE,
  DEADLINE,
  MockTakerBase,
  SUSHI_DETAILS_TYPE,
  deployCurveTaker,
  deployFundedSwapRouter02,
  deployMinOutBypassSwap,
  deployMockTakerBase,
  deploySushiTaker,
  deployUniswapTaker,
  encodeTakerCallbackData,
  encodeUniswapCallbackData,
  encodeUniswapDetails,
  expectRevertContaining,
} from './helpers/mock-taker-base';

const COLLATERAL_AMOUNT = utils.parseEther('10');
const QUOTE_AMOUNT_DUE = utils.parseEther('5');
const APPROVED_MIN_OUT = utils.parseEther('6');

const ONE_INCH_DETAILS_TYPE =
  '(address,(address,address,address,address,uint256,uint256,uint256),bytes)';
const ONE_INCH_CALLBACK_DATA_TYPE = '(uint8,address,bytes)';

describe('Taker quote balance guards', () => {
  async function expectNoFullTakeSideEffects(params: {
    takerAddress: string;
    pool: MockTakerBase['pool'];
    quoteToken: MockTakerBase['quoteToken'];
  }) {
    expect((await params.pool.takeCount()).eq(0)).to.equal(true);
    expect(
      (
        await params.quoteToken.allowance(
          params.takerAddress,
          params.pool.address
        )
      ).eq(0)
    ).to.equal(true);
  }

  it('rejects 1inch atomic routes that redirect output away from the taker', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployMockTakerBase();
    const taker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);

    const router = await new MockSwapRouter__factory(owner).deploy(0, 1);
    await router.deployed();

    const oneInchDetails = utils.defaultAbiCoder.encode(
      [ONE_INCH_DETAILS_TYPE],
      [
        [
          router.address,
          [
            collateralToken.address,
            quoteToken.address,
            router.address,
            owner.address,
            COLLATERAL_AMOUNT,
            0,
            0,
          ],
          '0x',
        ],
      ]
    );
    const callbackData = utils.defaultAbiCoder.encode(
      [ONE_INCH_CALLBACK_DATA_TYPE],
      [[1, router.address, oneInchDetails]]
    );

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InvalidSwapDetails'
    );
  });

  it('rejects 1inch atomic swaps that rely on preexisting quote balance', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployMockTakerBase();
    const taker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const router = await new MockSwapRouter__factory(owner).deploy(0, 1);
    await router.deployed();

    const oneInchDetails = utils.defaultAbiCoder.encode(
      [ONE_INCH_DETAILS_TYPE],
      [
        [
          router.address,
          [
            collateralToken.address,
            quoteToken.address,
            router.address,
            taker.address,
            COLLATERAL_AMOUNT,
            0,
            0,
          ],
          '0x',
        ],
      ]
    );
    const callbackData = utils.defaultAbiCoder.encode(
      [ONE_INCH_CALLBACK_DATA_TYPE],
      [[1, router.address, oneInchDetails]]
    );

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects 1inch atomic swaps that underdeliver versus the scaled minReturnAmount', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployMockTakerBase();
    const taker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);

    const router = await new MockOneInchUnderdeliveryRouter__factory(
      owner
    ).deploy(QUOTE_AMOUNT_DUE);
    await router.deployed();
    await quoteToken.mint(router.address, QUOTE_AMOUNT_DUE);

    const quotedCollateralAmount = COLLATERAL_AMOUNT.mul(2);
    const quotedMinReturnAmount = utils.parseEther('12');
    const oneInchDetails = utils.defaultAbiCoder.encode(
      [ONE_INCH_DETAILS_TYPE],
      [
        [
          router.address,
          [
            collateralToken.address,
            quoteToken.address,
            router.address,
            taker.address,
            quotedCollateralAmount,
            quotedMinReturnAmount,
            0,
          ],
          '0x',
        ],
      ]
    );
    const callbackData = utils.defaultAbiCoder.encode(
      [ONE_INCH_CALLBACK_DATA_TYPE],
      [[1, router.address, oneInchDetails]]
    );

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('executes uniswap callbacks through direct SwapRouter02 custody', async () => {
    const base = await deployMockTakerBase();
    const { collateralToken, quoteToken, pool } = base;
    const taker = await deployUniswapTaker(base);

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    const router = await deployFundedSwapRouter02(base, QUOTE_AMOUNT_DUE);

    const callbackData = encodeUniswapCallbackData({
      routerAddress: router.address,
      targetToken: quoteToken.address,
      amountOutMinimum: QUOTE_AMOUNT_DUE,
      plannedAmountIn: COLLATERAL_AMOUNT,
    });

    await pool.callAtomicSwapCallback(
      taker.address,
      COLLATERAL_AMOUNT,
      QUOTE_AMOUNT_DUE,
      callbackData
    );

    expect(
      (await collateralToken.balanceOf(router.address)).eq(COLLATERAL_AMOUNT)
    ).to.equal(true);
    expect(
      (await quoteToken.balanceOf(taker.address)).eq(QUOTE_AMOUNT_DUE)
    ).to.equal(true);
    expect(
      (await collateralToken.allowance(taker.address, router.address)).eq(0)
    ).to.equal(true);
  });

  it('executes full uniswap takes with direct SwapRouter02 and resets allowances', async () => {
    const base = await deployMockTakerBase();
    const { owner, collateralToken, quoteToken, pool } = base;
    const taker = await deployUniswapTaker(base);

    await pool.setQuoteAmountDue(QUOTE_AMOUNT_DUE);
    await collateralToken.mint(pool.address, COLLATERAL_AMOUNT);

    const router = await deployFundedSwapRouter02(base, QUOTE_AMOUNT_DUE);

    const swapDetails = encodeUniswapDetails({
      routerAddress: router.address,
      targetToken: quoteToken.address,
      amountOutMinimum: QUOTE_AMOUNT_DUE,
    });

    await taker.takeWithAtomicSwap(
      pool.address,
      owner.address,
      utils.parseEther('1'),
      COLLATERAL_AMOUNT,
      2,
      router.address,
      swapDetails
    );

    expect((await pool.takeCount()).eq(1)).to.equal(true);
    expect(
      (await collateralToken.balanceOf(router.address)).eq(COLLATERAL_AMOUNT)
    ).to.equal(true);
    expect((await quoteToken.balanceOf(pool.address)).eq(QUOTE_AMOUNT_DUE)).to
      .be.true;
    expect(
      (await collateralToken.allowance(taker.address, router.address)).eq(0)
    ).to.equal(true);
    expect(
      (await quoteToken.allowance(taker.address, pool.address)).eq(0)
    ).to.equal(true);
  });

  it('rejects full uniswap takes when the router argument differs from encoded details', async () => {
    const base = await deployMockTakerBase();
    const { owner, quoteToken, pool } = base;
    const taker = await deployUniswapTaker(base);

    const router = await deployFundedSwapRouter02(base, QUOTE_AMOUNT_DUE);
    const otherRouter = await deployFundedSwapRouter02(base, QUOTE_AMOUNT_DUE);

    const swapDetails = encodeUniswapDetails({
      routerAddress: router.address,
      targetToken: quoteToken.address,
      amountOutMinimum: QUOTE_AMOUNT_DUE,
    });

    await expectRevertContaining(
      taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        utils.parseEther('1'),
        COLLATERAL_AMOUNT,
        2,
        otherRouter.address,
        swapDetails
      ),
      'Router mismatch'
    );

    await expectNoFullTakeSideEffects({
      takerAddress: taker.address,
      pool,
      quoteToken,
    });
  });

  it('rejects full uniswap takes with expired deadlines', async () => {
    const base = await deployMockTakerBase();
    const { owner, quoteToken, pool } = base;
    const taker = await deployUniswapTaker(base);

    const router = await deployFundedSwapRouter02(base, QUOTE_AMOUNT_DUE);

    const swapDetails = encodeUniswapDetails({
      routerAddress: router.address,
      targetToken: quoteToken.address,
      amountOutMinimum: QUOTE_AMOUNT_DUE,
      deadline: 1,
    });

    await expectRevertContaining(
      taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        utils.parseEther('1'),
        COLLATERAL_AMOUNT,
        2,
        router.address,
        swapDetails
      ),
      'Expired deadline'
    );

    await expectNoFullTakeSideEffects({
      takerAddress: taker.address,
      pool,
      quoteToken,
    });
  });

  it('rejects full uniswap takes with zero amountOutMinimum', async () => {
    const base = await deployMockTakerBase();
    const { owner, quoteToken, pool } = base;
    const taker = await deployUniswapTaker(base);

    const router = await deployFundedSwapRouter02(base, QUOTE_AMOUNT_DUE);

    const swapDetails = encodeUniswapDetails({
      routerAddress: router.address,
      targetToken: quoteToken.address,
      amountOutMinimum: 0,
    });

    await expectRevertContaining(
      taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        utils.parseEther('1'),
        COLLATERAL_AMOUNT,
        2,
        router.address,
        swapDetails
      ),
      'Invalid minimum amount'
    );

    await expectNoFullTakeSideEffects({
      takerAddress: taker.address,
      pool,
      quoteToken,
    });
  });

  it('rejects uniswap callbacks that target anything other than pool quote', async () => {
    const base = await deployMockTakerBase();
    const { collateralToken, quoteToken, pool } = base;
    const taker = await deployUniswapTaker(base);

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    const router = await deployFundedSwapRouter02(base, QUOTE_AMOUNT_DUE);

    const callbackData = encodeUniswapCallbackData({
      routerAddress: router.address,
      targetToken: collateralToken.address,
      amountOutMinimum: QUOTE_AMOUNT_DUE,
      plannedAmountIn: COLLATERAL_AMOUNT,
    });

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InvalidSwapDetails'
    );

    expect((await collateralToken.balanceOf(router.address)).eq(0)).to.equal(
      true
    );
    expect((await quoteToken.balanceOf(taker.address)).eq(0)).to.equal(true);
  });

  it('rejects uniswap callbacks that do not increase quote balance', async () => {
    const base = await deployMockTakerBase();
    const { collateralToken, quoteToken, pool } = base;
    const taker = await deployUniswapTaker(base);

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    // Must bypass router-level min-out enforcement so the TAKER's balance-delta
    // guard is the one that fires: a plain funded router with zero output
    // reverts inside the mock router first, and the test never reaches
    // InsufficientQuoteReceived (a latent false-pass surfaced when revert
    // assertions were hardened to match extracted revert reasons only).
    const router = await deployMinOutBypassSwap(
      base,
      constants.Zero,
      constants.One
    );

    const callbackData = encodeUniswapCallbackData({
      routerAddress: router.address,
      targetToken: quoteToken.address,
      amountOutMinimum: 1,
      plannedAmountIn: COLLATERAL_AMOUNT,
    });

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects uniswap callbacks when actual quote received is below amountOutMinimum', async () => {
    const base = await deployMockTakerBase();
    const { collateralToken, quoteToken, pool } = base;
    const taker = await deployUniswapTaker(base);

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    const router = await deployMinOutBypassSwap(
      base,
      QUOTE_AMOUNT_DUE,
      APPROVED_MIN_OUT
    );

    const callbackData = encodeUniswapCallbackData({
      routerAddress: router.address,
      targetToken: quoteToken.address,
      amountOutMinimum: APPROVED_MIN_OUT,
      plannedAmountIn: COLLATERAL_AMOUNT,
    });

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects sushiswap callbacks that do not increase quote balance', async () => {
    const base = await deployMockTakerBase();
    const { owner, collateralToken, quoteToken, pool } = base;
    const taker = await deploySushiTaker(base);

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const router = await new MockSushiSwapRouter__factory(owner).deploy(0);
    await router.deployed();

    const callbackData = encodeTakerCallbackData(
      SUSHI_DETAILS_TYPE,
      [router.address, quoteToken.address, 500, 0, DEADLINE],
      COLLATERAL_AMOUNT
    );

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects sushiswap callbacks when actual quote received is below amountOutMinimum', async () => {
    const base = await deployMockTakerBase();
    const { collateralToken, quoteToken, pool } = base;
    const taker = await deploySushiTaker(base);

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    const router = await deployMinOutBypassSwap(
      base,
      QUOTE_AMOUNT_DUE,
      APPROVED_MIN_OUT
    );

    const callbackData = encodeTakerCallbackData(
      SUSHI_DETAILS_TYPE,
      [router.address, quoteToken.address, 500, APPROVED_MIN_OUT, DEADLINE],
      COLLATERAL_AMOUNT
    );

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects curve callbacks that trust forged return values without quote balance increase', async () => {
    const base = await deployMockTakerBase();
    const { owner, collateralToken, quoteToken, pool } = base;
    const taker = await deployCurveTaker(base);

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const curvePool = await new MockCurveSwapPool__factory(owner).deploy(
      collateralToken.address,
      1
    );
    await curvePool.deployed();

    const callbackData = encodeTakerCallbackData(
      CURVE_DETAILS_TYPE,
      [
        curvePool.address,
        collateralToken.address,
        quoteToken.address,
        0,
        0,
        1,
        0,
        DEADLINE,
      ],
      COLLATERAL_AMOUNT
    );

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects curve callbacks when actual quote received is below amountOutMinimum', async () => {
    const base = await deployMockTakerBase();
    const { collateralToken, quoteToken, pool } = base;
    const taker = await deployCurveTaker(base);

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    const curvePool = await deployMinOutBypassSwap(
      base,
      QUOTE_AMOUNT_DUE,
      APPROVED_MIN_OUT
    );

    const callbackData = encodeTakerCallbackData(
      CURVE_DETAILS_TYPE,
      [
        curvePool.address,
        collateralToken.address,
        quoteToken.address,
        0,
        0,
        1,
        APPROVED_MIN_OUT,
        DEADLINE,
      ],
      COLLATERAL_AMOUNT
    );

    await expectRevertContaining(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });
});
