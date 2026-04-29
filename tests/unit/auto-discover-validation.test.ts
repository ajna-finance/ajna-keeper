import { expect } from 'chai';
import sinon from 'sinon';
import {
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
      delayBetweenActions: 0,
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
      factory: '0x1234567890123456789012345678901234567890',
      contracts: {
        UniswapV3: '0x3333333333333333333333333333333333333333',
      },
    },
    dex: {
      oneInch: {},
      uniswapV3: {
        universalRouter: {
          universalRouterAddress: '0x5555555555555555555555555555555555555555',
          permit2Address: '0x6666666666666666666666666666666666666666',
          poolFactoryAddress: '0x7777777777777777777777777777777777777777',
          quoterV2Address: '0x1212121212121212121212121212121212121212',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
        },
      },
    },
  });

  it('rejects 1inch gas overrides unless discovered takes use 1inch', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '700000',
      },
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.ONEINCH requires an enabled 1inch external take path'
    );
  });

  it('accepts 1inch gas overrides for 1inch discovered takes', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.takers!.oneInch = '0x1234567890123456789012345678901234567890';
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('accepts hybrid 1inch plus factory autodiscover take paths', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['oneinch', 'factory'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
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
    config.takers!.oneInch = '0x1234567890123456789012345678901234567890';
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
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
      allowedExternalTakePaths: ['oneinch', 'factory'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      validateRouteDeployments: true,
      externalTakeProbeTimeoutMs: 1500,
      externalTakeRouteSelectionMode: 'factory_first',
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.takers!.oneInch = '0x1234567890123456789012345678901234567890';
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
      'AutoDiscoverConfig.take: externalTakeRouteSelectionMode must be maximize_profit or factory_first'
    );
  });

  it('requires quote-denominated gas conversion config for hybrid route ranking', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['oneinch', 'factory'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      validateRouteDeployments: true,
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.takers!.oneInch = '0x1234567890123456789012345678901234567890';
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };
    config.dex!.uniswapV3!.universalRouter = {
      ...config.dex!.uniswapV3!.universalRouter!,
      wethAddress: undefined as unknown as string,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: hybrid external take route ranking requires a configured wrapped native token address'
    );
  });

  it('requires deployment preflight for hybrid oneinch plus factory defaults', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['oneinch', 'factory'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.takers!.oneInch = '0x1234567890123456789012345678901234567890';
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: validateRouteDeployments=true required when allowedExternalTakePaths includes both oneinch and factory'
    );
  });

  it('requires the factory allowlist to include the default hybrid factory source', () => {
    const config = baseConfig();
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['oneinch', 'factory'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.SUSHISWAP],
      validateRouteDeployments: true,
    };
    config.discovery!.defaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.takers!.oneInch = '0x1234567890123456789012345678901234567890';
    config.dex!.oneInch!.routers = {
      1: '0x1111111111111111111111111111111111111111',
    };
    config.takers!.contracts = {
      UniswapV3: '0x3333333333333333333333333333333333333333',
      SushiSwap: '0x4444444444444444444444444444444444444444',
    };
    config.dex!.sushiswap = {
      swapRouterAddress: '0x5555555555555555555555555555555555555555',
      factoryAddress: '0x7777777777777777777777777777777777777777',
      quoterV2Address: '0x1212121212121212121212121212121212121212',
      wethAddress: '0x4200000000000000000000000000000000000006',
      defaultFeeTier: 500,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: allowedLiquiditySources must include the effective default factory liquidity source'
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
      'AutoDiscoverConfig.take: allowedExternalTakePaths currently supports only oneinch and factory'
    );

    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['factory', 'factory'] as any,
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
    delete config.dex!.uniswapV3!.universalRouter;
    config.takers!.contracts = {
      SushiSwap: '0x4444444444444444444444444444444444444444',
    };
    config.dex!.sushiswap = {
      swapRouterAddress: '0x5555555555555555555555555555555555555555',
      factoryAddress: '0x7777777777777777777777777777777777777777',
      quoterV2Address: '0x1212121212121212121212121212121212121212',
      wethAddress: '0x4200000000000000000000000000000000000006',
      defaultFeeTier: 500,
    };
    config.discovery!.take = {
      enabled: true,
      allowedLiquiditySources: [LiquiditySource.SUSHISWAP],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('rejects gas overrides for factory sources outside the explicit allowlist', () => {
    const config = baseConfig();
    config.takers!.contracts = {
      UniswapV3: '0x3333333333333333333333333333333333333333',
      SushiSwap: '0x4444444444444444444444444444444444444444',
    };
    config.dex!.sushiswap = {
      swapRouterAddress: '0x5555555555555555555555555555555555555555',
      factoryAddress: '0x7777777777777777777777777777777777777777',
      quoterV2Address: '0x1212121212121212121212121212121212121212',
      wethAddress: '0x4200000000000000000000000000000000000006',
      defaultFeeTier: 500,
    };
    config.discovery!.take = {
      enabled: true,
      allowedLiquiditySources: [LiquiditySource.SUSHISWAP],
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
