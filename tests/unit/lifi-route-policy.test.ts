import { expect } from 'chai';
import {
  FACTORY_DYNAMIC_SOURCES,
  LiquiditySource,
  resolveExternalTakePaths,
} from '../../src/config';

describe('LI.FI route policy', () => {
  it('resolves LIFI defaults to the lifi external take path', () => {
    expect(
      resolveExternalTakePaths({
        defaultLiquiditySource: LiquiditySource.LIFI,
      })
    ).to.deep.equal(['lifi']);
  });

  it('does not treat LIFI as a factory dynamic source', () => {
    expect(FACTORY_DYNAMIC_SOURCES).to.not.include(LiquiditySource.LIFI);
  });
});
