import { expect } from 'chai';
import {
  AutoDiscoverTakePolicy,
  LiquiditySource,
  validateAutoDiscoverConfig,
} from '../../src/config';
import {
  baseAutoDiscoverConfig as baseConfig,
  configureOneInchAggregatorTake,
  configureSushiAggregatorTake,
} from './auto-discover-validation-helpers';

describe('auto-discover calldata aggregator validation', () => {
  const expectMissingWrappedNativeForProviderRanking = (
    configureTakePolicy: AutoDiscoverTakePolicy
  ): void => {
    const config = baseConfig();
    config.discovery!.take = configureTakePolicy;
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    configureSushiAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };
    config.dex!.uniswapV3!.router = {
      ...config.dex!.uniswapV3!.router!,
      wethAddress: undefined as unknown as string,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: hybrid external take route ranking requires a configured wrapped native token address'
    );
  };

  it('requires quote-denominated gas conversion config for explicit same-family provider ranking', () => {
    expectMissingWrappedNativeForProviderRanking({
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator'],
      allowedCalldataAggregatorProviders: ['oneinch', 'sushi_aggregator'],
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
        [LiquiditySource.SUSHI_AGGREGATOR]: '900000',
      },
    });
  });

  it('requires quote-denominated gas conversion config for implicit same-family provider ranking', () => {
    expectMissingWrappedNativeForProviderRanking({
      enabled: true,
      allowedCalldataAggregatorProviders: ['oneinch', 'sushi_aggregator'],
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
        [LiquiditySource.SUSHI_AGGREGATOR]: '900000',
      },
    });
  });
});
