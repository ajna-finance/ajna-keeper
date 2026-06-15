import { expect } from 'chai';
import {
  DIRECT_DEX_DYNAMIC_SOURCES,
  LiquiditySource,
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

  it('rejects the retired top-level lifi config input', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: undefined,
        takePolicy: { allowedExternalTakePaths: ['lifi' as any] },
      })
    ).to.throw(
      'allowedExternalTakePaths currently supports only direct_dex or calldata_aggregator'
    );
  });

  it('does not treat LIFI as a direct DEX dynamic source', () => {
    expect(DIRECT_DEX_DYNAMIC_SOURCES).to.not.include(LiquiditySource.LIFI);
  });

  it('describes aggregator paths without assigning path-level default sources', () => {
    expect(getExternalTakePathDescriptor('calldata_aggregator')).to.not.have.property(
      'defaultSource'
    );
    expect(getExternalTakePathDescriptor('direct_dex')).to.not.have.property(
      'defaultSource'
    );
    expect(isAggregatorExternalTakePath('calldata_aggregator')).to.equal(true);
    expect(isAggregatorExternalTakePath('direct_dex')).to.equal(false);
  });

  it('resolves liquidity sources to external take paths through the registry', () => {
    expect(resolveExternalTakePathFromSource(LiquiditySource.ONEINCH)).to.equal(
      'calldata_aggregator'
    );
    expect(resolveExternalTakePathFromSource(LiquiditySource.LIFI)).to.equal(
      'calldata_aggregator'
    );
    expect(
      resolveExternalTakePathFromSource(LiquiditySource.UNISWAPV3)
    ).to.equal('direct_dex');
  });

  it('marks LI.FI as requiring fail-closed deployment validation and gas overrides', () => {
    const lifiDescriptor = getExternalTakePathDescriptor('calldata_aggregator');

    expect(lifiDescriptor.requiresRouteDeploymentValidation).to.equal(true);
    expect(lifiDescriptor.requiresDexGasOverride).to.equal(true);
  });

  it('uses aggregator path classification for hybrid gas fallback eligibility', () => {
    expect(
      resolveHybridGasQuoteFallbackPolicy({
        fallbackMode: 'direct_dex_first',
        routeSelectionMode: 'maximize_profit',
        externalTakePaths: ['direct_dex', 'calldata_aggregator'],
        maxGasCostNative: 1,
      })
    ).to.deep.equal({ eligible: true });
  });
});
