import { expect } from 'chai';
import { LiquiditySource } from '../../src/config';
import { resolveExternalTakePolicy } from '../../src/config/route-policy';

describe('route policy helpers', () => {
  it('fails closed on explicit empty external take paths instead of falling back', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: LiquiditySource.ONEINCH,
        takePolicy: { allowedExternalTakePaths: [] },
      })
    ).to.throw('allowedExternalTakePaths must be non-empty');
  });

  it('preserves explicit empty direct DEX liquidity sources instead of falling back', () => {
    expect(
      resolveExternalTakePolicy({
        defaultLiquiditySource: LiquiditySource.UNISWAPV3,
        takePolicy: { allowedLiquiditySources: [] },
      }).directDexRouteSources
    ).to.deep.equal([]);
  });
});

describe('allowedCalldataAggregatorProviders enablement (Packet 2B)', () => {
  const {
    resolveExternalTakePolicy,
  } = require('../../src/config/route-policy');
  const { LiquiditySource } = require('../../src/config/schema');

  it('resolves an omitted provider list to lifi only when the family is enabled', () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: LiquiditySource.LIFI,
      takePolicy: {},
    });
    expect(resolved.externalTakePaths).to.deep.equal(['calldata_aggregator']);
    expect(resolved.calldataAggregatorProviders).to.deep.equal(['lifi']);
  });

  it('resolves an empty provider set when the family is not enabled', () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {},
    });
    expect(resolved.calldataAggregatorProviders).to.deep.equal([]);
  });

  it('resolves ONEINCH to the calldata aggregator family after Packet 5 migration', () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: LiquiditySource.ONEINCH,
      takePolicy: {},
    });
    expect(resolved.externalTakePaths).to.deep.equal(['calldata_aggregator']);
    expect(resolved.calldataAggregatorProviders).to.deep.equal(['oneinch']);
  });

  it("accepts an explicit ['lifi'] provider list with the family enabled", () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator'],
        allowedCalldataAggregatorProviders: ['lifi'],
      },
    });
    expect(resolved.calldataAggregatorProviders).to.deep.equal(['lifi']);
  });

  it('rejects the retired legacy lifi path alias', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: undefined,
        takePolicy: { allowedExternalTakePaths: ['lifi' as any] },
      })
    ).to.throw(
      'allowedExternalTakePaths currently supports only direct_dex or calldata_aggregator'
    );
  });

  it('rejects an explicit empty provider list', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: LiquiditySource.LIFI,
        takePolicy: { allowedCalldataAggregatorProviders: [] },
      })
    ).to.throw('allowedCalldataAggregatorProviders must be non-empty');
  });

  it('rejects duplicate provider ids', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: LiquiditySource.LIFI,
        takePolicy: { allowedCalldataAggregatorProviders: ['lifi', 'lifi'] },
      })
    ).to.throw('cannot contain duplicates');
  });

  it('rejects unknown provider ids', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: LiquiditySource.LIFI,
        takePolicy: {
          allowedCalldataAggregatorProviders: ['mystery_aggregator'],
        },
      })
    ).to.throw('currently supports only lifi, sushi_aggregator, oneinch');
  });

  it('rejects a provider list when the calldata_aggregator family is disabled', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: undefined,
        takePolicy: {
          allowedExternalTakePaths: ['direct_dex'],
          allowedCalldataAggregatorProviders: ['lifi'],
        },
      })
    ).to.throw('requires the calldata_aggregator family');
  });

  it('rejects duplicate configured path families', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: undefined,
        takePolicy: {
          allowedExternalTakePaths: [
            'calldata_aggregator',
            'calldata_aggregator',
          ],
        },
      })
    ).to.throw('cannot contain duplicates');
  });

  it('reports explicit path configuration for hybrid engagement', () => {
    const explicit = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
        allowedCalldataAggregatorProviders: ['oneinch'],
      },
    });
    expect(explicit.externalTakePathsExplicitlyConfigured).to.equal(true);
    expect(explicit.externalTakeSelectorEnabled).to.equal(true);
    const derived = resolveExternalTakePolicy({
      defaultLiquiditySource: LiquiditySource.ONEINCH,
      takePolicy: {},
    });
    expect(derived.externalTakePathsExplicitlyConfigured).to.equal(false);
    expect(derived.externalTakeSelectorEnabled).to.equal(false);
  });

  it('counts concrete calldata providers for net-profit route ranking', () => {
    const singleProvider = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator'],
        allowedCalldataAggregatorProviders: ['lifi'],
      },
    });
    expect(singleProvider.externalTakeRouteCount).to.equal(1);
    expect(singleProvider.requiresExternalTakeNetProfitRanking).to.equal(
      false
    );

    const multipleProviders = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator'],
        allowedCalldataAggregatorProviders: ['lifi', 'sushi_aggregator'],
      },
    });
    expect(multipleProviders.externalTakeRouteCount).to.equal(2);
    expect(multipleProviders.requiresExternalTakeNetProfitRanking).to.equal(
      true
    );

    const implicitMultipleProviders = resolveExternalTakePolicy({
      defaultLiquiditySource: LiquiditySource.ONEINCH,
      takePolicy: {
        allowedCalldataAggregatorProviders: ['oneinch', 'sushi_aggregator'],
      },
    });
    expect(implicitMultipleProviders.externalTakePaths).to.deep.equal([
      'calldata_aggregator',
    ]);
    expect(
      implicitMultipleProviders.externalTakePathsExplicitlyConfigured
    ).to.equal(false);
    expect(implicitMultipleProviders.externalTakeSelectorEnabled).to.equal(
      true
    );
    expect(implicitMultipleProviders.externalTakeRouteCount).to.equal(2);
    expect(
      implicitMultipleProviders.requiresExternalTakeNetProfitRanking
    ).to.equal(true);

    const directDexFirst = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator'],
        allowedCalldataAggregatorProviders: ['lifi', 'sushi_aggregator'],
        externalTakeRouteSelectionMode: 'direct_dex_first',
      },
    });
    expect(directDexFirst.externalTakeRouteCount).to.equal(2);
    expect(directDexFirst.requiresExternalTakeNetProfitRanking).to.equal(
      false
    );
  });

  it('resolves hybrid gas quote fallback eligibility onto the policy', () => {
    const eligible = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
        allowedCalldataAggregatorProviders: ['lifi'],
        hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
        maxGasCostNative: 0.01,
      },
    });
    expect(eligible.hybridGasQuoteFallbackPolicy).to.deep.equal({
      eligible: true,
    });

    const ineligible = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
        allowedCalldataAggregatorProviders: ['lifi'],
        hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
        maxGasCostNative: 0.01,
        minExpectedProfitQuote: 1,
      },
    });
    expect(ineligible.hybridGasQuoteFallbackPolicy).to.deep.equal({
      eligible: false,
      reason: 'minExpectedProfitQuote is configured',
    });
  });
});

