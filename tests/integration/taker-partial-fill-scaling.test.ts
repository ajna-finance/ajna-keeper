import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import {
  MockTakerBase,
  deployCurveTaker,
  deployFundedCurvePool,
  deployFundedSushiRouter,
  deployFundedSwapRouter02,
  deployMinOutBypassSwap,
  deployMockTakerBase,
  deploySushiTaker,
  deployUniswapTaker,
  encodeCurveKeeperDetails,
  encodeSushiKeeperDetails,
  encodeUniswapCallbackData,
  encodeUniswapDetails,
  expectRevertContaining,
} from './helpers/mock-taker-base';

// Auction plan: keeper asks for 10 collateral and encodes the floor quoted for that
// full size. Ajna's debt clamp only delivers 4 to the callback, so the enforceable
// floor is the pro-rated 2.4 — the full-size 6 would reject this valid fill.
const MAX_AMOUNT = utils.parseEther('10');
const TAKEN_PARTIAL = utils.parseEther('4');
const FULL_MIN_OUT = utils.parseEther('6');
const SCALED_MIN_OUT = utils.parseEther('2.4');
const DUE_PARTIAL = utils.parseEther('1.8');
const AUCTION_PRICE = utils.parseEther('1');
const SOURCE_UNISWAP_V3 = 2;
const SOURCE_SUSHISWAP = 3;
const SOURCE_CURVE = 4;

