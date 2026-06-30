import { expect } from 'chai';
import { ethers } from 'ethers';
import {
  evaluateKickEligibility,
  KickEligibilityInput,
} from '../../src/kick/eligibility';

const wad = (v: string) => ethers.utils.parseEther(v);

// A loan that clears every gate: TP(5) > LUP(1); debt(10) >= minDebt(1);
// NP(2) >= market(1)/priceFactor(0.9) = 1.11; NP(2) >= HPB(1).
const base: KickEligibilityInput = {
  thresholdPrice: wad('5'),
  lup: wad('1'),
  hpb: wad('1'),
  debt: wad('10'),
  neutralPrice: wad('2'),
  marketPrice: 1,
  minDebt: 1,
  priceFactor: 0.9,
};

describe('evaluateKickEligibility', () => {
  it('returns eligible with the margin-adjusted price when all gates pass', () => {
    const result = evaluateKickEligibility(base);
    expect(result.eligible).to.equal(true);
    if (result.eligible) {
      // marginPrice = market / priceFactor = 1 / 0.9
      expect(result.marginPrice).to.be.closeTo(1 / 0.9, 1e-9);
    }
  });

  it('skips a collateralized loan (TP <= LUP, equality included)', () => {
    expect(
      evaluateKickEligibility({ ...base, thresholdPrice: wad('0.5') })
    ).to.deep.equal({ eligible: false, reason: 'collateralized' });
    // strict gate: TP == LUP is also collateralized (was previously allowed)
    expect(
      evaluateKickEligibility({ ...base, thresholdPrice: wad('1') })
    ).to.deep.equal({ eligible: false, reason: 'collateralized' });
  });

  it('skips a loan whose debt is below minDebt', () => {
    expect(
      evaluateKickEligibility({ ...base, debt: wad('0.5') })
    ).to.deep.equal({ eligible: false, reason: 'debt-below-min' });
  });

  it('skips when NP is below the market reward margin (market/priceFactor)', () => {
    // market 3 / 0.9 = 3.33 > NP 2
    expect(
      evaluateKickEligibility({ ...base, marketPrice: 3 })
    ).to.deep.equal({ eligible: false, reason: 'neutral-below-market' });
  });

  it('skips when NP is below HPB (bucket-take penalty floor), re-enabled for all pools', () => {
    // NP(2) >= market margin (1.11) but NP(2) < HPB(5)
    expect(
      evaluateKickEligibility({ ...base, hpb: wad('5') })
    ).to.deep.equal({ eligible: false, reason: 'neutral-below-hpb' });
  });

  it('reports the most fundamental reason first (collateralized before debt)', () => {
    expect(
      evaluateKickEligibility({
        ...base,
        thresholdPrice: wad('0.5'),
        debt: wad('0.5'),
      })
    ).to.deep.equal({ eligible: false, reason: 'collateralized' });
  });
});
