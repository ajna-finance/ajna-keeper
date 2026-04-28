import { expect } from 'chai';
import { LiquiditySource } from '../../src/config';
import {
  resolveExternalTakePaths,
  resolveFactoryRouteSelectionSources,
} from '../../src/config/route-policy';

describe('route policy helpers', () => {
  it('preserves explicit empty external take paths instead of falling back', () => {
    expect(
      resolveExternalTakePaths({
        defaultLiquiditySource: LiquiditySource.ONEINCH,
        allowedExternalTakePaths: [],
      })
    ).to.deep.equal([]);
  });

  it('preserves explicit empty factory liquidity sources instead of falling back', () => {
    expect(
      resolveFactoryRouteSelectionSources({
        defaultLiquiditySource: LiquiditySource.UNISWAPV3,
        allowedLiquiditySources: [],
      })
    ).to.deep.equal([]);
  });
});
