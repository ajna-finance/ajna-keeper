import { expect } from 'chai';
import { isArbProfitable } from '../../src/take/arb';

// P2 self-penalty fix: the pure arb-take core shared by the take path and the
// kick liveness gate. A bucketTake's bond reward keys off the BUCKET price, so
// for self-kicked auctions (npCeiling = NP) the arb is refused when the HMB
// bucket price exceeds NP — regardless of the auction price. With no ceiling it
// preserves the original price < hmbPrice*factor threshold exactly.
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

  it('refuses a self-kicked arb when the HMB bucket price exceeds NP (any auction price)', () => {
    // hmbPrice 10 > NP 5: a bucketTake into HMB would clear above NP and penalize
    // the bond, so refuse even at a deeply-decayed auction price.
    expect(
      isArbProfitable({ price: 1, hmbPrice: 10, hpbPriceFactor: 0.9, npCeiling: 5 })
    ).to.deep.equal({
      takeable: false,
      maxArbTakePrice: 9,
      reason: 'hmb bucket price above neutralPrice',
    });
  });

  it('allows a self-kicked arb when the HMB bucket price is at/below NP', () => {
    // hmbPrice 10 <= NP 12: bucket clears below NP (rewarded), so normal arb applies.
    expect(
      isArbProfitable({ price: 8, hmbPrice: 10, hpbPriceFactor: 0.9, npCeiling: 12 })
    ).to.deep.include({ takeable: true, maxArbTakePrice: 9 });
    // boundary: hmbPrice == NP is safe (bond neither rewarded nor penalized).
    expect(
      isArbProfitable({ price: 8, hmbPrice: 10, hpbPriceFactor: 0.9, npCeiling: 10 })
    ).to.deep.include({ takeable: true });
  });
});
