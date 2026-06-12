import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import { AjnaKeeperTaker__factory } from '../../typechain-types/factories/contracts';
import { CurveKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import {
  MockCurveTricryptoPool__factory,
  MockERC20__factory,
  MockOneInchUnderdeliveryRouter__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { MockReentrantOneInchRouter__factory } from '../../typechain-types/factories/contracts/mocks/MockReentrantOneInchRouter.sol';
import {
  CURVE_DETAILS_TYPE,
  DEADLINE,
  MockTakerBase,
  SUSHI_DETAILS_TYPE,
  deployCurveTaker,
  deployFundedCurvePool,
  deployFundedSushiRouter,
  deployFundedSwapRouter02,
  deployMockTakerBase,
  deploySushiTaker,
  deployUniswapTaker,
  encodeCurveKeeperDetails,
  encodeSushiKeeperDetails,
  encodeTakerCallbackData,
  encodeUniswapDetails,
  expectRevertContaining,
} from './helpers/mock-taker-base';

const MAX_AMOUNT = utils.parseEther('10');
const TAKEN_PARTIAL = utils.parseEther('4');
const FULL_MIN_OUT = utils.parseEther('6');
const DUE_PARTIAL = utils.parseEther('1.8');
const DUE_FULL = utils.parseEther('5');
const AUCTION_PRICE = utils.parseEther('1');
const SOURCE_ONEINCH = 1;
const SOURCE_UNISWAP_V3 = 2;
const SOURCE_SUSHISWAP = 3;
const SOURCE_CURVE = 4;

const ONE_INCH_DETAILS_TYPE =
  '(address,(address,address,address,address,uint256,uint256,uint256),bytes)';

async function deployFundedTricryptoPool(
  base: MockTakerBase,
  amountOut: BigNumber
) {
  const curvePool = await new MockCurveTricryptoPool__factory(
    base.owner
  ).deploy(base.collateralToken.address, amountOut);
  await curvePool.deployed();
  await curvePool.setTokenOut(base.quoteToken.address);
  if (amountOut.gt(0)) {
    await base.quoteToken.mint(curvePool.address, amountOut);
  }
  return curvePool;
}

function encodeOneInchDetails(params: {
  executor: string;
  srcToken: string;
  dstToken: string;
  srcReceiver: string;
  dstReceiver: string;
  amount: BigNumber;
  minReturnAmount: BigNumber;
}) {
  return utils.defaultAbiCoder.encode(
    [ONE_INCH_DETAILS_TYPE],
    [
      [
        params.executor,
        [
          params.srcToken,
          params.dstToken,
          params.srcReceiver,
          params.dstReceiver,
          params.amount,
          params.minReturnAmount,
          0,
        ],
        '0x',
      ],
    ]
  );
}

describe('Taker hardening regressions', () => {
  describe('CurveKeeperTaker CryptoSwap ABI compatibility', () => {
    // tricrypto2 / tricrypto-NG expose only the 4/5-arg exchange forms; the previous
    // 6-arg encoding always reverted against them. These exercise the universal
    // 4-arg call against a mock with exactly that restricted ABI surface.
    it('executes a full-fill take against a tricrypto-style pool', async () => {
      const base = await deployMockTakerBase();
      const { owner, collateralToken, quoteToken, pool } = base;
      const taker = await deployCurveTaker(base);

      await pool.setQuoteAmountDue(DUE_FULL);
      await collateralToken.mint(pool.address, MAX_AMOUNT);

      const routerOutput = utils.parseEther('7');
      const curvePool = await deployFundedTricryptoPool(base, routerOutput);

      const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);

      await taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_CURVE,
        curvePool.address,
        encodeCurveKeeperDetails(curvePool.address, FULL_MIN_OUT, {
          poolType: 1,
        })
      );

      expect((await pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await collateralToken.balanceOf(curvePool.address)).eq(MAX_AMOUNT)
      ).to.equal(true);
      expect(
        (await quoteToken.balanceOf(owner.address)).eq(
          ownerQuoteBefore.add(routerOutput.sub(DUE_FULL))
        )
      ).to.equal(true);
    });

    it('executes a debt-constrained partial fill against a tricrypto-style pool', async () => {
      const base = await deployMockTakerBase();
      const { collateralToken, owner, pool } = base;
      const taker = await deployCurveTaker(base);

      await pool.setCollateralTakenOverride(TAKEN_PARTIAL);
      await pool.setQuoteAmountDue(DUE_PARTIAL);
      await collateralToken.mint(pool.address, TAKEN_PARTIAL);

      const curvePool = await deployFundedTricryptoPool(
        base,
        utils.parseEther('2.5')
      );

      await taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_CURVE,
        curvePool.address,
        encodeCurveKeeperDetails(curvePool.address, FULL_MIN_OUT, {
          poolType: 1,
        })
      );

      expect((await pool.takeCount()).eq(1)).to.equal(true);
    });

    it('keeps CryptoSwap takes working against factory-style pools exposing all arities', async () => {
      const base = await deployMockTakerBase();
      const { collateralToken, owner, pool } = base;
      const taker = await deployCurveTaker(base);

      await pool.setQuoteAmountDue(DUE_FULL);
      await collateralToken.mint(pool.address, MAX_AMOUNT);

      const curvePool = await deployFundedCurvePool(
        base,
        utils.parseEther('7')
      );

      await taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_CURVE,
        curvePool.address,
        encodeCurveKeeperDetails(curvePool.address, FULL_MIN_OUT, {
          poolType: 1,
        })
      );

      expect((await pool.takeCount()).eq(1)).to.equal(true);
    });

    it('rejects swapDetails shorter than the 6-field encoding with the custom error', async () => {
      const base = await deployMockTakerBase();
      const { owner, pool } = base;
      const taker = await deployCurveTaker(base);
      const curvePool = await deployFundedCurvePool(base, FULL_MIN_OUT);

      // 5 words = 160 bytes: previously passed the (wrong) length check and
      // died inside abi.decode with a generic revert instead of this error.
      const shortDetails = utils.defaultAbiCoder.encode(
        ['address', 'uint8', 'uint8', 'uint8', 'uint256'],
        [curvePool.address, 0, 0, 1, FULL_MIN_OUT]
      );

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_CURVE,
          curvePool.address,
          shortDetails
        ),
        'InvalidSwapDetails'
      );
    });
  });

  describe('callback output-token binding', () => {
    it('rejects crafted sushiswap callbacks whose target token is not the pool quote', async () => {
      const base = await deployMockTakerBase();
      const { owner, pool } = base;
      const taker = await deploySushiTaker(base);

      const fakeToken = await new MockERC20__factory(owner).deploy(
        'Fake Quote',
        'FAKE',
        18
      );
      await fakeToken.deployed();

      const callbackData = encodeTakerCallbackData(
        SUSHI_DETAILS_TYPE,
        [owner.address, fakeToken.address, 500, FULL_MIN_OUT, DEADLINE],
        MAX_AMOUNT
      );

      await expectRevertContaining(
        pool.callAtomicSwapCallback(
          taker.address,
          TAKEN_PARTIAL,
          DUE_PARTIAL,
          callbackData
        ),
        'InvalidSwapDetails'
      );
    });

    it('rejects crafted curve callbacks whose tokenOut is not the pool quote', async () => {
      const base = await deployMockTakerBase();
      const { collateralToken, owner, pool } = base;
      const taker = await deployCurveTaker(base);

      const fakeToken = await new MockERC20__factory(owner).deploy(
        'Fake Quote',
        'FAKE',
        18
      );
      await fakeToken.deployed();
      const curvePool = await deployFundedCurvePool(base, FULL_MIN_OUT);

      const callbackData = encodeTakerCallbackData(
        CURVE_DETAILS_TYPE,
        [
          curvePool.address,
          collateralToken.address,
          fakeToken.address,
          0,
          0,
          1,
          FULL_MIN_OUT,
          DEADLINE,
        ],
        MAX_AMOUNT
      );

      await expectRevertContaining(
        pool.callAtomicSwapCallback(
          taker.address,
          TAKEN_PARTIAL,
          DUE_PARTIAL,
          callbackData
        ),
        'InvalidSwapDetails'
      );
    });

    it('rejects crafted curve callbacks whose tokenIn is not the pool collateral', async () => {
      const base = await deployMockTakerBase();
      const { owner, pool, quoteToken } = base;
      const taker = await deployCurveTaker(base);

      const fakeToken = await new MockERC20__factory(owner).deploy(
        'Fake Collateral',
        'FAKE',
        18
      );
      await fakeToken.deployed();
      const curvePool = await deployFundedCurvePool(base, FULL_MIN_OUT);

      const callbackData = encodeTakerCallbackData(
        CURVE_DETAILS_TYPE,
        [
          curvePool.address,
          fakeToken.address,
          quoteToken.address,
          0,
          0,
          1,
          FULL_MIN_OUT,
          DEADLINE,
        ],
        MAX_AMOUNT
      );

      await expectRevertContaining(
        pool.callAtomicSwapCallback(
          taker.address,
          TAKEN_PARTIAL,
          DUE_PARTIAL,
          callbackData
        ),
        'InvalidSwapDetails'
      );
    });
  });

  describe('AjnaKeeperTaker 1inch min-return rounding', () => {
    // planned 3, actual 1, full min-return 10: the pro-rated floor must be
    // ceil(10/3) = 4. Floor division (the old behavior) demanded only 3.
    const PLANNED = BigNumber.from(3);
    const TAKEN = BigNumber.from(1);
    const FULL_MIN_RETURN = BigNumber.from(10);
    const DUE = BigNumber.from(1);

    async function setupOneInchPartialFill(forcedReturnAmount: BigNumber) {
      const base = await deployMockTakerBase();
      const taker = await new AjnaKeeperTaker__factory(base.owner).deploy(
        base.poolDeployer.address
      );
      await taker.deployed();

      await base.pool.setCollateralTakenOverride(TAKEN);
      await base.pool.setQuoteAmountDue(DUE);
      await base.collateralToken.mint(base.pool.address, TAKEN);

      const router = await new MockOneInchUnderdeliveryRouter__factory(
        base.owner
      ).deploy(forcedReturnAmount);
      await router.deployed();
      await base.quoteToken.mint(router.address, FULL_MIN_RETURN);

      const details = encodeOneInchDetails({
        executor: router.address,
        srcToken: base.collateralToken.address,
        dstToken: base.quoteToken.address,
        srcReceiver: router.address,
        dstReceiver: taker.address,
        amount: PLANNED,
        minReturnAmount: FULL_MIN_RETURN,
      });

      return { base, taker, router, details };
    }

    it('rejects routes that satisfy only the floored pro-rata minimum', async () => {
      const { base, taker, router, details } = await setupOneInchPartialFill(
        BigNumber.from(3)
      );

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          base.pool.address,
          base.owner.address,
          AUCTION_PRICE,
          PLANNED,
          SOURCE_ONEINCH,
          router.address,
          details
        ),
        'InsufficientQuoteReceived'
      );
    });

    it('accepts routes that meet the rounded-up pro-rata minimum', async () => {
      const { base, taker, router, details } = await setupOneInchPartialFill(
        BigNumber.from(4)
      );

      const receipt = await (
        await taker.takeWithAtomicSwap(
          base.pool.address,
          base.owner.address,
          AUCTION_PRICE,
          PLANNED,
          SOURCE_ONEINCH,
          router.address,
          details
        )
      ).wait();

      expect((await base.pool.takeCount()).eq(1)).to.equal(true);

      // AUDIT FIX regression: the direct 1inch taker previously emitted no events
      // at all, leaving direct takes invisible to per-swap monitoring.
      const swapEvent = receipt.events?.find((e) => e.event === 'SwapExecuted');
      expect(swapEvent, 'expected a SwapExecuted event').to.not.equal(
        undefined
      );
      expect(swapEvent!.args!.tokenIn).to.equal(base.collateralToken.address);
      expect(swapEvent!.args!.tokenOut).to.equal(base.quoteToken.address);
      expect(swapEvent!.args!.amountIn.eq(TAKEN)).to.equal(true);
      expect(swapEvent!.args!.amountOut.eq(BigNumber.from(4))).to.equal(true);
    });
  });

  describe('quote pull ceiling for non-18-decimal quote tokens', () => {
    // Real Ajna passes floor(quoteWad/scale) to the callback but pulls
    // ceil(quoteWad/scale) afterwards. With quoteTokenScale > 1 the takers must
    // demand one extra token-wei so the guard fails cleanly instead of the
    // pool's pull failing deep inside the take.
    const QUOTE_SCALE = BigNumber.from(10).pow(12);
    const DUE_RAW = BigNumber.from(5_000_000); // 5 USDC at 6 decimals

    async function setupScaledQuoteBase() {
      const base = await deployMockTakerBase({
        quoteDecimals: 6,
        quoteTokenScale: QUOTE_SCALE,
      });
      await base.pool.setQuoteAmountDue(DUE_RAW);
      await base.pool.setQuotePullOverride(DUE_RAW.add(1));
      await base.collateralToken.mint(base.pool.address, MAX_AMOUNT);
      return base;
    }

    it('rejects uniswap swaps that only cover the floored quote due', async () => {
      const base = await setupScaledQuoteBase();
      const taker = await deployUniswapTaker(base);
      const router = await deployFundedSwapRouter02(base, DUE_RAW);

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          base.pool.address,
          base.owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_UNISWAP_V3,
          router.address,
          encodeUniswapDetails({
            routerAddress: router.address,
            targetToken: base.quoteToken.address,
            amountOutMinimum: 1,
          })
        ),
        'InsufficientQuoteReceived'
      );
    });

    it('accepts uniswap swaps that cover the ceil-rounded pull and repays the pool in full', async () => {
      const base = await setupScaledQuoteBase();
      const taker = await deployUniswapTaker(base);
      const router = await deployFundedSwapRouter02(base, DUE_RAW.add(1));

      await taker.takeWithAtomicSwap(
        base.pool.address,
        base.owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_UNISWAP_V3,
        router.address,
        encodeUniswapDetails({
          routerAddress: router.address,
          targetToken: base.quoteToken.address,
          amountOutMinimum: 1,
        })
      );

      expect((await base.pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await base.quoteToken.balanceOf(base.pool.address)).eq(
          DUE_RAW.add(1)
        )
      ).to.equal(true);
    });

    it('documents the conservative over-reject when the quote due divides exactly', async () => {
      // When the WAD due divides exactly by the scale, the pool pulls only the
      // floored due — output exactly equal to it WOULD settle. The unconditional
      // +1 still rejects this zero-margin knife edge (see quoteAmountDueCeiling
      // natspec); the off-chain sizer never plans such a route. This test pins
      // that tradeoff: relaxing it must consciously change this expectation.
      const base = await deployMockTakerBase({
        quoteDecimals: 6,
        quoteTokenScale: QUOTE_SCALE,
      });
      await base.pool.setQuoteAmountDue(DUE_RAW); // pull stays == due (no override)
      await base.collateralToken.mint(base.pool.address, MAX_AMOUNT);
      const taker = await deployUniswapTaker(base);
      const router = await deployFundedSwapRouter02(base, DUE_RAW);

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          base.pool.address,
          base.owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_UNISWAP_V3,
          router.address,
          encodeUniswapDetails({
            routerAddress: router.address,
            targetToken: base.quoteToken.address,
            amountOutMinimum: 1,
          })
        ),
        'InsufficientQuoteReceived'
      );
    });

    it('rejects sushiswap swaps that only cover the floored quote due', async () => {
      const base = await setupScaledQuoteBase();
      const taker = await deploySushiTaker(base);
      const router = await deployFundedSushiRouter(base, DUE_RAW);

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          base.pool.address,
          base.owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_SUSHISWAP,
          router.address,
          encodeSushiKeeperDetails(BigNumber.from(1))
        ),
        'InsufficientQuoteReceived'
      );
    });

    it('accepts sushiswap swaps that cover the ceil-rounded pull', async () => {
      const base = await setupScaledQuoteBase();
      const taker = await deploySushiTaker(base);
      const router = await deployFundedSushiRouter(base, DUE_RAW.add(1));

      const receipt = await (
        await taker.takeWithAtomicSwap(
          base.pool.address,
          base.owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_SUSHISWAP,
          router.address,
          encodeSushiKeeperDetails(BigNumber.from(1))
        )
      ).wait();

      expect((await base.pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await base.quoteToken.balanceOf(base.pool.address)).eq(
          DUE_RAW.add(1)
        )
      ).to.equal(true);

      // AUDIT FIX regression: SwapExecuted was declared but never emitted,
      // leaving successful Sushi takes invisible to per-swap monitoring.
      const swapEvent = receipt.events?.find((e) => e.event === 'SwapExecuted');
      expect(swapEvent, 'expected a SwapExecuted event').to.not.equal(
        undefined
      );
      expect(swapEvent!.args!.tokenIn).to.equal(base.collateralToken.address);
      expect(swapEvent!.args!.tokenOut).to.equal(base.quoteToken.address);
      expect(swapEvent!.args!.amountIn.eq(MAX_AMOUNT)).to.equal(true);
      expect(swapEvent!.args!.amountOut.eq(DUE_RAW.add(1))).to.equal(true);
    });

    it('rejects curve swaps that only cover the floored quote due', async () => {
      const base = await setupScaledQuoteBase();
      const taker = await deployCurveTaker(base);
      const curvePool = await deployFundedCurvePool(base, DUE_RAW);

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          base.pool.address,
          base.owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_CURVE,
          curvePool.address,
          encodeCurveKeeperDetails(curvePool.address, BigNumber.from(1))
        ),
        'InsufficientQuoteReceived'
      );
    });

    it('accepts curve swaps that cover the ceil-rounded pull', async () => {
      const base = await setupScaledQuoteBase();
      const taker = await deployCurveTaker(base);
      const curvePool = await deployFundedCurvePool(base, DUE_RAW.add(1));

      await taker.takeWithAtomicSwap(
        base.pool.address,
        base.owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_CURVE,
        curvePool.address,
        encodeCurveKeeperDetails(curvePool.address, BigNumber.from(1))
      );

      expect((await base.pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await base.quoteToken.balanceOf(base.pool.address)).eq(
          DUE_RAW.add(1)
        )
      ).to.equal(true);
    });
  });

  describe('AjnaKeeperTaker reentrancy guard', () => {
    it('blocks a malicious router from re-entering the callback through a second take', async () => {
      const base = await deployMockTakerBase();
      const { collateralToken, owner, pool } = base;
      const taker = await new AjnaKeeperTaker__factory(owner).deploy(
        base.poolDeployer.address
      );
      await taker.deployed();

      const takeAmount = utils.parseEther('2');
      await pool.setQuoteAmountDue(0);
      // Fund the pool for both the outer take and the attempted nested take.
      await collateralToken.mint(pool.address, takeAmount.mul(2));

      const router = await new MockReentrantOneInchRouter__factory(
        owner
      ).deploy();
      await router.deployed();
      await router.setReentry(
        pool.address,
        owner.address,
        takeAmount,
        taker.address,
        '0x'
      );

      const details = encodeOneInchDetails({
        executor: router.address,
        srcToken: collateralToken.address,
        dstToken: base.quoteToken.address,
        srcReceiver: router.address,
        dstReceiver: taker.address,
        amount: takeAmount,
        minReturnAmount: BigNumber.from(1),
      });

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          takeAmount,
          SOURCE_ONEINCH,
          router.address,
          details
        ),
        'ReentrancyGuard: reentrant call'
      );
    });
  });

  describe('constructor validation', () => {
    it('rejects a zero Ajna pool factory', async () => {
      const base = await deployMockTakerBase();
      // Strict reason phrase: deploy-revert errors embed contract source, so a
      // bare substring can false-match identifiers that appear in the code.
      await expectRevertContaining(
        new CurveKeeperTaker__factory(base.owner).deploy(
          constants.AddressZero,
          constants.AddressZero
        ),
        "reverted with reason string 'Zero pool factory'"
      );
    });

    it('still allows standalone (zero authorizedFactory) deployments', async () => {
      const base = await deployMockTakerBase();
      const taker = await new CurveKeeperTaker__factory(base.owner).deploy(
        base.poolDeployer.address,
        constants.AddressZero
      );
      await taker.deployed();
      expect(await taker.authorizedFactory()).to.equal(constants.AddressZero);
    });
  });
});
