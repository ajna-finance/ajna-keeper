import { expect } from 'chai';
import {
  KeeperConfig,
  LiquiditySource,
  TakeWriteTransportMode,
  validateAutoDiscoverConfig,
  validateTakeSettings,
  validateTakeWriteConfig,
} from '../config';

describe('auto-discover validation', () => {
  const baseConfig = (): KeeperConfig =>
    ({
      ethRpcUrl: 'http://localhost:8545',
      logLevel: 'debug',
      subgraphUrl: 'http://example-subgraph',
      keeperKeystore: '/tmp/keeper.json',
      ajna: {
        erc20PoolFactory: '0x0000000000000000000000000000000000000001',
        erc721PoolFactory: '0x0000000000000000000000000000000000000002',
        poolUtils: '0x0000000000000000000000000000000000000003',
        positionManager: '0x0000000000000000000000000000000000000004',
        ajnaToken: '0x0000000000000000000000000000000000000005',
      },
      delayBetweenActions: 0,
      delayBetweenRuns: 1,
      pools: [],
      autoDiscover: {
        enabled: true,
        take: true,
        settlement: false,
      },
      discoveredDefaults: {
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      },
      keeperTakerFactory: '0x1234567890123456789012345678901234567890',
      takerContracts: {
        UniswapV3: '0x3333333333333333333333333333333333333333',
      },
      universalRouterOverrides: {
        universalRouterAddress: '0x5555555555555555555555555555555555555555',
        permit2Address: '0x6666666666666666666666666666666666666666',
        poolFactoryAddress: '0x7777777777777777777777777777777777777777',
        quoterV2Address: '0x1212121212121212121212121212121212121212',
        wethAddress: '0x4200000000000000000000000000000000000006',
        defaultFeeTier: 3000,
      },
    }) as KeeperConfig;

  it('rejects 1inch gas overrides unless discovered takes use 1inch', () => {
    const config = baseConfig();
    config.autoDiscover!.take = {
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
    config.autoDiscover!.take = {
      enabled: true,
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
      },
    };
    config.discoveredDefaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.keeperTaker = '0x1234567890123456789012345678901234567890';
    config.oneInchRouters = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('accepts hybrid 1inch plus factory autodiscover take paths', () => {
    const config = baseConfig();
    config.autoDiscover!.take = {
      enabled: true,
      allowedExternalTakePaths: ['oneinch', 'factory'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
        [LiquiditySource.UNISWAPV3]: '900000',
      },
    };
    config.discoveredDefaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.keeperTaker = '0x1234567890123456789012345678901234567890';
    config.oneInchRouters = {
      1: '0x1111111111111111111111111111111111111111',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('requires the factory allowlist to include the default hybrid factory source', () => {
    const config = baseConfig();
    config.autoDiscover!.take = {
      enabled: true,
      allowedExternalTakePaths: ['oneinch', 'factory'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.SUSHISWAP],
    };
    config.discoveredDefaults!.take = {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    };
    config.keeperTaker = '0x1234567890123456789012345678901234567890';
    config.oneInchRouters = {
      1: '0x1111111111111111111111111111111111111111',
    };
    config.takerContracts = {
      UniswapV3: '0x3333333333333333333333333333333333333333',
      SushiSwap: '0x4444444444444444444444444444444444444444',
    };
    config.sushiswapRouterOverrides = {
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

  it('rejects malformed numeric auto-discover policy values', () => {
    const config = baseConfig();
    config.autoDiscover!.take = {
      enabled: true,
      maxPoolsPerRun: Number.NaN,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: maxPoolsPerRun must be greater than 0'
    );

    config.autoDiscover!.take = false;
    config.autoDiscover!.settlement = {
      enabled: true,
      maxGasCostNative: '0.01' as unknown as number,
    };
    config.discoveredDefaults!.settlement = {
      enabled: true,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.settlement: maxGasCostNative cannot be negative'
    );
  });

  it('validates hot-auction cache and gas control policy values', () => {
    const config = baseConfig();
    config.autoDiscover!.take = {
      enabled: true,
      hotAuctionCandidateTtlMs: -1,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: hotAuctionCandidateTtlMs cannot be negative'
    );

    config.autoDiscover!.take = {
      enabled: true,
      maxHotAuctionCandidates: 0,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: maxHotAuctionCandidates must be greater than 0'
    );

    config.autoDiscover!.take = {
      enabled: true,
      l1GasPriceFreshnessTtlMs: -1,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: l1GasPriceFreshnessTtlMs cannot be negative'
    );

    config.autoDiscover!.take = {
      enabled: true,
      l2GasCostBufferBasisPoints: 9_999,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: l2GasCostBufferBasisPoints must be an integer between 10000 and 30000'
    );
  });

  it('validates external take write transport policy', () => {
    const config = baseConfig();
    config.autoDiscover!.take = {
      enabled: true,
      externalTakeTransportPolicy: 'strict' as any,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: externalTakeTransportPolicy must be allow_public, prefer_private_or_relay, or require_private_or_relay'
    );

    config.autoDiscover!.take = {
      enabled: true,
      externalTakeTransportPolicy: 'require_private_or_relay',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: externalTakeTransportPolicy=require_private_or_relay requires takeWrite private_rpc, relay, or takeWriteRpcUrl'
    );

    config.takeWrite = {
      mode: TakeWriteTransportMode.PRIVATE_RPC,
      rpcUrl: 'http://private-rpc',
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();

    delete config.takeWrite;
    config.dryRun = true;

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('rejects non-string native profit and gas override integer values', () => {
    const config = baseConfig();
    config.autoDiscover!.take = {
      enabled: true,
      minProfitNative: 1 as unknown as string,
    };

    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'AutoDiscoverConfig.take: minProfitNative must be a non-negative decimal integer string'
    );

    config.autoDiscover!.take = {
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
    delete config.universalRouterOverrides;
    config.takerContracts = {
      SushiSwap: '0x4444444444444444444444444444444444444444',
    };
    config.sushiswapRouterOverrides = {
      swapRouterAddress: '0x5555555555555555555555555555555555555555',
      factoryAddress: '0x7777777777777777777777777777777777777777',
      quoterV2Address: '0x1212121212121212121212121212121212121212',
      wethAddress: '0x4200000000000000000000000000000000000006',
      defaultFeeTier: 500,
    };
    config.autoDiscover!.take = {
      enabled: true,
      allowedLiquiditySources: [LiquiditySource.SUSHISWAP],
    };

    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('rejects gas overrides for factory sources outside the explicit allowlist', () => {
    const config = baseConfig();
    config.takerContracts = {
      UniswapV3: '0x3333333333333333333333333333333333333333',
      SushiSwap: '0x4444444444444444444444444444444444444444',
    };
    config.sushiswapRouterOverrides = {
      swapRouterAddress: '0x5555555555555555555555555555555555555555',
      factoryAddress: '0x7777777777777777777777777777777777777777',
      quoterV2Address: '0x1212121212121212121212121212121212121212',
      wethAddress: '0x4200000000000000000000000000000000000006',
      defaultFeeTier: 500,
    };
    config.autoDiscover!.take = {
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
    config.takeWrite = {
      mode: TakeWriteTransportMode.PUBLIC_RPC,
      receiptTimeoutMs: Number.POSITIVE_INFINITY,
    };

    expect(() => validateTakeWriteConfig(config)).to.throw(
      'KeeperConfig.takeWrite: receiptTimeoutMs must be greater than 0 when provided'
    );
  });
});
