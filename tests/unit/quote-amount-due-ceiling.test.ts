import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { WAD } from '../../src/constants';
import {
  ceilWmul,
  getQuoteAmountDueRawForScale,
} from '../../src/take/external-take/quote-economics';

// P2-1 non-18-decimal token realism: the exact-fill take sizing converts the
// WAD repayment obligation into raw quote-token units by dividing by the quote
// token scale (10^(18 - decimals)). For a non-18-decimal quote token that
// division has a remainder, so it must round UP (+1 wei at token-scale
// granularity) — a floor-only payout would under-pay the Ajna obligation and
// the exact-fill backstop would reject it. This pins that +1-wei ceiling
// (the PR #17 non-18-decimal class) at the pure-math level.
describe('getQuoteAmountDueRawForScale — non-18-decimal quote-token ceiling', () => {
  // 6-decimal quote token (e.g. USDC): scale = 10^(18-6) = 10^12.
  const scale6 = BigNumber.from(10).pow(12);
  const collateralWad = WAD; // exactly 1.0 collateral

  it('rounds the obligation UP by one token-wei when it does not divide evenly', () => {
    // 2.5...001 — the WAD repayment has a remainder mod the 6-decimal scale.
    const auctionPriceWad = BigNumber.from('2500000000000000001');
    const repaymentWad = ceilWmul(collateralWad, auctionPriceWad);
    expect(repaymentWad.mod(scale6).gt(0)).to.equal(true); // precondition: remainder

    const floor = repaymentWad.div(scale6);
    const due = getQuoteAmountDueRawForScale({
      quoteTokenScale: scale6,
      auctionPriceWad,
      collateralWad,
    });
    expect(
      due.eq(floor.add(1)),
      `due ${due.toString()} should be floor ${floor.toString()} + 1 (ceiling)`
    ).to.equal(true);
  });

  it('does not add a wei when the obligation divides exactly', () => {
    const auctionPriceWad = BigNumber.from('2500000000000000000'); // 2.5 exactly
    const repaymentWad = ceilWmul(collateralWad, auctionPriceWad);
    expect(repaymentWad.mod(scale6).eq(0)).to.equal(true); // exact

    const due = getQuoteAmountDueRawForScale({
      quoteTokenScale: scale6,
      auctionPriceWad,
      collateralWad,
    });
    expect(due.eq(repaymentWad.div(scale6))).to.equal(true);
  });

  it('the floor-only payout would under-pay the obligation by exactly one token-wei', () => {
    const auctionPriceWad = BigNumber.from('2500000000000000001');
    const due = getQuoteAmountDueRawForScale({
      quoteTokenScale: scale6,
      auctionPriceWad,
      collateralWad,
    });
    const floor = ceilWmul(collateralWad, auctionPriceWad).div(scale6);
    // A take sized to `floor` (one wei less) leaves the Ajna obligation short,
    // which is exactly what the +1 ceiling backstops.
    expect(due.sub(floor).eq(1)).to.equal(true);
  });

  it('an 18-decimal quote token (scale 1) never needs the ceiling', () => {
    const auctionPriceWad = BigNumber.from('2500000000000000001');
    const due = getQuoteAmountDueRawForScale({
      quoteTokenScale: BigNumber.from(1),
      auctionPriceWad,
      collateralWad,
    });
    // scale 1 -> the WAD obligation is already the raw amount, no rounding.
    expect(due.eq(ceilWmul(collateralWad, auctionPriceWad))).to.equal(true);
  });
});
