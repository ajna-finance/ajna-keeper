import { expect } from 'chai';
import {
  FACTORY_DYNAMIC_SOURCES,
  LiquiditySource,
  getExternalTakePathDefaultSource,
  getExternalTakePathDescriptor,
  isAggregatorExternalTakePath,
  resolveExternalTakePaths,
  resolveExternalTakePathFromSource,
  resolveHybridGasQuoteFallbackPolicy,
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

  it('describes aggregator paths and their default sources centrally', () => {
    expect(getExternalTakePathDefaultSource('oneinch')).to.equal(
      LiquiditySource.ONEINCH
    );
    expect(getExternalTakePathDefaultSource('lifi')).to.equal(
      LiquiditySource.LIFI
    );
    expect(getExternalTakePathDefaultSource('factory')).to.equal(undefined);
    expect(isAggregatorExternalTakePath('oneinch')).to.equal(true);
    expect(isAggregatorExternalTakePath('lifi')).to.equal(true);
    expect(isAggregatorExternalTakePath('factory')).to.equal(false);
  });

  it('resolves liquidity sources to external take paths through the registry', () => {
    expect(resolveExternalTakePathFromSource(LiquiditySource.ONEINCH)).to.equal(
      'oneinch'
    );
    expect(resolveExternalTakePathFromSource(LiquiditySource.LIFI)).to.equal(
      'lifi'
    );
    expect(resolveExternalTakePathFromSource(LiquiditySource.UNISWAPV3)).to.equal(
      'factory'
    );
  });

  it('marks LI.FI as requiring fail-closed deployment validation and gas overrides', () => {
    const lifiDescriptor = getExternalTakePathDescriptor('lifi');

    expect(lifiDescriptor.requiresRouteDeploymentValidation).to.equal(true);
    expect(lifiDescriptor.requiresDexGasOverride).to.equal(true);
  });

  it('uses aggregator path classification for hybrid gas fallback eligibility', () => {
    expect(
      resolveHybridGasQuoteFallbackPolicy({
        fallbackMode: 'factory_first',
        routeSelectionMode: 'maximize_profit',
        externalTakePaths: ['factory', 'lifi'],
        maxGasCostNative: 1,
      })
    ).to.deep.equal({ eligible: true });
  });
});
