import { expect } from 'chai';
import { utils } from 'ethers';
import { getRevalidatedQuoteContextIssue } from '../../src/take/take-decision-revalidation';
import { getDebtConstrainedTakeCollateralWad } from '../../src/take/take-sizing';

// Live-incident shape: aggregator quotes are denominated in the debt-clamped
// size, direct DEX quotes in the full collateral.
const COLLATERAL = utils.parseEther('67.350885853762942258');
const DEBT = utils.parseEther('7.181028045088476234');
const PRICE = utils.parseEther('0.4646');
const CLAMPED = getDebtConstrainedTakeCollateralWad({
  collateral: COLLATERAL,
  auctionPrice: PRICE,
  debtToCover: DEBT,
});
const FACTS = {
  collateral: COLLATERAL,
  auctionPrice: PRICE,
  debtToCover: DEBT,
};

describe('getRevalidatedQuoteContextIssue', () => {
  it('accepts aggregator quotes denominated in the debt-clamped size', () => {
    expect(
      getRevalidatedQuoteContextIssue({
        quoteEvaluation: {
          externalTakePath: 'calldata_aggregator',
          quotedCollateralWad: CLAMPED,
          quotedAuctionPriceWad: PRICE,
        },
        ...FACTS,
      })
    ).to.equal(undefined);
  });

  it('rejects aggregator quotes denominated in the full collateral', () => {
    expect(
      getRevalidatedQuoteContextIssue({
        quoteEvaluation: {
          externalTakePath: 'calldata_aggregator',
          quotedCollateralWad: COLLATERAL,
        },
        ...FACTS,
      })
    ).to.equal('collateral_mismatch');
  });

  it('accepts direct DEX quotes denominated in the full collateral', () => {
    expect(
      getRevalidatedQuoteContextIssue({
        quoteEvaluation: {
          externalTakePath: 'direct_dex',
          quotedCollateralWad: COLLATERAL,
        },
        ...FACTS,
      })
    ).to.equal(undefined);
  });

  it('flags quotes whose auction price increased since quoting', () => {
    expect(
      getRevalidatedQuoteContextIssue({
        quoteEvaluation: {
          externalTakePath: 'direct_dex',
          quotedCollateralWad: COLLATERAL,
          quotedAuctionPriceWad: PRICE.sub(1),
        },
        ...FACTS,
      })
    ).to.equal('auction_price_stale');
  });

  it('accepts quotes whose auction price decayed since quoting', () => {
    expect(
      getRevalidatedQuoteContextIssue({
        quoteEvaluation: {
          externalTakePath: 'direct_dex',
          quotedCollateralWad: COLLATERAL,
          quotedAuctionPriceWad: PRICE.add(1),
        },
        ...FACTS,
      })
    ).to.equal(undefined);
  });

  it('accepts evaluations without quote-context fields', () => {
    expect(
      getRevalidatedQuoteContextIssue({
        quoteEvaluation: { externalTakePath: 'calldata_aggregator' },
        ...FACTS,
      })
    ).to.equal(undefined);
  });
});
