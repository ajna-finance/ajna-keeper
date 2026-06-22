import { expect } from 'chai';
import { BigNumber, Wallet, utils } from 'ethers';
import {
  MockAtomicSwapPool__factory,
  TakerTakeScalingHarness__factory,
} from '../../typechain-types/factories/contracts/mocks';
import {
  expectRevertContaining,
  fundSigner,
  getProvider,
} from './helpers/mock-taker-base';

// Direct unit coverage for the TakerTakeScaling library, previously exercised
// only transitively through full takes. Pins the partial-fill floor pro-rating
// (ceil rounding), the planned-amount basis + its zero-truncation guard, and the
// ceil-rounded quote-due backstop for non-18-decimal quote tokens.
describe('TakerTakeScaling library', () => {
  async function deployHarness() {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);
    const harness = await new TakerTakeScalingHarness__factory(owner).deploy();
    await harness.deployed();
    return { owner, harness };
  }

  // plannedTakeAmount / quoteAmountDueCeiling only read the pool's scales, so the
  // token addresses are irrelevant here.
  async function deployPool(owner: Wallet, quoteTokenScale: BigNumber) {
    const pool = await new MockAtomicSwapPool__factory(owner).deploy(
      Wallet.createRandom().address,
      Wallet.createRandom().address,
      quoteTokenScale
    );
    await pool.deployed();
    return pool;
  }

  describe('scaleAmountOutMinimum', () => {
    it('returns the full floor unchanged on an exact (non-partial) fill', async () => {
      const { harness } = await deployHarness();
      expect((await harness.scaleAmountOutMinimum(1000, 7, 7)).eq(1000)).to.equal(
        true
      );
    });

    it('pro-rates and rounds the floor UP on a debt-constrained partial fill', async () => {
      const { harness } = await deployHarness();
      // planned 3, taken 1, full floor 10 => ceil(10 * 1 / 3) = 4 (not floor 3).
      expect((await harness.scaleAmountOutMinimum(10, 1, 3)).eq(4)).to.equal(true);
      // ceil(10 * 2 / 3) = ceil(20/3) = 7.
      expect((await harness.scaleAmountOutMinimum(10, 2, 3)).eq(7)).to.equal(true);
    });

    it('pro-rates exactly when the division is exact', async () => {
      const { harness } = await deployHarness();
      // 6 * 2 / 3 = 4 exactly.
      expect((await harness.scaleAmountOutMinimum(6, 2, 3)).eq(4)).to.equal(true);
    });
  });

  describe('plannedTakeAmount', () => {
    it('divides maxAmount by the collateral scale', async () => {
      const { owner, harness } = await deployHarness();
      const pool = await deployPool(owner, BigNumber.from(1));
      await pool.setCollateralScale(BigNumber.from(10).pow(12)); // 6-decimal collateral
      // maxAmount 10 WAD => 10e6 raw collateral units.
      expect(
        (
          await harness.plannedTakeAmount(pool.address, utils.parseEther('10'))
        ).eq(BigNumber.from(10).pow(7))
      ).to.equal(true);
    });

    it('reverts when the planned amount truncates to zero', async () => {
      const { owner, harness } = await deployHarness();
      const pool = await deployPool(owner, BigNumber.from(1));
      await pool.setCollateralScale(BigNumber.from(10).pow(12));
      await expectRevertContaining(
        harness.plannedTakeAmount(pool.address, BigNumber.from(10).pow(11)),
        'Zero planned amount'
      );
    });
  });

  describe('quoteAmountDueCeiling', () => {
    it('leaves the due unchanged for an 18-decimal (scale 1) quote token', async () => {
      const { owner, harness } = await deployHarness();
      const pool = await deployPool(owner, BigNumber.from(1));
      expect(
        (
          await harness.quoteAmountDueCeiling(
            pool.address,
            utils.parseEther('5')
          )
        ).eq(utils.parseEther('5'))
      ).to.equal(true);
    });

    it('adds one token-wei for a non-18-decimal (scale > 1) quote token', async () => {
      const { owner, harness } = await deployHarness();
      const pool = await deployPool(owner, BigNumber.from(10).pow(12)); // 6-decimal quote
      const due = BigNumber.from('1000000');
      expect(
        (await harness.quoteAmountDueCeiling(pool.address, due)).eq(due.add(1))
      ).to.equal(true);
    });
  });
});
