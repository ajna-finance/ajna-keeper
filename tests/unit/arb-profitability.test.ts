import { expect } from 'chai';
import { isArbProfitable } from '../../src/take/arb';

// P2 self-penalty fix: the pure arb-take core shared by the take path and the
// kick liveness gate. The npCeiling caps the eligible bucket at the auction
// neutralPrice so the keeper's own bucketTake can never clear above NP (which
// would penalize its bond). With no ceiling it preserves the original
// price < hmbPrice*factor threshold exactly.
describe('isArbProfitable', () => {
  it('is takeable below the hmb threshold and reports maxArbTakePrice (no ceiling)', () => {
    const result = isArbProfitable({ price: 8, hmbPrice: 10, hpbPriceFactor: 0.9 });
    expect(result).to.deep.equal({
      takeable: true,
      maxArbTakePrice: 9, // 10 * 0.9
      reason: undefined,
    });
  });

  it('is not takeable at or above the threshold (no ceiling)', () => {
    const result = isArbProfitable({ price: 9, hmbPrice: 10, hpbPriceFactor: 0.9 });
    expect(result.takeable).to.equal(false);
    expect(result.maxArbTakePrice).to.equal(9);
    expect(result.reason).to.equal('auction price above arbTake threshold');
  });

  it('caps the ceiling at npCeiling when it is below hmb*factor', () => {
    // hmb*factor = 9, but NP ceiling = 5: only prices below 5 are takeable.
    expect(
      isArbProfitable({ price: 6, hmbPrice: 10, hpbPriceFactor: 0.9, npCeiling: 5 })
    ).to.deep.include({ takeable: false, maxArbTakePrice: 5 });
    expect(
      isArbProfitable({ price: 4, hmbPrice: 10, hpbPriceFactor: 0.9, npCeiling: 5 })
    ).to.deep.include({ takeable: true, maxArbTakePrice: 5 });
  });

  it('leaves the threshold unchanged when npCeiling is above hmb*factor', () => {
    // NP ceiling (20) does not bind; ceiling stays at hmb*factor = 9.
    expect(
      isArbProfitable({ price: 8, hmbPrice: 10, hpbPriceFactor: 0.9, npCeiling: 20 })
    ).to.deep.include({ takeable: true, maxArbTakePrice: 9 });
  });
});
