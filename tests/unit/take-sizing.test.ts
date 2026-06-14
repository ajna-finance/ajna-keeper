import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { isAggregatorExternalTakePath } from '../../src/config/external-take-registry';
import {
  getDebtConstrainedTakeCollateralWad,
  getExpectedQuotedCollateralWad,
} from '../../src/take/take-sizing';

// Live-incident shape: 67.35 collateral, debt ~7.18, price ~0.4646 — Ajna
// fills only ~15.45 collateral, not the full auction collateral.
const COLLATERAL = utils.parseEther('67.350885853762942258');
const DEBT = utils.parseEther('7.181028045088476234');
const PRICE = utils.parseEther('0.4646');

describe('take sizing', () => {
  describe('getDebtConstrainedTakeCollateralWad', () => {
    it('clamps to debt/price when debt binds', () => {
      const clamped = getDebtConstrainedTakeCollateralWad({
        collateral: COLLATERAL,
        auctionPrice: PRICE,
        debtToCover: DEBT,
      });
      const exact = DEBT.mul(utils.parseEther('1')).div(PRICE);
      expect(clamped.eq(exact)).to.equal(true);
      expect(clamped.lt(COLLATERAL)).to.equal(true);
      // Conservative: the clamp never exceeds what the debt can absorb at the
      // undiscounted auction price (floor division).
      expect(clamped.mul(PRICE).div(utils.parseEther('1')).lte(DEBT)).to.equal(
        true
      );
    });

    it('returns full collateral when the auction is underwater', () => {
      const deepPrice = utils.parseEther('0.05'); // debt/price > collateral
      const clamped = getDebtConstrainedTakeCollateralWad({
        collateral: COLLATERAL,
        auctionPrice: deepPrice,
        debtToCover: DEBT,
      });
      expect(clamped.eq(COLLATERAL)).to.equal(true);
    });

    it('degrades to full collateral when debt is unknown or inputs are unusable', () => {
      expect(
        getDebtConstrainedTakeCollateralWad({
          collateral: COLLATERAL,
          auctionPrice: PRICE,
        }).eq(COLLATERAL)
      ).to.equal(true);
      expect(
        getDebtConstrainedTakeCollateralWad({
          collateral: COLLATERAL,
          auctionPrice: PRICE,
          debtToCover: BigNumber.from(0),
        }).eq(COLLATERAL)
      ).to.equal(true);
      expect(
        getDebtConstrainedTakeCollateralWad({
          collateral: COLLATERAL,
          auctionPrice: BigNumber.from(0),
          debtToCover: DEBT,
        }).eq(COLLATERAL)
      ).to.equal(true);
    });

    it('floors dust clamps to zero rather than rounding up', () => {
      const clamped = getDebtConstrainedTakeCollateralWad({
        collateral: COLLATERAL,
        auctionPrice: utils.parseEther('2'),
        debtToCover: BigNumber.from(1), // 1 wei of debt
      });
      expect(clamped.isZero()).to.equal(true);
    });
  });

  describe('getExpectedQuotedCollateralWad', () => {
    const params = {
      collateral: COLLATERAL,
      auctionPrice: PRICE,
      debtToCover: DEBT,
    };
    const clamped = getDebtConstrainedTakeCollateralWad(params);

    it('clamps for aggregator paths and not for factory', () => {
      expect(
        getExpectedQuotedCollateralWad({
          externalTakePath: 'oneinch',
          ...params,
        }).eq(clamped)
      ).to.equal(true);
      expect(
        getExpectedQuotedCollateralWad({
          externalTakePath: 'calldata_aggregator',
          ...params,
        }).eq(clamped)
      ).to.equal(true);
      expect(
        getExpectedQuotedCollateralWad({
          externalTakePath: 'factory',
          ...params,
        }).eq(COLLATERAL)
      ).to.equal(true);
      expect(
        getExpectedQuotedCollateralWad({
          externalTakePath: undefined,
          ...params,
        }).eq(COLLATERAL)
      ).to.equal(true);
    });
  });

  describe('isAggregatorExternalTakePath', () => {
    it('classifies paths', () => {
      expect(isAggregatorExternalTakePath('oneinch')).to.equal(true);
      expect(isAggregatorExternalTakePath('calldata_aggregator')).to.equal(
        true
      );
      expect(isAggregatorExternalTakePath('factory')).to.equal(false);
    });
  });
});
