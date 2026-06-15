import { expect } from 'chai';
import { createDiscoveryExternalTakeProviderRegistry } from '../../src/discovery/external-take/providers';

describe('discovery external take provider registry', () => {
  function createRegistry() {
    const unusedQuote = async () => {
      throw new Error('unused quote stub');
    };
    return createDiscoveryExternalTakeProviderRegistry({
      config: {},
      quoteOneInchAggregatorPath: unusedQuote as never,
      quoteDirectDexPath: unusedQuote as never,
      quoteLifiPath: unusedQuote as never,
      quoteSushiAggregatorPath: unusedQuote as never,
      recordOneInchCircuitOutcome: () => undefined,
      recordLifiCircuitOutcome: () => undefined,
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
  });
});
