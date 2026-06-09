import { expect } from 'chai';
import { isBenignNoLiquidationError } from '../../scripts/no-spend-harness-helpers';

describe('no-spend harness helpers', () => {
  it('fails closed for ambiguous liquidation read errors', () => {
    expect(isBenignNoLiquidationError(new Error('post-take read failed'))).to.equal(
      false
    );
    expect(isBenignNoLiquidationError({ code: 'NETWORK_ERROR' })).to.equal(false);
    expect(isBenignNoLiquidationError(undefined)).to.equal(false);
  });

  it('allows only explicit no-auction liquidation read errors', () => {
    expect(
      isBenignNoLiquidationError(new Error('No active auction (kickTime = 0)'))
    ).to.equal(true);
    expect(
      isBenignNoLiquidationError({
        reason: 'liquidation auction not found for borrower',
      })
    ).to.equal(true);
  });
});
