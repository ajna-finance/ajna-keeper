import { expect } from 'chai';
import { ethers } from 'ethers';
import {
  evaluateKickCandidate,
  KickCandidateInput,
} from '../../src/kick-candidate';
import { BondBudget } from '../../src/kick-bond-budget';

const wad = (v: string) => ethers.utils.parseEther(v);

// A candidate that clears every gate. Consistency: hpb(1) >= hmbPrice(1) and
// NP(2) >= hpb(1), so the eligibility NP>=HPB floor implies liveness hmb<=NP.
// market 0.5 < hmb*factor 0.9 gives arb room.
const base = (): KickCandidateInput => ({
  poolAddress: '0xpool0000000000000000000000000000000000a',
  thresholdPrice: wad('5'),
  lup: wad('1'),
  hpb: wad('1'),
  debt: wad('10'),
  neutralPrice: wad('2'),
  marketPrice: 0.5,
  minDebt: 1,
  priceFactor: 0.9,
  requireLiveness: true,
  hmbPrice: 1,
  hpbPriceFactor: 0.9,
  bondQuote: 1,
});

const openBudget = () =>
  new BondBudget({ limits: { maxBondExposurePerPool: 100 } });

describe('evaluateKickCandidate', () => {
  it('kicks when every gate passes, returning the margin price', () => {
    const decision = evaluateKickCandidate(base(), openBudget());
    expect(decision.kick).to.equal(true);
    if (decision.kick) {
      expect(decision.marginPrice).to.be.closeTo(0.5 / 0.9, 1e-9);
    }
  });

  it('skips on the eligibility gate (collateralized)', () => {
    const decision = evaluateKickCandidate(
      { ...base(), thresholdPrice: wad('0.5') },
      openBudget()
    );
    expect(decision).to.deep.equal({ kick: false, reason: 'collateralized' });
  });

  it('skips on the liveness gate (no meaningful bucket) when required', () => {
    const decision = evaluateKickCandidate(
      { ...base(), hmbPrice: undefined },
      openBudget()
    );
    expect(decision).to.deep.equal({
      kick: false,
      reason: 'no-meaningful-bucket',
    });
  });

  it('skips the liveness gate when not required (manual targets keep current behavior)', () => {
    // No bucket / no arb config would fail liveness, but requireLiveness=false
    // bypasses it so the manual reward+budget gates alone decide.
    const decision = evaluateKickCandidate(
      {
        ...base(),
        requireLiveness: false,
        hmbPrice: undefined,
        hpbPriceFactor: undefined,
      },
      openBudget()
    );
    expect(decision.kick).to.equal(true);
  });

  it('skips on the bond budget gate', () => {
    const tightBudget = new BondBudget({
      limits: { maxBondExposurePerPool: 0.5 },
    });
    const decision = evaluateKickCandidate(base(), tightBudget);
    expect(decision).to.deep.equal({
      kick: false,
      reason: 'bond-budget-exceeded',
    });
  });

  it('does not consume budget for a loan that fails an earlier gate', () => {
    // Budget has room for exactly one bond of 1.
    const budget = new BondBudget({ limits: { maxBondExposurePerPool: 1 } });
    // A collateralized loan fails eligibility before the budget is charged.
    const skipped = evaluateKickCandidate(
      { ...base(), thresholdPrice: wad('0.5') },
      budget
    );
    expect(skipped.kick).to.equal(false);
    // The valid loan can still reserve the full budget.
    const kicked = evaluateKickCandidate(base(), budget);
    expect(kicked.kick).to.equal(true);
  });
});
