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

  it('preserves explicit empty factory liquidity sources instead of falling back', () => {
    expect(
      resolveExternalTakePolicy({
        defaultLiquiditySource: LiquiditySource.UNISWAPV3,
        takePolicy: { allowedLiquiditySources: [] },
      }).factoryRouteSources
    ).to.deep.equal([]);
  });
});

describe('allowedCalldataAggregatorProviders enablement (Packet 2B)', () => {
  const { resolveExternalTakePolicy } = require('../../src/config/route-policy');
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
      defaultLiquiditySource: LiquiditySource.ONEINCH,
      takePolicy: {},
    });
    expect(resolved.calldataAggregatorProviders).to.deep.equal([]);
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

  it('accepts the legacy lifi path alias as the enabling family input', () => {
    const resolved = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: {
        allowedExternalTakePaths: ['lifi'],
        allowedCalldataAggregatorProviders: ['lifi'],
      },
    });
    expect(resolved.externalTakePaths).to.deep.equal(['calldata_aggregator']);
    expect(resolved.calldataAggregatorProviders).to.deep.equal(['lifi']);
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
    ).to.throw('currently supports only lifi, sushi_aggregator');
  });

  it('rejects a provider list when the calldata_aggregator family is disabled', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: undefined,
        takePolicy: {
          allowedExternalTakePaths: ['oneinch', 'factory'],
          allowedCalldataAggregatorProviders: ['lifi'],
        },
      })
    ).to.throw('requires the calldata_aggregator family');
  });

  it('rejects duplicates created by mixing the legacy alias with the canonical family', () => {
    expect(() =>
      resolveExternalTakePolicy({
        defaultLiquiditySource: undefined,
        takePolicy: {
          allowedExternalTakePaths: ['lifi', 'calldata_aggregator'],
        },
      })
    ).to.throw('cannot contain duplicates');
  });

  it('reports explicit path configuration for hybrid engagement', () => {
    const explicit = resolveExternalTakePolicy({
      defaultLiquiditySource: undefined,
      takePolicy: { allowedExternalTakePaths: ['oneinch', 'factory'] },
    });
    expect(explicit.externalTakePathsExplicitlyConfigured).to.equal(true);
    const derived = resolveExternalTakePolicy({
      defaultLiquiditySource: LiquiditySource.ONEINCH,
      takePolicy: {},
    });
    expect(derived.externalTakePathsExplicitlyConfigured).to.equal(false);
  });
});

describe('provider enablement matrix with Sushi active (Packet 3B)', () => {
  const { resolveExternalTakePolicy } = require('../../src/config/route-policy');
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
    } = require('../../src/config/external-take-registry');
    const resolution = resolveExternalTakeDeployment({
      liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
      config: {
        keeperTakerFactory: '0x' + '11'.repeat(20),
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
