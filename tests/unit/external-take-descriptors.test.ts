import { expect } from 'chai';
import {
  CALLDATA_AGGREGATOR_PROVIDER_IDS,
  LiquiditySource,
  getAggregatorProviderIdentity,
  getExternalTakeLiquiditySourceDescriptor,
  resolveCalldataAggregatorProviderForSource,
  resolveExternalTakeDeployment,
} from '../../src/config';
import type { ExternalTakeTakerContractKey } from '../../src/config';

const router = '0x' + '11'.repeat(20);
const oneInchTaker = '0x' + '22'.repeat(20);
const lifiTaker = '0x' + '33'.repeat(20);
const sushiTaker = '0x' + '44'.repeat(20);
const uniswapTaker = '0x' + '55'.repeat(20);

describe('external take descriptors', () => {
  it('owns calldata aggregator provider identity in the descriptor model', () => {
    expect(CALLDATA_AGGREGATOR_PROVIDER_IDS).to.deep.equal([
      'lifi',
      'sushi_aggregator',
      'oneinch',
    ]);

    const lifi = getAggregatorProviderIdentity('lifi');
    const lifiSource = getExternalTakeLiquiditySourceDescriptor(
      LiquiditySource.LIFI
    );
    expect(lifi).to.include({
      providerId: 'lifi',
      path: 'calldata_aggregator',
      source: LiquiditySource.LIFI,
      takerContractKey: 'Lifi',
      configKey: 'lifi',
    });
    expect(lifi.takerContractKey).to.equal(lifiSource.takerContractKey);

    const sushi = getAggregatorProviderIdentity('sushi_aggregator');
    const sushiSource = getExternalTakeLiquiditySourceDescriptor(
      LiquiditySource.SUSHI_AGGREGATOR
    );
    expect(sushi).to.include({
      providerId: 'sushi_aggregator',
      path: 'calldata_aggregator',
      source: LiquiditySource.SUSHI_AGGREGATOR,
      takerContractKey: 'SushiAggregator',
      configKey: 'sushiAggregator',
    });
    expect(sushi.takerContractKey).to.equal(sushiSource.takerContractKey);

    const oneinch = getAggregatorProviderIdentity('oneinch');
    const oneinchSource = getExternalTakeLiquiditySourceDescriptor(
      LiquiditySource.ONEINCH
    );
    expect(oneinch).to.include({
      providerId: 'oneinch',
      path: 'calldata_aggregator',
      source: LiquiditySource.ONEINCH,
      takerContractKey: 'OneInchAggregator',
      configKey: 'oneInch',
    });
    expect(oneinch.takerContractKey).to.equal(oneinchSource.takerContractKey);
  });

  it('resolves calldata aggregator providers from source descriptors', () => {
    expect(resolveCalldataAggregatorProviderForSource(LiquiditySource.LIFI)).to.equal(
      'lifi'
    );
    expect(
      resolveCalldataAggregatorProviderForSource(
        LiquiditySource.SUSHI_AGGREGATOR
      )
    ).to.equal('sushi_aggregator');
    expect(
      resolveCalldataAggregatorProviderForSource(LiquiditySource.ONEINCH)
    ).to.equal('oneinch');
  });

  it('makes the migrated 1inch aggregator taker key representable before runtime cutover', () => {
    // Packet 5 preserves LiquiditySource.ONEINCH as the stable source id. The
    // new contract key is intentionally representable now so deployments can
    // target takers.contracts.OneInchAggregator during the later runtime
    // migration without reusing takers.oneInch.
    const configured: Partial<Record<ExternalTakeTakerContractKey, string>> = {
      OneInchAggregator: '0x' + '66'.repeat(20),
    };

    expect(configured.OneInchAggregator).to.equal('0x' + '66'.repeat(20));
  });

  it('preserves the deployment compatibility facade labels', () => {
    expect(
      resolveExternalTakeDeployment({
        liquiditySource: LiquiditySource.ONEINCH,
        config: {
          keeperTakerRouter: router,
          takerContracts: { OneInchAggregator: oneInchTaker },
        },
      })
    ).to.deep.equal({
      deploymentType: 'calldata_aggregator',
      providerId: 'oneinch',
      requestedLiquiditySource: LiquiditySource.ONEINCH,
      resolvedTakerAddress: oneInchTaker,
    });

    expect(
      resolveExternalTakeDeployment({
        liquiditySource: LiquiditySource.UNISWAPV3,
        config: {
          keeperTakerRouter: router,
          takerContracts: { UniswapV3: uniswapTaker },
        },
      })
    ).to.deep.equal({
      deploymentType: 'direct_dex',
      requestedLiquiditySource: LiquiditySource.UNISWAPV3,
      resolvedTakerAddress: uniswapTaker,
    });

    expect(
      resolveExternalTakeDeployment({
        liquiditySource: LiquiditySource.LIFI,
        config: {
          keeperTakerRouter: router,
          takerContracts: { Lifi: lifiTaker },
        },
      })
    ).to.deep.equal({
      deploymentType: 'calldata_aggregator',
      providerId: 'lifi',
      requestedLiquiditySource: LiquiditySource.LIFI,
      resolvedTakerAddress: lifiTaker,
    });

    expect(
      resolveExternalTakeDeployment({
        liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
        config: {
          keeperTakerRouter: router,
          takerContracts: { SushiAggregator: sushiTaker },
        },
      })
    ).to.deep.equal({
      deploymentType: 'calldata_aggregator',
      providerId: 'sushi_aggregator',
      requestedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
      resolvedTakerAddress: sushiTaker,
    });
  });

  it('preserves deployment unavailable reasons during the descriptor extraction', () => {
    expect(
      resolveExternalTakeDeployment({
        liquiditySource: LiquiditySource.ONEINCH,
        config: {},
      })
    ).to.deep.equal({
      deploymentType: 'none',
      requestedLiquiditySource: LiquiditySource.ONEINCH,
      unavailableReason: 'keeperTakerRouter is not configured',
    });

    expect(
      resolveExternalTakeDeployment({
        liquiditySource: LiquiditySource.ONEINCH,
        config: { keeperTakerRouter: router },
      })
    ).to.deep.equal({
      deploymentType: 'none',
      requestedLiquiditySource: LiquiditySource.ONEINCH,
      unavailableReason:
        'takerContracts.OneInchAggregator is not configured',
    });

    expect(
      resolveExternalTakeDeployment({
        liquiditySource: LiquiditySource.LIFI,
        config: { takerContracts: { Lifi: lifiTaker } },
      })
    ).to.deep.equal({
      deploymentType: 'none',
      requestedLiquiditySource: LiquiditySource.LIFI,
      unavailableReason: 'keeperTakerRouter is not configured',
    });

    expect(
      resolveExternalTakeDeployment({
        liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
        config: { keeperTakerRouter: router },
      })
    ).to.deep.equal({
      deploymentType: 'none',
      requestedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
      unavailableReason: 'takerContracts.SushiAggregator is not configured',
    });
  });
});
