import { expect } from 'chai';
import { BondBudget } from '../../src/kick/bond-budget';

const POOL_A = '0xAAAa000000000000000000000000000000000001';
const POOL_B = '0xBBBb000000000000000000000000000000000002';

// P5 bond budget: tracks bond-at-risk against a per-pool native cap and an
// optional global cap, so the kick cycle never posts more bond than configured.
describe('BondBudget', () => {
  it('enforces the per-pool cap, accumulating reservations', () => {
    const budget = new BondBudget({
      limits: { maxBondExposurePerPool: 10 },
    });
    expect(budget.tryReserve({ poolAddress: POOL_A, bondQuote: 6 })).to.equal(true);
    // 6 + 5 = 11 > 10 -> rejected, no reservation recorded
    expect(budget.tryReserve({ poolAddress: POOL_A, bondQuote: 5 })).to.equal(false);
    // 6 + 4 = 10 <= 10 -> accepted
    expect(budget.tryReserve({ poolAddress: POOL_A, bondQuote: 4 })).to.equal(true);
  });

  it('counts the already-locked baseline against the per-pool cap (case-insensitive)', () => {
    const budget = new BondBudget({
      limits: { maxBondExposurePerPool: 10 },
      lockedByPool: new Map([[POOL_A.toLowerCase(), 8]]),
    });
    // 8 locked + 3 = 11 > 10 -> rejected
    expect(budget.tryReserve({ poolAddress: POOL_A, bondQuote: 3 })).to.equal(false);
    // 8 locked + 2 = 10 -> accepted
    expect(budget.tryReserve({ poolAddress: POOL_A, bondQuote: 2 })).to.equal(true);
  });

  it('tracks pools independently for the per-pool cap', () => {
    const budget = new BondBudget({
      limits: { maxBondExposurePerPool: 10 },
    });
    expect(budget.tryReserve({ poolAddress: POOL_A, bondQuote: 10 })).to.equal(true);
    // POOL_A exhausted, POOL_B untouched
    expect(budget.tryReserve({ poolAddress: POOL_A, bondQuote: 1 })).to.equal(false);
    expect(budget.tryReserve({ poolAddress: POOL_B, bondQuote: 10 })).to.equal(true);
  });

  it('enforces the global cap across pools using normalized amounts', () => {
    const budget = new BondBudget({
      limits: { maxBondExposurePerPool: 100, maxTotalBondExposure: 20 },
    });
    expect(
      budget.tryReserve({ poolAddress: POOL_A, bondQuote: 5, bondNormalized: 15 })
    ).to.equal(true);
    // global 15 + 10 = 25 > 20 -> rejected (per-pool cap of 100 is not the limit)
    expect(
      budget.tryReserve({ poolAddress: POOL_B, bondQuote: 5, bondNormalized: 10 })
    ).to.equal(false);
    // global 15 + 5 = 20 -> accepted
    expect(
      budget.tryReserve({ poolAddress: POOL_B, bondQuote: 5, bondNormalized: 5 })
    ).to.equal(true);
  });

  it('counts the locked normalized baseline against the global cap', () => {
    const budget = new BondBudget({
      limits: { maxBondExposurePerPool: 100, maxTotalBondExposure: 20 },
      lockedNormalized: 18,
    });
    // 18 locked + 3 = 21 > 20 -> rejected
    expect(
      budget.tryReserve({ poolAddress: POOL_A, bondQuote: 1, bondNormalized: 3 })
    ).to.equal(false);
    // 18 locked + 2 = 20 -> accepted
    expect(
      budget.tryReserve({ poolAddress: POOL_A, bondQuote: 1, bondNormalized: 2 })
    ).to.equal(true);
  });

  it('ignores the global dimension when no global cap is configured', () => {
    const budget = new BondBudget({
      limits: { maxBondExposurePerPool: 10 },
    });
    // huge normalized amount is irrelevant without a global cap
    expect(
      budget.tryReserve({ poolAddress: POOL_A, bondQuote: 5, bondNormalized: 1e9 })
    ).to.equal(true);
  });
});
