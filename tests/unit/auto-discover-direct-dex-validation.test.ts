import { expect } from 'chai';
import sinon from 'sinon';
import {
  CurvePoolType,
  LiquiditySource,
  TakeWriteTransportMode,
  validateAutoDiscoverConfig,
  validateTakeWriteConfig,
} from '../../src/config';
import { logger } from '../../src/logging';
import {
  baseAutoDiscoverConfig as baseConfig,
  configureOneInchAggregatorTake,
} from './auto-discover-validation-helpers';

describe('auto-discover direct DEX validation', () => {
  it('rejects direct DEX route controls when the direct DEX path is not enabled', () => {
    const config = baseConfig();
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedLiquiditySources requires a direct_dex external take path'
    );

    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      takeRouteQuoteBudgetPerCandidate: 2,
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: takeRouteQuoteBudgetPerCandidate requires an enabled direct_dex external take path'
    );

    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['direct_dex'],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: defaultDirectDexLiquiditySource required when allowedExternalTakePaths includes direct_dex and discovery.defaults.take.liquiditySource is not a direct DEX source'
    );
  });

  it('rejects malformed direct DEX source allowlists', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedLiquiditySources: [],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedLiquiditySources must be non-empty'
    );

    config.discovery!.take = {
      enabled: true,
      allowedLiquiditySources: [
        LiquiditySource.UNISWAPV3,
        LiquiditySource.UNISWAPV3,
      ],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedLiquiditySources cannot contain duplicates'
    );

    config.discovery!.take = {
      enabled: true,
      allowedLiquiditySources: [LiquiditySource.ONEINCH],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedLiquiditySources cannot include ONEINCH for direct_dex external takes'
    );

    config.discovery!.take = {
      enabled: true,
      allowedLiquiditySources: [LiquiditySource.LIFI],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedLiquiditySources currently supports only UNISWAPV3 and CURVE'
    );
  });

  it('rejects invalid direct DEX defaults and fallback-mode ineligibility reasons', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      defaultDirectDexLiquiditySource: LiquiditySource.ONEINCH,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: defaultDirectDexLiquiditySource must be UNISWAPV3 or CURVE'
    );

    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      validateRouteDeployments: true,
      hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
      externalTakeRouteSelectionMode: 'direct_dex_first',
      maxGasCostNative: 0.01,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: hybridGasQuoteFailureFallbackMode=direct_dex_first is ineligible because route selection mode is not maximize_profit'
    );
  });

  it('warns for missing chain-specific 1inch executor allowlist and unused Uniswap route probes', () => {
    const config = baseConfig();
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.discovery!.take = {
      enabled: true,
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };
    config.dex!.oneInch!.aggregationExecutorAllowlist = {
      8453: ['0x2222222222222222222222222222222222222222'],
    };
    config.dex!.uniswapV3!.router = {
      ...config.dex!.uniswapV3!.router!,
      candidateFeeTiers: [500],
    };
    const warnStub = sinon.stub(logger, 'warn');

    try {
      expect(() => validateAutoDiscoverConfig(config, 1)).to.not.throw();
      expect(
        warnStub.calledWithMatch(
          sinon.match(
            'dex.oneInch.aggregationExecutorAllowlist has no entry for chain 1'
          )
        )
      ).to.equal(true);
      expect(
        warnStub.calledWithMatch(
          sinon.match(
            'candidateFeeTiers configured but UNISWAPV3 is not an enabled autodiscover direct DEX route source'
          )
        )
      ).to.equal(true);
    } finally {
      warnStub.restore();
    }
  });

  it('rejects non-string native profit and gas override integer values', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      minProfitNative: 1 as unknown as string,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: minProfitNative must be a non-negative decimal integer string'
    );

    config.discovery!.take = {
      enabled: true,
      minProfitNative: '1000000000000000000000000000000000000000000',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: minProfitNative must not exceed'
    );

    config.discovery!.take = {
      enabled: true,
      dexGasOverrides: {
        [LiquiditySource.UNISWAPV3]: 900000 as unknown as string,
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.2 must be a non-negative decimal integer string'
    );
  });

  it('validates gas override keys, skipped undefined values, and gas bounds', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      dexGasOverrides: {
        [LiquiditySource.UNISWAPV3]: undefined as unknown as string,
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();

    config.discovery!.take = {
      enabled: true,
      dexGasOverrides: {
        bogus: '900000',
      } as any,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.bogus is not a valid LiquiditySource'
    );

    config.discovery!.take = {
      enabled: true,
      dexGasOverrides: {
        [LiquiditySource.UNISWAPV3]: '99999',
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.2 must be between 100000 and 2000000'
    );

    config.discovery!.take = {
      enabled: true,
      dexGasOverrides: {
        [LiquiditySource.UNISWAPV3]: '2000001',
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.2 must be between 100000 and 2000000'
    );
  });

  it('requires external take context for quote-normalized profit floors', () => {
    const config = baseConfig();
    config.discovery!.defaults!.take = {
      minCollateral: 1,
      hpbPriceFactor: 0.99,
    };
    config.discovery!.take = {
      enabled: true,
      minExpectedProfitQuote: 1,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig: quote-normalized profit floors require discovery.defaults.take to configure an external take path'
    );
  });

  it('validates settlement defaults and quote-denominated gas caps', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      maxGasCostQuote: 1,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();

    config.discovery!.take = false;
    config.discovery!.settlement = {
      enabled: true,
      maxGasCostQuote: 1,
    };
    config.discovery!.defaults!.settlement = {
      enabled: true,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();

    delete config.discovery!.defaults!.settlement;

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig: enabled discovery.defaults.settlement required when discovery.settlement is enabled'
    );
  });

  it('treats allowedLiquiditySources as authoritative for source validation', () => {
    const config = baseConfig();
    delete config.dex!.uniswapV3!.router;
    config.takers!.contracts = {
      Curve: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    config.dex!.curve = {
      poolConfigs: {
        'WETH-USDC': {
          address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          poolType: CurvePoolType.STABLE,
        },
      },
      wethAddress: '0x4200000000000000000000000000000000000006',
    };
    config.network.tokenAddresses = {
      WETH: '0x4200000000000000000000000000000000000006',
      USDC: '0xcccccccccccccccccccccccccccccccccccccccc',
    };
    config.discovery!.take = {
      enabled: true,
      allowedLiquiditySources: [LiquiditySource.CURVE],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('rejects gas overrides for direct DEX sources outside the explicit allowlist', () => {
    const config = baseConfig();
    config.takers!.contracts = {
      UniswapV3: '0x3333333333333333333333333333333333333333',
      Curve: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    config.dex!.curve = {
      poolConfigs: {
        'WETH-USDC': {
          address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          poolType: CurvePoolType.STABLE,
        },
      },
      wethAddress: '0x4200000000000000000000000000000000000006',
    };
    config.network.tokenAddresses = {
      WETH: '0x4200000000000000000000000000000000000006',
      USDC: '0xcccccccccccccccccccccccccccccccccccccccc',
    };
    config.discovery!.take = {
      enabled: true,
      allowedLiquiditySources: [LiquiditySource.CURVE],
      dexGasOverrides: {
        [LiquiditySource.UNISWAPV3]: '900000',
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.UNISWAPV3 is not enabled by the effective take liquidity sources'
    );
  });

  it('rejects malformed numeric take-write timeouts', () => {
    const config = baseConfig();
    config.writes!.take = {
      mode: TakeWriteTransportMode.PUBLIC_RPC,
      receiptTimeoutMs: Number.POSITIVE_INFINITY,
    };

    expect(() => validateTakeWriteConfig(config)).to.throw(
      'KeeperConfig.writes.take: receiptTimeoutMs must be greater than 0 when provided'
    );
  });
});
