import { expect } from 'chai';
import {
  FACTORY_DYNAMIC_SOURCES,
  LiquiditySource,
  getExternalTakePathDefaultSource,
  getExternalTakePathDescriptor,
  isAggregatorExternalTakePath,
  resolveExternalTakePolicy,
  resolveExternalTakePathFromSource,
  resolveHybridGasQuoteFallbackPolicy,
} from '../../src/config';

describe('LI.FI route policy', () => {
  it('resolves LIFI defaults to the calldata_aggregator external take path', () => {
    expect(
      resolveExternalTakePolicy({
        defaultLiquiditySource: LiquiditySource.LIFI,
      }).externalTakePaths
    ).to.deep.equal(['calldata_aggregator']);
  });

  it('resolves the legacy lifi config input to the calldata_aggregator family', () => {
    expect(
      resolveExternalTakePolicy({
        defaultLiquiditySource: undefined,
        takePolicy: { allowedExternalTakePaths: ['lifi'] },
      }).externalTakePaths
    ).to.deep.equal(['calldata_aggregator']);
  });

  it('does not treat LIFI as a factory dynamic source', () => {
    expect(FACTORY_DYNAMIC_SOURCES).to.not.include(LiquiditySource.LIFI);
  });

  it('describes aggregator paths and their default sources centrally', () => {
    expect(getExternalTakePathDefaultSource('oneinch')).to.equal(
      LiquiditySource.ONEINCH
    );
    expect(getExternalTakePathDefaultSource('calldata_aggregator')).to.equal(
      LiquiditySource.LIFI
    );
    expect(getExternalTakePathDefaultSource('factory')).to.equal(undefined);
    expect(isAggregatorExternalTakePath('oneinch')).to.equal(true);
    expect(isAggregatorExternalTakePath('calldata_aggregator')).to.equal(true);
    expect(isAggregatorExternalTakePath('factory')).to.equal(false);
  });

  it('resolves liquidity sources to external take paths through the registry', () => {
    expect(resolveExternalTakePathFromSource(LiquiditySource.ONEINCH)).to.equal(
      'oneinch'
    );
    expect(resolveExternalTakePathFromSource(LiquiditySource.LIFI)).to.equal(
      'calldata_aggregator'
    );
    expect(resolveExternalTakePathFromSource(LiquiditySource.UNISWAPV3)).to.equal(
      'factory'
    );
  });

  it('marks LI.FI as requiring fail-closed deployment validation and gas overrides', () => {
    const lifiDescriptor = getExternalTakePathDescriptor('calldata_aggregator');

    expect(lifiDescriptor.requiresRouteDeploymentValidation).to.equal(true);
    expect(lifiDescriptor.requiresDexGasOverride).to.equal(true);
  });

  it('uses aggregator path classification for hybrid gas fallback eligibility', () => {
    expect(
      resolveHybridGasQuoteFallbackPolicy({
        fallbackMode: 'factory_first',
        routeSelectionMode: 'maximize_profit',
        externalTakePaths: ['factory', 'calldata_aggregator'],
        maxGasCostNative: 1,
      })
    ).to.deep.equal({ eligible: true });
  });
});