describe('Taker partial-fill min-out scaling', () => {
  async function setupPartialFill(
    base: MockTakerBase,
    takenRaw: BigNumber = TAKEN_PARTIAL,
    due: BigNumber = DUE_PARTIAL
  ) {
    await base.pool.setCollateralTakenOverride(takenRaw);
    await base.pool.setQuoteAmountDue(due);
    await base.collateralToken.mint(base.pool.address, takenRaw);
  }

  describe('UniswapV3KeeperTaker', () => {
    it('executes a debt-constrained partial fill that the full-size floor would reject', async () => {
      const base = await deployMockTakerBase();
      const { owner, collateralToken, quoteToken, pool } = base;
      const taker = await deployUniswapTaker(base);
      await setupPartialFill(base);

      // Above the pro-rated floor, below the full-size floor: exactly the live
      // incident shape that used to revert with "Too little received".
      const routerOutput = utils.parseEther('2.5');
      expect(routerOutput.lt(FULL_MIN_OUT)).to.equal(true);
      expect(routerOutput.gte(SCALED_MIN_OUT)).to.equal(true);
      const router = await deployFundedSwapRouter02(base, routerOutput);

      const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);

      await taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_UNISWAP_V3,
        router.address,
        encodeUniswapDetails({
          routerAddress: router.address,
          targetToken: quoteToken.address,
          amountOutMinimum: FULL_MIN_OUT,
        })
      );

      expect((await pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await collateralToken.balanceOf(router.address)).eq(TAKEN_PARTIAL)
      ).to.equal(true);
      expect(
        (await quoteToken.balanceOf(pool.address)).eq(DUE_PARTIAL)
      ).to.equal(true);
      expect(
        (await quoteToken.balanceOf(owner.address)).eq(
          ownerQuoteBefore.add(routerOutput.sub(DUE_PARTIAL))
        )
      ).to.equal(true);
      expect(
        (await collateralToken.allowance(taker.address, router.address)).eq(0)
      ).to.equal(true);
      expect(
        (await quoteToken.allowance(taker.address, pool.address)).eq(0)
      ).to.equal(true);
    });

    it('forwards the pro-rated floor to the router on partial fills', async () => {
      const base = await deployMockTakerBase();
      const { owner, quoteToken, pool } = base;
      const taker = await deployUniswapTaker(base);
      await setupPartialFill(base);

      const router = await deployFundedSwapRouter02(
        base,
        SCALED_MIN_OUT.sub(1)
      );

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_UNISWAP_V3,
          router.address,
          encodeUniswapDetails({
            routerAddress: router.address,
            targetToken: quoteToken.address,
            amountOutMinimum: FULL_MIN_OUT,
          })
        ),
        'insufficient output amount'
      );

      expect((await pool.takeCount()).eq(0)).to.equal(true);
    });

    it('enforces the pro-rated floor on balance deltas when a router bypasses min-out', async () => {
      const base = await deployMockTakerBase();
      const { owner, quoteToken, pool } = base;
      const taker = await deployUniswapTaker(base);
      await setupPartialFill(base);

      const router = await deployMinOutBypassSwap(
        base,
        SCALED_MIN_OUT.sub(1),
        FULL_MIN_OUT
      );

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_UNISWAP_V3,
          router.address,
          encodeUniswapDetails({
            routerAddress: router.address,
            targetToken: quoteToken.address,
            amountOutMinimum: FULL_MIN_OUT,
          })
        ),
        'InsufficientQuoteReceived'
      );
    });

    it('keeps the Ajna repayment backstop when the due exceeds the pro-rated floor', async () => {
      const base = await deployMockTakerBase();
      const { owner, quoteToken, pool } = base;
      const taker = await deployUniswapTaker(base);
      const dueAboveFloor = utils.parseEther('2.6');
      await setupPartialFill(base, TAKEN_PARTIAL, dueAboveFloor);

      const routerOutput = utils.parseEther('2.5');
      expect(routerOutput.gte(SCALED_MIN_OUT)).to.equal(true);
      expect(routerOutput.lt(dueAboveFloor)).to.equal(true);
      const router = await deployFundedSwapRouter02(base, routerOutput);

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_UNISWAP_V3,
          router.address,
          encodeUniswapDetails({
            routerAddress: router.address,
            targetToken: quoteToken.address,
            amountOutMinimum: FULL_MIN_OUT,
          })
        ),
        'InsufficientQuoteReceived'
      );
    });

    it('keeps full fills bound to the exact encoded floor', async () => {
      const base = await deployMockTakerBase();
      const { owner, collateralToken, quoteToken, pool } = base;
      const taker = await deployUniswapTaker(base);
      await pool.setQuoteAmountDue(DUE_PARTIAL);
      await collateralToken.mint(pool.address, MAX_AMOUNT.mul(2));

      const weakRouter = await deployFundedSwapRouter02(
        base,
        FULL_MIN_OUT.sub(1)
      );
      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_UNISWAP_V3,
          weakRouter.address,
          encodeUniswapDetails({
            routerAddress: weakRouter.address,
            targetToken: quoteToken.address,
            amountOutMinimum: FULL_MIN_OUT,
          })
        ),
        'insufficient output amount'
      );

      const exactRouter = await deployFundedSwapRouter02(base, FULL_MIN_OUT);
      await taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_UNISWAP_V3,
        exactRouter.address,
        encodeUniswapDetails({
          routerAddress: exactRouter.address,
          targetToken: quoteToken.address,
          amountOutMinimum: FULL_MIN_OUT,
        })
      );

      expect((await pool.takeCount()).eq(1)).to.equal(true);
    });

    it('rounds the pro-rated floor up', async () => {
      const base = await deployMockTakerBase();
      const { collateralToken, quoteToken, pool } = base;

      // planned 3, taken 1, full floor 10 => scaled floor ceil(10/3) = 4.
      const plannedAmountIn = BigNumber.from(3);
      const takenAmountIn = BigNumber.from(1);
      const fullMinOut = BigNumber.from(10);
      const due = BigNumber.from(1);

      const underRouter = await deployMinOutBypassSwap(
        base,
        BigNumber.from(3),
        fullMinOut
      );
      const underTaker = await deployUniswapTaker(base);
      await collateralToken.mint(underTaker.address, takenAmountIn);
      await expectRevertContaining(
        pool.callAtomicSwapCallback(
          underTaker.address,
          takenAmountIn,
          due,
          encodeUniswapCallbackData({
            routerAddress: underRouter.address,
            targetToken: quoteToken.address,
            amountOutMinimum: fullMinOut,
            plannedAmountIn,
          })
        ),
        'InsufficientQuoteReceived'
      );

      const exactRouter = await deployMinOutBypassSwap(
        base,
        BigNumber.from(4),
        fullMinOut
      );
      const exactTaker = await deployUniswapTaker(base);
      await collateralToken.mint(exactTaker.address, takenAmountIn);
      await pool.callAtomicSwapCallback(
        exactTaker.address,
        takenAmountIn,
        due,
        encodeUniswapCallbackData({
          routerAddress: exactRouter.address,
          targetToken: quoteToken.address,
          amountOutMinimum: fullMinOut,
          plannedAmountIn,
        })
      );

      expect((await quoteToken.balanceOf(exactTaker.address)).eq(4)).to.equal(
        true
      );
    });

    it('scales across mixed token decimals', async () => {
      const base = await deployMockTakerBase({ collateralDecimals: 6 });
      const { owner, collateralToken, quoteToken, pool } = base;
      const taker = await deployUniswapTaker(base);

      const collateralScale = BigNumber.from(10).pow(12);
      await pool.setCollateralScale(collateralScale);

      // maxAmount 10 WAD => planned 10e6 raw; Ajna delivers 4e6 raw (40%).
      const takenRaw = BigNumber.from(4_000_000);
      await setupPartialFill(base, takenRaw);

      const router = await deployFundedSwapRouter02(base, SCALED_MIN_OUT);
      const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);

      await taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_UNISWAP_V3,
        router.address,
        encodeUniswapDetails({
          routerAddress: router.address,
          targetToken: quoteToken.address,
          amountOutMinimum: FULL_MIN_OUT,
        })
      );

      expect((await pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await collateralToken.balanceOf(router.address)).eq(takenRaw)
      ).to.equal(true);
      expect(
        (await quoteToken.balanceOf(owner.address)).eq(
          ownerQuoteBefore.add(SCALED_MIN_OUT.sub(DUE_PARTIAL))
        )
      ).to.equal(true);
    });

    it('rejects takes whose planned amount truncates to zero', async () => {
      const base = await deployMockTakerBase({ collateralDecimals: 6 });
      const { owner, quoteToken, pool } = base;
      const taker = await deployUniswapTaker(base);

      await pool.setCollateralScale(BigNumber.from(10).pow(12));
      const router = await deployFundedSwapRouter02(base, FULL_MIN_OUT);

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          BigNumber.from(10).pow(11), // below collateralScale => 0 raw units
          SOURCE_UNISWAP_V3,
          router.address,
          encodeUniswapDetails({
            routerAddress: router.address,
            targetToken: quoteToken.address,
            amountOutMinimum: FULL_MIN_OUT,
          })
        ),
        'Zero planned amount'
      );

      expect((await pool.takeCount()).eq(0)).to.equal(true);
    });

    it('rejects crafted callbacks with a zero planned amount', async () => {
      const base = await deployMockTakerBase();
      const { collateralToken, quoteToken, pool } = base;
      const taker = await deployUniswapTaker(base);

      await collateralToken.mint(taker.address, TAKEN_PARTIAL);
      const router = await deployFundedSwapRouter02(base, FULL_MIN_OUT);

      await expectRevertContaining(
        pool.callAtomicSwapCallback(
          taker.address,
          TAKEN_PARTIAL,
          DUE_PARTIAL,
          encodeUniswapCallbackData({
            routerAddress: router.address,
            targetToken: quoteToken.address,
            amountOutMinimum: FULL_MIN_OUT,
            plannedAmountIn: BigNumber.from(0),
          })
        ),
        'InvalidSwapDetails'
      );
    });
  });

  describe('SushiSwapKeeperTaker', () => {
    it('executes a debt-constrained partial fill that the full-size floor would reject', async () => {
      const base = await deployMockTakerBase();
      const { owner, collateralToken, quoteToken, pool } = base;
      const taker = await deploySushiTaker(base);
      await setupPartialFill(base);

      const routerOutput = utils.parseEther('2.5');
      const router = await deployFundedSushiRouter(base, routerOutput);

      const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);

      await taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_SUSHISWAP,
        router.address,
        encodeSushiKeeperDetails(FULL_MIN_OUT)
      );

      expect((await pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await collateralToken.balanceOf(router.address)).eq(TAKEN_PARTIAL)
      ).to.equal(true);
      expect(
        (await quoteToken.balanceOf(owner.address)).eq(
          ownerQuoteBefore.add(routerOutput.sub(DUE_PARTIAL))
        )
      ).to.equal(true);
    });

    it('enforces the pro-rated floor on balance deltas when a router bypasses min-out', async () => {
      const base = await deployMockTakerBase();
      const { owner, pool } = base;
      const taker = await deploySushiTaker(base);
      await setupPartialFill(base);

      const router = await deployMinOutBypassSwap(
        base,
        SCALED_MIN_OUT.sub(1),
        FULL_MIN_OUT
      );

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_SUSHISWAP,
          router.address,
          encodeSushiKeeperDetails(FULL_MIN_OUT)
        ),
        'InsufficientQuoteReceived'
      );
    });
  });

  describe('CurveKeeperTaker', () => {
    it('executes a debt-constrained partial fill that the full-size floor would reject', async () => {
      const base = await deployMockTakerBase();
      const { owner, collateralToken, quoteToken, pool } = base;
      const taker = await deployCurveTaker(base);
      await setupPartialFill(base);

      const routerOutput = utils.parseEther('2.5');
      const curvePool = await deployFundedCurvePool(base, routerOutput);

      const ownerQuoteBefore = await quoteToken.balanceOf(owner.address);

      await taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        AUCTION_PRICE,
        MAX_AMOUNT,
        SOURCE_CURVE,
        curvePool.address,
        encodeCurveKeeperDetails(curvePool.address, FULL_MIN_OUT)
      );

      expect((await pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await collateralToken.balanceOf(curvePool.address)).eq(TAKEN_PARTIAL)
      ).to.equal(true);
      expect(
        (await quoteToken.balanceOf(owner.address)).eq(
          ownerQuoteBefore.add(routerOutput.sub(DUE_PARTIAL))
        )
      ).to.equal(true);
    });

    it('enforces the pro-rated floor when the curve pool underdelivers', async () => {
      const base = await deployMockTakerBase();
      const { owner, pool } = base;
      const taker = await deployCurveTaker(base);
      await setupPartialFill(base);

      // MockCurveSwapPool ignores min_dy entirely, so only the taker guard protects here.
      const curvePool = await deployFundedCurvePool(
        base,
        SCALED_MIN_OUT.sub(1)
      );

      await expectRevertContaining(
        taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_CURVE,
          curvePool.address,
          encodeCurveKeeperDetails(curvePool.address, FULL_MIN_OUT)
        ),
        'InsufficientQuoteReceived'
      );
    });
  });
});
