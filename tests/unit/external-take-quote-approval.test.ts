import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { bindExternalTakeRouteForDiscovery } from '../../src/take/external-take/quote-approval';

describe('external take quote approval', () => {
  it('rejects LI.FI discovery routes without a validated quote payload', () => {
    const binding = bindExternalTakeRouteForDiscovery({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'lifi',
        quoteAmountRaw: BigNumber.from(125),
        selectedLiquiditySource: LiquiditySource.LIFI,
      },
      selectedLiquiditySource: LiquiditySource.LIFI,
      poolName: 'Missing LI.FI Quote Pool',
      borrower: '0xBorrower',
    });

    expect(binding).to.deep.equal({
      bound: false,
      reason:
        'LI.FI route is missing validated route details for Missing LI.FI Quote Pool/0xBorrower',
    });
  });
});
