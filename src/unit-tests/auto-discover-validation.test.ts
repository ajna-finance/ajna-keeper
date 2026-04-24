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
      'AutoDiscoverConfig.take: dexGasOverrides.ONEINCH requires discoveredDefaults.take.liquiditySource to be ONEINCH'
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
