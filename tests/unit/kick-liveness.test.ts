import { expect } from 'chai';
import { evaluateKickLiveness } from '../../src/kick-liveness';

// P3 kick liveness gate (arb-only): under Option 1 the keeper only kicks where
// it can profitably take the auction it creates. Live iff a meaningful bucket
// exists, the keeper's arbTake into it clears below NP (rewarded), and the
// market is below the arb threshold (hmbPrice * factor). Reuses isArbProfitable.
describe('evaluateKickLiveness', () => {
  const base = {
    marketPrice: 8,
    hmbPrice: 10,
    hpbPriceFactor: 0.9, // arb threshold = 9
    neutralPrice: 12, // hmbPrice 10 <= NP 12 -> bucket clears below NP
  };

  it('is live when a meaningful bucket exists with arb room below NP', () => {
    expect(evaluateKickLiveness(base)).to.deep.equal({ live: true });
  });

  it('is not live when there is no meaningful bucket', () => {
    expect(
      evaluateKickLiveness({ ...base, hmbPrice: undefined })
    ).to.deep.equal({ live: false, reason: 'no-meaningful-bucket' });
    expect(evaluateKickLiveness({ ...base, hmbPrice: 0 })).to.deep.equal({
      live: false,
      reason: 'no-meaningful-bucket',
    });
  });

  it('is not live when the market is not below the arb threshold (no arb room)', () => {
    // market 9.5 >= hmb*factor 9
    expect(
      evaluateKickLiveness({ ...base, marketPrice: 9.5 })
    ).to.deep.equal({ live: false, reason: 'liveness-no-arb-room' });
  });

  it('is not live when the HMB bucket price exceeds NP (self-take would penalize)', () => {
    // hmbPrice 10 > NP 7: even at a low market, the keeper's bucketTake into HMB
    // would clear above NP and penalize its bond.
    expect(
      evaluateKickLiveness({ ...base, neutralPrice: 7, marketPrice: 1 })
    ).to.deep.equal({ live: false, reason: 'liveness-hmb-above-np' });
  });
});