describe('provider enablement matrix with Sushi active (Packet 3B)', () => {
  const {
    resolveExternalTakePolicy,
  } = require('../../src/config/route-policy');
  const { LiquiditySource } = require('../../src/config/schema');

  it('keeps an omitted provider list LI.FI-only after Sushi is added', () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: LiquiditySource.LIFI,
      takePolicy: { allowedExternalTakePaths: ['calldata_aggregator'] },
    });
    expect(resolved.calldataAggregatorProviders).to.deep.equal(['lifi']);
  });

  it('enables LI.FI only explicitly', () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator'],
        allowedCalldataAggregatorProviders: ['lifi'],
      },
    });
    expect(resolved.calldataAggregatorProviders).to.deep.equal(['lifi']);
  });

  it('enables Sushi only explicitly', () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator'],
        allowedCalldataAggregatorProviders: ['sushi_aggregator'],
      },
    });
    expect(resolved.calldataAggregatorProviders).to.deep.equal([
      'sushi_aggregator',
    ]);
  });

  it('enables LI.FI plus Sushi under the same family', () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['calldata_aggregator'],
        allowedCalldataAggregatorProviders: ['lifi', 'sushi_aggregator'],
      },
    });
    expect(resolved.calldataAggregatorProviders).to.deep.equal([
      'lifi',
      'sushi_aggregator',
    ]);
  });

  it('resolves deployment for the appended Sushi source by provider id', () => {
    const {
      resolveExternalTakeDeployment,
    } = require('../../src/config/external-take-descriptors');
    const resolution = resolveExternalTakeDeployment({
      liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
      config: {
        keeperTakerRouter: '0x' + '11'.repeat(20),
        takerContracts: { SushiAggregator: '0x' + '22'.repeat(20) },
      },
    });
    expect(resolution.deploymentType).to.equal('calldata_aggregator');
    expect(resolution.providerId).to.equal('sushi_aggregator');
    expect(resolution.requestedLiquiditySource).to.equal(
      LiquiditySource.SUSHI_AGGREGATOR
    );
  });
});
