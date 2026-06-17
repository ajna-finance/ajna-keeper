import { expect } from 'chai';
import { LiquiditySource } from '../../src/config';
import { createDiscoveryCalldataAggregatorRouteProviders } from '../../src/discovery/external-take/calldata-aggregator-providers';
import { createDiscoveryExternalTakeProviderRegistry } from '../../src/discovery/external-take/providers';

describe('discovery external take provider registry', () => {
  function createRegistry() {
    const unusedDirectDexQuote = async () => {
      throw new Error('unused quote stub');
    };
    return createDiscoveryExternalTakeProviderRegistry({
      quoteDirectDexPath: unusedDirectDexQuote,
      calldataAggregatorProviders:
        createDiscoveryCalldataAggregatorRouteProviders({
          config: {},
          takePolicy: undefined,
          probeTimeoutMs: 1000,
          getTokenDecimalsCache: () => undefined,
        }),
    });
  }

  it('selects providers by canonical path and calldata provider id', () => {
    const registry = createRegistry();

    expect(
      registry.selectExternalTakeProvider({ selectedPath: 'direct_dex' })
    ).to.include({ path: 'direct_dex' });
    expect(
      registry.selectExternalTakeProvider({
        selectedPath: 'calldata_aggregator',
        providerId: 'lifi',
      })
    ).to.include({ path: 'calldata_aggregator', providerId: 'lifi' });
    expect(
      registry.selectExternalTakeProvider({
        selectedPath: 'calldata_aggregator',
        providerId: 'sushi_aggregator',
      })
    ).to.include({
      path: 'calldata_aggregator',
      providerId: 'sushi_aggregator',
    });
    expect(
      registry.selectExternalTakeProvider({
        selectedPath: 'calldata_aggregator',
        providerId: 'oneinch',
      })
    ).to.include({ path: 'calldata_aggregator', providerId: 'oneinch' });

    expect(
      registry.selectExternalTakeProviderForRoute({
        path: 'calldata_aggregator',
        providerId: 'sushi_aggregator',
        source: LiquiditySource.SUSHI_AGGREGATOR,
      })
    ).to.include({
      path: 'calldata_aggregator',
      providerId: 'sushi_aggregator',
    });
    expect(
      registry.selectExternalTakeProviderForRoute({
        path: 'direct_dex',
        source: LiquiditySource.UNISWAPV3,
      })
    ).to.include({ path: 'direct_dex' });
  });

  it('documents which calldata providers participate in quote circuits', () => {
    const registry = createRegistry();
    const lifiProvider = registry.selectExternalTakeProvider({
      selectedPath: 'calldata_aggregator',
      providerId: 'lifi',
    });
    const oneInchProvider = registry.selectExternalTakeProvider({
      selectedPath: 'calldata_aggregator',
      providerId: 'oneinch',
    });
    const sushiProvider = registry.selectExternalTakeProvider({
      selectedPath: 'calldata_aggregator',
      providerId: 'sushi_aggregator',
    });

    expect(lifiProvider.recordQuoteCircuitOutcome).to.be.a('function');
    expect(oneInchProvider.recordQuoteCircuitOutcome).to.be.a('function');
    expect(sushiProvider.recordQuoteCircuitOutcome).to.equal(undefined);
    expect(sushiProvider.getQuoteCircuitOutcome).to.equal(undefined);
  });

  it('expands hybrid probe providers in registry-owned route order', () => {
    const registry = createRegistry();

    expect(
      registry
        .listExternalTakeProbeProviders({
          externalTakePaths: ['calldata_aggregator', 'direct_dex'],
          calldataAggregatorProviders: ['lifi', 'oneinch', 'sushi_aggregator'],
          routeSelectionMode: 'maximize_profit',
        })
        .map((provider) =>
          provider.providerId
            ? `${provider.path}/${provider.providerId}`
            : provider.path
        )
    ).to.deep.equal([
      'calldata_aggregator/lifi',
      'calldata_aggregator/oneinch',
      'calldata_aggregator/sushi_aggregator',
      'direct_dex',
    ]);

    expect(
      registry
        .listExternalTakeProbeProviders({
          externalTakePaths: ['calldata_aggregator', 'direct_dex'],
          calldataAggregatorProviders: ['lifi'],
          routeSelectionMode: 'direct_dex_first',
        })
        .map((provider) =>
          provider.providerId
            ? `${provider.path}/${provider.providerId}`
            : provider.path
        )
    ).to.deep.equal(['direct_dex', 'calldata_aggregator/lifi']);
  });

  it('fails closed for unsupported path/provider combinations', () => {
    const registry = createRegistry();

    expect(() =>
      registry.selectExternalTakeProvider({
        selectedPath: 'calldata_aggregator',
      })
    ).to.throw('Unsupported external take route: calldata_aggregator');
    expect(() =>
      registry.selectExternalTakeProvider({
        selectedPath: 'direct_dex',
        providerId: 'lifi',
      })
    ).to.throw('Unsupported external take route: direct_dex/lifi');
    expect(() =>
      registry.selectExternalTakeProviderForRoute({
        path: 'calldata_aggregator',
        providerId: 'lifi',
        source: LiquiditySource.ONEINCH,
      })
    ).to.throw(
      'Inconsistent external take route identity: calldata_aggregator/lifi source=ONEINCH'
    );
  });
});
