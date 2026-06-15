import { expect } from 'chai';
import { BigNumber, Wallet, constants, utils } from 'ethers';
import {
  CurveKeeperTaker__factory,
} from '../../typechain-types/factories/contracts/takers';
import {
  MockAtomicSwapPool__factory,
  MockCurveTricryptoPool__factory,
  MockERC20__factory,
  MockPoolDeployer__factory,
  MockStrictApprovalToken__factory,
  MockSwapRouter02__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { UniswapV3KeeperTaker__factory } from '../../typechain-types/factories/contracts/takers/UniswapV3KeeperTaker__factory';
import {
  CURVE_DETAILS_TYPE,
  DEADLINE,
  ERC20_NON_SUBSET_HASH,
  MockTakerBase,
  ZERO_FACTORY,
  deployCurveTaker,
  deployFundedCurvePool,
  deployFundedSwapRouter02,
  deployMinOutBypassSwap,
  deployMockTakerBase,
  deployUniswapTaker,
  encodeCurveKeeperDetails,
  encodeTakerCallbackData,
  encodeUniswapDetails,
  expectRevertContaining,
  fundSigner,
  getProvider,
} from './helpers/mock-taker-base';

const MAX_AMOUNT = utils.parseEther('10');
const TAKEN_PARTIAL = utils.parseEther('4');
const FULL_MIN_OUT = utils.parseEther('6');
const DUE_PARTIAL = utils.parseEther('1.8');
const DUE_FULL = utils.parseEther('5');
const AUCTION_PRICE = utils.parseEther('1');
const SOURCE_UNISWAP_V3 = 2;
const SOURCE_CURVE = 4;

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
    // The direct-Sushi crafted-callback case was removed with the direct Sushi
    // path; the curve tokenOut/tokenIn binding cases below cover the same
    // re-binding invariant (both takers share the RouterAuthorizedTakerBase
    // callback shape).

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

      const receipt = await (
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
        )
      ).wait();

      expect((await base.pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await base.quoteToken.balanceOf(base.pool.address)).eq(
          DUE_RAW.add(1)
        )
      ).to.equal(true);

      // AUDIT FIX regression (ported from the removed direct-Sushi case): the
      // direct DEX takers' SwapExecuted was declared but never emitted, leaving
      // successful takes invisible to per-swap monitoring. UniswapV3 is the
      // surviving direct-DEX taker carrying this emission assertion.
      const swapEvent = receipt.events?.find((e) => e.event === 'SwapExecuted');
      expect(swapEvent, 'expected a SwapExecuted event').to.not.equal(
        undefined
      );
      expect(swapEvent!.args!.tokenIn).to.equal(base.collateralToken.address);
      expect(swapEvent!.args!.tokenOut).to.equal(base.quoteToken.address);
      expect(swapEvent!.args!.amountIn.eq(MAX_AMOUNT)).to.equal(true);
      expect(swapEvent!.args!.amountOut.eq(DUE_RAW.add(1))).to.equal(true);
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

    // Direct-Sushi quote-ceiling cases removed with the direct Sushi path; the
    // uniswap (above, with the ported SwapExecuted assertion) and curve cases
    // cover the identical ceil-rounded-pull reject/accept invariants.

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

    it('still allows standalone (zero authorizedRouter) deployments', async () => {
      const base = await deployMockTakerBase();
      const taker = await new CurveKeeperTaker__factory(base.owner).deploy(
        base.poolDeployer.address,
        constants.AddressZero
      );
      await taker.deployed();
      expect(await taker.authorizedRouter()).to.equal(constants.AddressZero);
    });
  });

  describe('partial fill combined with non-18-decimal quote tokens', () => {
    // The hardest rounding combination: a debt-constrained partial fill AND a
    // 6-decimal quote whose pool pull is ceil-rounded (+1 over the callback's
    // floored due). Previously each dimension was tested only in isolation.
    const QUOTE_SCALE = BigNumber.from(10).pow(12);
    const DUE_PARTIAL_RAW = BigNumber.from(1_800_000); // floored due, 6 decimals
    const FULL_MIN_OUT_RAW = BigNumber.from(6_000_000); // quoted for MAX_AMOUNT
    const SCALED_MIN_OUT_RAW = BigNumber.from(2_400_000); // pro-rated to 4/10 fill

    async function setupScaledPartialFill() {
      const base = await deployMockTakerBase({
        quoteDecimals: 6,
        quoteTokenScale: QUOTE_SCALE,
      });
      await base.pool.setCollateralTakenOverride(TAKEN_PARTIAL);
      await base.pool.setQuoteAmountDue(DUE_PARTIAL_RAW);
      await base.pool.setQuotePullOverride(DUE_PARTIAL_RAW.add(1));
      await base.collateralToken.mint(base.pool.address, TAKEN_PARTIAL);
      return base;
    }

    it('settles a scaled-quote partial fill and repays the ceil-rounded pull', async () => {
      const base = await setupScaledPartialFill();
      const taker = await deployUniswapTaker(base);
      const router = await deployFundedSwapRouter02(base, SCALED_MIN_OUT_RAW);
      const ownerQuoteBefore = await base.quoteToken.balanceOf(
        base.owner.address
      );

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
          amountOutMinimum: FULL_MIN_OUT_RAW,
        })
      );

      expect((await base.pool.takeCount()).eq(1)).to.equal(true);
      expect(
        (await base.quoteToken.balanceOf(base.pool.address)).eq(
          DUE_PARTIAL_RAW.add(1)
        )
      ).to.equal(true);
      expect(
        (await base.quoteToken.balanceOf(base.owner.address)).eq(
          ownerQuoteBefore.add(SCALED_MIN_OUT_RAW.sub(DUE_PARTIAL_RAW.add(1)))
        )
      ).to.equal(true);
    });

    it('rejects a scaled-quote partial fill below the pro-rated floor', async () => {
      const base = await setupScaledPartialFill();
      const taker = await deployUniswapTaker(base);
      // MockMinOutBypassSwap ignores min_dy entirely; only the taker guard protects.
      const router = await deployMinOutBypassSwap(
        base,
        SCALED_MIN_OUT_RAW.sub(1),
        SCALED_MIN_OUT_RAW
      );

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
            amountOutMinimum: FULL_MIN_OUT_RAW,
          })
        ),
        'InsufficientQuoteReceived'
      );
    });
  });

  describe('USDT-style strict approval tokens', () => {
    it('completes consecutive takes when both pool tokens revert on non-zero-to-non-zero approvals', async () => {
      // The worst-case quote approval exceeds the actual pull, leaving residual
      // allowance mid-take. A taker that skipped the zero-first reset in
      // _safeApproveWithReset would brick on its SECOND take with a strict
      // token; two consecutive takes pin the reset pattern end to end.
      const owner = Wallet.createRandom().connect(getProvider());
      await fundSigner(owner.address);

      const collateralToken = await new MockStrictApprovalToken__factory(
        owner
      ).deploy('Strict Collateral', 'SCOLL', 18);
      await collateralToken.deployed();
      const quoteToken = await new MockStrictApprovalToken__factory(
        owner
      ).deploy('Strict Quote', 'SQTE', 18);
      await quoteToken.deployed();

      const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
      await poolDeployer.deployed();
      const pool = await new MockAtomicSwapPool__factory(owner).deploy(
        collateralToken.address,
        quoteToken.address,
        BigNumber.from(1)
      );
      await pool.deployed();
      await poolDeployer.setDeployedPool(
        ERC20_NON_SUBSET_HASH,
        collateralToken.address,
        quoteToken.address,
        pool.address
      );

      const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
        poolDeployer.address,
        ZERO_FACTORY
      );
      await taker.deployed();

      const due = utils.parseEther('5');
      const routerOutput = utils.parseEther('7');
      await pool.setQuoteAmountDue(due);
      await collateralToken.mint(pool.address, MAX_AMOUNT.mul(2));

      const router = await new MockSwapRouter02__factory(owner).deploy(
        routerOutput
      );
      await router.deployed();
      await quoteToken.mint(router.address, routerOutput.mul(2));

      const details = encodeUniswapDetails({
        routerAddress: router.address,
        targetToken: quoteToken.address,
        amountOutMinimum: utils.parseEther('6'),
      });

      for (let i = 0; i < 2; i++) {
        await taker.takeWithAtomicSwap(
          pool.address,
          owner.address,
          AUCTION_PRICE,
          MAX_AMOUNT,
          SOURCE_UNISWAP_V3,
          router.address,
          details
        );
      }

      expect((await pool.takeCount()).eq(2)).to.equal(true);
      // Residual allowances must be fully reset after each take.
      expect(
        (await quoteToken.allowance(taker.address, pool.address)).eq(0)
      ).to.equal(true);
      expect(
        (await collateralToken.allowance(taker.address, router.address)).eq(0)
      ).to.equal(true);
      // Owner collected the profit from both takes.
      expect(
        (await quoteToken.balanceOf(owner.address)).eq(
          routerOutput.sub(due).mul(2)
        )
      ).to.equal(true);
    });
  });
});
