import { expect } from 'chai';
import sinon from 'sinon';
import {
  CurvePoolType,
  KeeperConfig,
  LiquiditySource,
  TakeWriteTransportMode,
  validateAutoDiscoverConfig,
  validateTakeSettings,
  validateTakeSettingsForChain,
  validateTakeWriteConfig,
} from '../../src/config';
import { logger } from '../../src/logging';

describe('auto-discover validation', () => {
  const baseConfig = (): KeeperConfig => ({
    network: {
      rpcUrl: 'http://localhost:8545',
      subgraph: {
        url: 'http://example-subgraph',
      },
    },
    signer: {
      keystore: '/tmp/keeper.json',
    },
    runtime: {
      logLevel: 'debug',
      delayBetweenRuns: 1,
    },
    ajna: {
      erc20PoolFactory: '0x0000000000000000000000000000000000000001',
      erc721PoolFactory: '0x0000000000000000000000000000000000000002',
      poolUtils: '0x0000000000000000000000000000000000000003',
      positionManager: '0x0000000000000000000000000000000000000004',
      ajnaToken: '0x0000000000000000000000000000000000000005',
    },
    manual: {
      pools: [],
    },
    writes: {},
    discovery: {
      enabled: true,
      take: true,
      settlement: false,
      defaults: {
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      },
    },
    takers: {
      router: '0x1234567890123456789012345678901234567890',
      contracts: {
        UniswapV3: '0x3333333333333333333333333333333333333333',
      },
    },
    dex: {
      oneInch: {},
      uniswapV3: {
        router: {
          swapRouter02Address: '0x5555555555555555555555555555555555555555',
          poolFactoryAddress: '0x7777777777777777777777777777777777777777',
          quoterV2Address: '0x1212121212121212121212121212121212121212',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
        },
      },
    },
  });

  const configureOneInchAggregatorTake = (config: KeeperConfig): void => {
    config.takers = {
      ...config.takers,
      router:
        config.takers?.router ?? '0x1234567890123456789012345678901234567890',
      contracts: {
        ...config.takers?.contracts,
        OneInchAggregator: '0x1234567890123456789012345678901234567890',
      },
    };
  };

  it('rejects 1inch gas overrides unless discovered takes use 1inch', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '700000',
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.ONEINCH requires an enabled calldata aggregator external take path'
    );
  });

  it('accepts 1inch gas overrides for 1inch discovered takes', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('accepts hybrid 1inch plus direct DEX autodiscover take paths', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
        [LiquiditySource.UNISWAPV3]: '900000',
      },
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('accepts disabled hybrid gas quote fallback mode', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      hybridGasQuoteFailureFallbackMode: 'disabled',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('accepts direct DEX-first hybrid gas quote fallback mode with a native gas cap', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
      hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
      maxGasCostNative: 0.01,
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('accepts direct DEX-first hybrid gas quote fallback mode for LI.FI plus direct DEX routes', () => {
    const config = baseConfig();
    const lifiCallTarget = '0x8888888888888888888888888888888888888888';
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['lifi'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      validateRouteDeployments: true,
      hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
      maxGasCostNative: 0.01,
      dexGasOverrides: {
        [LiquiditySource.LIFI]: '650000',
      },
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.LIFI,
      marketPriceFactor: 0.99,
    };
    config.takers!.contracts!.Lifi =
      '0x4444444444444444444444444444444444444444';
    config.dex!.lifi = {
      mode: 'production',
      allowExchanges: ['uniswap'],
      callTargetAllowlist: {
        1: [lifiCallTarget],
      },
      approvalSpenderAllowlist: {
        1: ['0x9999999999999999999999999999999999999999'],
      },
      selectorAllowlist: {
        1: {
          [lifiCallTarget]: ['0x12345678'],
        },
      },
    };
    const warnStub = sinon.stub(logger, 'warn');

    try {
      expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
      expect(
        warnStub
          .getCalls()
          .some((call) =>
            String(call.args[0]).includes(
              'hybridGasQuoteFailureFallbackMode=direct_dex_first is only eligible'
            )
          )
      ).to.equal(false);
    } finally {
      warnStub.restore();
    }
  });

  it('rejects unknown hybrid gas quote fallback mode', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      hybridGasQuoteFailureFallbackMode: 'gross_output' as any,
      maxGasCostNative: 0.01,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: hybridGasQuoteFailureFallbackMode must be disabled or direct_dex_first'
    );
  });

  it('rejects direct DEX-first hybrid gas quote fallback mode without maxGasCostNative', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      validateRouteDeployments: true,
      hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: hybridGasQuoteFailureFallbackMode=direct_dex_first requires maxGasCostNative'
    );
  });

  it('validates optional 1inch aggregation executor allowlists', () => {
    const config = baseConfig();
    config.dex!.oneInch!.aggregationExecutorAllowlist = {
      1: ['0x1111111111111111111111111111111111111111'],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();

    config.dex!.oneInch!.aggregationExecutorAllowlist = {
      1: [
        '0x1111111111111111111111111111111111111111',
        '0x1111111111111111111111111111111111111111',
      ],
    };
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'dex.oneInch.aggregationExecutorAllowlist.1 cannot contain duplicate addresses'
    );

    config.dex!.oneInch!.aggregationExecutorAllowlist = {
      1: ['not-an-address'],
    };
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'dex.oneInch.aggregationExecutorAllowlist.1 contains invalid address not-an-address'
    );

    config.dex!.oneInch!.aggregationExecutorAllowlist = {
      '01': ['0x1111111111111111111111111111111111111111'],
    } as any;
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'dex.oneInch.aggregationExecutorAllowlist entries must use canonical positive integer chain ID keys'
    );

    config.dex!.oneInch!.aggregationExecutorAllowlist = {
      1: Array.from(
        { length: 65 },
        (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`
      ),
    };
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'dex.oneInch.aggregationExecutorAllowlist.1 cannot contain more than 64 addresses'
    );
  });

  it('validates hybrid probe timeout and route selection mode', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
      externalTakeProbeTimeoutMs: 1500,
      externalTakeRouteSelectionMode: 'direct_dex_first',
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();

    (config.discovery!.take as any).externalTakeProbeTimeoutMs = 0;
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: externalTakeProbeTimeoutMs must be an integer between 1 and 10000'
    );

    (config.discovery!.take as any).externalTakeProbeTimeoutMs = 1500;
    (config.discovery!.take as any).externalTakeRouteSelectionMode = 'fastest';
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: externalTakeRouteSelectionMode must be maximize_profit or direct_dex_first'
    );
  });

  it('requires quote-denominated gas conversion config for hybrid route ranking', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
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
  });

  it('requires deployment preflight for hybrid oneinch plus direct DEX defaults', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: validateRouteDeployments=true required when resolved external take paths include calldata_aggregator'
    );
  });

  it('requires the direct DEX source allowlist to include the default hybrid direct DEX source', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
      allowedCalldataAggregatorProviders: ['oneinch'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.CURVE],
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    configureOneInchAggregatorTake(config);
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };
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

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedLiquiditySources must include the effective default direct DEX liquidity source'
    );
  });

  it('rejects non-finite and non-number take thresholds', () => {
    const config = baseConfig();
    expect(() =>
      validateTakeSettings(
        {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
          allowSubsidy: 'true' as unknown as boolean,
        },
        config
      )
    ).to.throw('TakeSettings: allowSubsidy must be a boolean');

    expect(() =>
      validateTakeSettings(
        {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
          allowSubsidy: true,
        },
        config
      )
    ).to.not.throw();

    expect(() =>
      validateTakeSettings(
        {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: Number.NaN,
        },
        {} as KeeperConfig
      )
    ).to.throw('TakeSettings: marketPriceFactor must be positive');

    expect(() =>
      validateTakeSettings(
        {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 99,
        },
        config
      )
    ).to.throw(
      'TakeSettings: marketPriceFactor 99 is unreasonable; values above 2 are rejected because values above 1 weaken market-factor protection. Did you mean 0.99?'
    );

    expect(() =>
      validateTakeSettings(
        {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.0000001,
        },
        config
      )
    ).to.throw(
      'TakeSettings: marketPriceFactor 1e-7 is below the minimum supported precision 0.000001'
    );

    expect(() =>
      validateTakeSettings(
        {
          minCollateral: '1' as unknown as number,
          hpbPriceFactor: 0.98,
        },
        {} as KeeperConfig
      )
    ).to.throw('TakeSettings: minCollateral must be greater than 0');

    expect(() =>
      validateTakeSettings(
        {
          minCollateral: 1,
          hpbPriceFactor: Number.POSITIVE_INFINITY,
        },
        {} as KeeperConfig
      )
    ).to.throw('TakeSettings: hpbPriceFactor must be positive');
  });

  it('warns when per-pool config allows subsidized external takes', () => {
    const config = baseConfig();
    config.manual.pools = [
      {
        name: 'Reviewed Defensive Pool',
        address: '0x0000000000000000000000000000000000000001',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
          allowSubsidy: true,
        },
      } as any,
    ];
    const warnStub = sinon.stub(logger, 'warn');

    try {
      validateTakeSettingsForChain(config, 1);
      expect(
        warnStub.calledWithMatch(
          sinon.match('Pool Reviewed Defensive Pool has take.allowSubsidy=true')
        )
      ).to.equal(true);
    } finally {
      warnStub.restore();
    }
  });

  it('warns when autodiscovery defaults allow subsidized external takes', () => {
    const config = baseConfig();
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.UNISWAPV3,
      marketPriceFactor: 0.99,
      allowSubsidy: true,
    };
    const warnStub = sinon.stub(logger, 'warn');

    try {
      expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
      expect(
        warnStub.calledWithMatch(
          sinon.match(
            'AutoDiscoverConfig: discovery.defaults.take.allowSubsidy=true can subsidize external takes'
          )
        )
      ).to.equal(true);
      expect(
        warnStub.calledWithMatch(
          sinon.match(
            'AutoDiscoverConfig: allowSubsidy=true is configured without minExpectedProfitQuote or minProfitNative'
          )
        )
      ).to.equal(true);
    } finally {
      warnStub.restore();
    }
  });

  it('rejects malformed numeric auto-discover policy values', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      maxPoolsPerRun: Number.NaN,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: maxPoolsPerRun must be a positive integer'
    );

    config.discovery!.take = false;
    config.discovery!.settlement = {
      enabled: true,
      maxGasCostNative: '0.01' as unknown as number,
    };
    config.discovery!.defaults!.settlement = {
      enabled: true,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.settlement: maxGasCostNative cannot be negative'
    );
  });

  it('validates hot-auction cache and gas control policy values', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      hotAuctionCandidateTtlMs: -1,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: hotAuctionCandidateTtlMs cannot be negative'
    );

    config.discovery!.take = {
      enabled: true,
      maxHotAuctionCandidates: 0,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: maxHotAuctionCandidates must be a positive integer'
    );

    config.discovery!.take = {
      enabled: true,
      l1GasPriceFreshnessTtlMs: -1,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: l1GasPriceFreshnessTtlMs cannot be negative'
    );

    config.discovery!.take = {
      enabled: true,
      l2GasCostBufferBasisPoints: 9_999,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: l2GasCostBufferBasisPoints must be an integer between 10000 and 30000'
    );

    config.discovery!.take = {
      enabled: true,
      gasPriceDriftToleranceBasisPoints: -1,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: gasPriceDriftToleranceBasisPoints must be an integer between 0 and 5000'
    );

    config.discovery!.take = {
      enabled: true,
      gasPriceDriftToleranceBasisPoints: 5_001,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: gasPriceDriftToleranceBasisPoints must be an integer between 0 and 5000'
    );

    config.discovery!.take = {
      enabled: true,
      oneInchQuoteTimeoutMs: 0,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: oneInchQuoteTimeoutMs must be an integer between 1 and 10000'
    );

    config.discovery!.take = {
      enabled: true,
      oneInchQuoteTimeoutMs: 10_001,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: oneInchQuoteTimeoutMs must be an integer between 1 and 10000'
    );

    config.discovery!.take = {
      enabled: true,
      externalTakeProbeTimeoutMs: 10_001,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: externalTakeProbeTimeoutMs must be an integer between 1 and 10000'
    );

    config.discovery!.take = {
      enabled: true,
      oneInchQuoteFailureCooldownMs: 0,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: oneInchQuoteFailureCooldownMs must be greater than 0'
    );

    config.discovery!.take = {
      enabled: true,
      oneInchQuoteFailureThreshold: 1.5,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: oneInchQuoteFailureThreshold must be an integer between 1 and 100'
    );

    config.discovery!.take = {
      enabled: true,
      validateRouteDeployments: 'yes' as unknown as boolean,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: validateRouteDeployments must be a boolean'
    );

    config.discovery!.take = {
      enabled: true,
      takeQuoteBudgetPerRun: 1.5,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: takeQuoteBudgetPerRun must be a positive integer'
    );

    config.discovery!.take = {
      enabled: true,
      takeRouteQuoteBudgetPerCandidate: 0.5,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: takeRouteQuoteBudgetPerCandidate must be a positive integer'
    );

    config.discovery!.take = {
      enabled: true,
      maxConcurrentCandidateEvaluations: 5,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: maxConcurrentCandidateEvaluations must be an integer between 1 and 4'
    );

    config.discovery!.take = {
      enabled: true,
      maxExecutionsPerPoolPerRun: 11,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: maxExecutionsPerPoolPerRun must be an integer between 1 and 10'
    );

    config.discovery!.take = {
      enabled: true,
      maxInFlightRouteProbes: 17,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: maxInFlightRouteProbes must be an integer between 1 and 16'
    );
  });

  it('warns when multi-execution takes force sequential candidate evaluation', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      maxExecutionsPerPoolPerRun: 2,
      maxConcurrentCandidateEvaluations: 2,
    };
    const warnStub = sinon.stub(logger, 'warn');

    try {
      expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
      expect(
        warnStub.calledWithMatch(
          sinon.match(
            'maxExecutionsPerPoolPerRun > 1 forces sequential same-pool candidate evaluation'
          )
        )
      ).to.equal(true);
    } finally {
      warnStub.restore();
    }
  });

  it('validates external take write transport policy', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      externalTakeTransportPolicy: 'strict' as any,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: externalTakeTransportPolicy must be allow_public, prefer_private_or_relay, or require_private_or_relay'
    );

    config.discovery!.take = {
      enabled: true,
      externalTakeTransportPolicy: 'require_private_or_relay',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: externalTakeTransportPolicy=require_private_or_relay requires writes.take.mode private_rpc or relay'
    );

    config.writes!.take = {
      mode: TakeWriteTransportMode.PRIVATE_RPC,
      rpcUrl: 'http://private-rpc',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();

    delete config.writes!.take;
    config.runtime.dryRun = true;

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('validates allowed external take path names, empties, and duplicates', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: [] as any,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedExternalTakePaths must be non-empty'
    );

    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['oneinch', 'bogus'] as any,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedExternalTakePaths currently supports only direct_dex or calldata_aggregator'
    );

    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['direct_dex', 'direct_dex'] as any,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedExternalTakePaths cannot contain duplicates'
    );
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
      dexGasOverrides: {
        [LiquiditySource.UNISWAPV3]: 900000 as unknown as string,
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.2 must be a non-negative decimal integer string'
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
