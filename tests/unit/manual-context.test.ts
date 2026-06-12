import { expect } from 'chai';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import { getDiscoveryExecutionConfig } from '../../src/discovery/types';
import {
  formatManualExternalTakeDeployment,
  formatManualTakeDeploymentFallback,
  formatManualTakeDeploymentResolutionLog,
  formatManualTakeContextStart,
  resolveManualTakeContext,
  resolveManualTakeDeployment,
  type ManualTakeDeploymentResolution,
} from '../../src/take/manual-context';

function expectManualDeploymentType<
  TDeploymentType extends ManualTakeDeploymentResolution['deploymentType'],
>(
  resolution: ManualTakeDeploymentResolution,
  deploymentType: TDeploymentType
): asserts resolution is ManualTakeDeploymentResolution & {
  deploymentType: TDeploymentType;
} {
  expect(resolution.deploymentType).to.equal(deploymentType);
}

describe('manual take context helpers', () => {
  it('resolves manual external take deployments from source-specific config', () => {
    expect(
      resolveManualTakeDeployment({
        poolConfig: { take: { liquiditySource: LiquiditySource.ONEINCH } },
        config: { keeperTaker: '0xoneinch' },
      }).deploymentType
    ).to.equal('oneinch');

    expect(
      resolveManualTakeDeployment({
        poolConfig: { take: { liquiditySource: LiquiditySource.UNISWAPV3 } },
        config: {
          keeperTakerFactory: '0xfactory',
          takerContracts: { UniswapV3: '0xuniswap' },
        },
      }).deploymentType
    ).to.equal('factory');

    const lifiDeployment = resolveManualTakeDeployment({
      poolConfig: { take: { liquiditySource: LiquiditySource.LIFI } },
      config: {
        keeperTakerFactory: '0xfactory',
        takerContracts: { Lifi: '0xlifi' },
      },
    });
    expectManualDeploymentType(lifiDeployment, 'calldata_aggregator');
    expect(lifiDeployment.resolvedTakerAddress).to.equal('0xlifi');

    const lifiWithoutCanonicalTaker = resolveManualTakeDeployment({
      poolConfig: { take: { liquiditySource: LiquiditySource.LIFI } },
      config: {
        keeperTakerFactory: '0xfactory',
      },
    });
    expectManualDeploymentType(lifiWithoutCanonicalTaker, 'none');
    expect(lifiWithoutCanonicalTaker.unavailableReason).to.equal(
      'takerContracts.Lifi is not configured'
    );
  });

  it('rejects manual external take deployments with only a different source taker', () => {
    const resolution = resolveManualTakeDeployment({
      poolConfig: { take: { liquiditySource: LiquiditySource.UNISWAPV3 } },
      config: {
        keeperTakerFactory: '0xfactory',
        takerContracts: { Lifi: '0xlifi' },
      },
    });

    expectManualDeploymentType(resolution, 'none');
    expect(resolution.unavailableReason).to.equal(
      'takerContracts.UniswapV3 is not configured'
    );
    expect(resolution.requestedLiquiditySourceLabel).to.equal('UNISWAPV3');
  });

  it('preserves factory taker contracts through discovery execution config for manual takes', () => {
    const executionConfig = getDiscoveryExecutionConfig({
      runtime: { dryRun: true },
      network: { tokenAddresses: {} },
      takers: {
        factory: '0x0000000000000000000000000000000000000001',
        contracts: {
          UniswapV3: '0x0000000000000000000000000000000000000002',
        },
      },
      discovery: {},
    } as any);

    expect(executionConfig.takerContracts?.UniswapV3).to.equal(
      '0x0000000000000000000000000000000000000002'
    );

    const context = resolveManualTakeContext({
      poolConfig: {
        name: 'config-loaded factory pool',
        take: { liquiditySource: LiquiditySource.UNISWAPV3 },
      } as any,
      config: executionConfig,
    });

    expect(context.deploymentResolution.deploymentType).to.equal('factory');
    expect(context.context.externalTakeAdapter.kind).to.equal('factory');
  });

  it('resolves manual take runtime context through deployment-aware fallback', () => {
    expect(
      resolveManualTakeContext({
        poolConfig: {
          name: '1inch pool',
          take: { liquiditySource: LiquiditySource.ONEINCH },
        } as any,
        config: {
          keeperTaker: '0xkeeper',
          oneInchRouters: { 1: '0xrouter' },
        },
      }).context.externalTakeAdapter.kind
    ).to.equal('oneinch');

    expect(
      resolveManualTakeContext({
        poolConfig: {
          name: 'factory pool',
          take: { liquiditySource: LiquiditySource.UNISWAPV3 },
        } as any,
        config: {
          keeperTakerFactory: '0xfactory',
          takerContracts: { UniswapV3: '0xuniswap' },
        },
      }).context.externalTakeAdapter.kind
    ).to.equal('factory');

    expect(
      resolveManualTakeContext({
        poolConfig: {
          name: 'LI.FI pool',
          take: { liquiditySource: LiquiditySource.LIFI },
        } as any,
        config: {
          keeperTakerFactory: '0xfactory',
          takerContracts: { Lifi: '0xlifi' },
        },
      }).context.externalTakeAdapter.kind
    ).to.equal('calldata_aggregator');

    expect(
      resolveManualTakeContext({
        poolConfig: {
          name: 'arb-only pool',
          take: {},
        } as any,
        config: {},
      }).context.externalTakeAdapter.kind
    ).to.equal('none');

    const unavailableExternalContext = resolveManualTakeContext({
      poolConfig: {
        name: 'missing factory pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.95,
          hpbPriceFactor: 0.99,
        },
      } as any,
      config: {
        keeperTakerFactory: '0xfactory',
      },
    });

    expect(
      unavailableExternalContext.deploymentResolution.deploymentType
    ).to.equal('none');
    expect(
      unavailableExternalContext.effectivePoolConfig.take.liquiditySource
    ).to.equal(undefined);
    expect(
      unavailableExternalContext.effectivePoolConfig.take.marketPriceFactor
    ).to.equal(undefined);
    expect(
      unavailableExternalContext.effectivePoolConfig.take.hpbPriceFactor
    ).to.equal(0.99);
    expect(
      unavailableExternalContext.context.externalTakeAdapter.kind
    ).to.equal('none');
  });

  it('formats manual context startup from the centralized source resolver', () => {
    expect(
      formatManualTakeContextStart({
        poolConfig: {
          name: 'LI.FI pool',
          take: { liquiditySource: LiquiditySource.LIFI },
        } as any,
        poolName: 'LI.FI pool',
      })
    ).to.equal(
      'Manual LI.FI external take context starting for pool: LI.FI pool'
    );
  });

  it('formats manual external take deployment logs outside the config registry', () => {
    expect(
      formatManualExternalTakeDeployment({
        deploymentType: 'calldata_aggregator',
        poolName: 'LI.FI pool',
      })
    ).to.equal(
      'Using manual LI.FI external take strategy for pool: LI.FI pool'
    );
  });

  it('formats manual deployment resolution and fallback logs from one model', () => {
    const missingDeployment = resolveManualTakeDeployment({
      poolConfig: { take: { liquiditySource: LiquiditySource.UNISWAPV3 } },
      config: { keeperTakerFactory: '0xfactory' },
    });

    expect(
      formatManualTakeDeploymentResolutionLog({
        resolution: missingDeployment,
        poolName: 'Factory pool',
      })
    ).to.deep.equal({
      level: 'warn',
      message:
        'Smart Detection: external liquidity source UNISWAPV3 requested for pool Factory pool but takerContracts.UniswapV3 is not configured',
    });
    expect(
      formatManualTakeDeploymentFallback({
        resolution: missingDeployment,
        poolName: 'Factory pool',
      })
    ).to.equal(
      'External liquidity source UNISWAPV3 unavailable for pool Factory pool - checking arbTake only'
    );

    const arbOnly = resolveManualTakeDeployment({
      poolConfig: { take: {} },
      config: {},
    });

    expect(
      formatManualTakeDeploymentResolutionLog({
        resolution: arbOnly,
        poolName: 'Arb pool',
      })
    ).to.deep.equal({
      level: 'debug',
      message:
        'Smart Detection: No external liquidity source configured for pool Arb pool',
    });
    expect(
      formatManualTakeDeploymentFallback({
        resolution: arbOnly,
        poolName: 'Arb pool',
      })
    ).to.equal(
      'No external liquidity source configured for pool Arb pool - checking arbTake only'
    );
  });

  it('builds the manual 1inch adapter only for 1inch pools', () => {
    const oneInchContext = resolveManualTakeContext({
      poolConfig: {
        name: '1inch pool',
        take: { liquiditySource: LiquiditySource.ONEINCH },
      } as any,
      config: {
        dryRun: true,
        connectorTokens: ['0xconnector'],
        oneInchRouters: { 1: '0xrouter' },
        keeperTaker: '0xkeeper',
      },
    }).context;

    expect(oneInchContext.externalTakeAdapter.kind).to.equal('oneinch');

    const arbOnlyContext = resolveManualTakeContext({
      poolConfig: {
        name: 'arb-only pool',
        take: {},
      } as any,
      config: {
        dryRun: true,
        connectorTokens: ['0xconnector'],
        oneInchRouters: { 1: '0xrouter' },
        keeperTaker: '0xkeeper',
      },
    }).context;

    expect(arbOnlyContext.externalTakeAdapter.kind).to.equal('none');
  });

  it('builds a factory context without carrying 1inch-only config', () => {
    const context = resolveManualTakeContext({
      poolConfig: {
        name: 'factory pool',
        take: { liquiditySource: LiquiditySource.UNISWAPV3 },
      } as any,
      config: {
        dryRun: true,
        keeperTakerFactory: '0xfactory',
        takerContracts: { UniswapV3: '0xuniswap' },
        uniswapV3RouterOverrides: { swapRouter02Address: '0xswaprouter02' },
        curveRouterOverrides: {
          poolConfigs: {
            WETH_USDC: {
              address: '0xcurve',
              poolType: CurvePoolType.STABLE,
            },
          },
        },
        tokenAddresses: { WETH: '0xweth' },
      },
    }).context;

    expect(context.externalTakeAdapter.kind).to.equal('factory');
    expect(context.externalExecutionConfig).to.deep.include({
      keeperTakerFactory: '0xfactory',
    });
    expect(context.foundLogLevel).to.equal('debug');
  });

  it('builds a LI.FI context with factory execution config', () => {
    const context = resolveManualTakeContext({
      poolConfig: {
        name: 'LI.FI pool',
        take: { liquiditySource: LiquiditySource.LIFI },
      } as any,
      config: {
        dryRun: true,
        keeperTakerFactory: '0xfactory',
        lifi: { mode: 'canary' },
        takerContracts: { Lifi: '0xlifi' },
      },
    }).context;

    expect(context.externalTakeAdapter.kind).to.equal('calldata_aggregator');
    expect(context.externalExecutionConfig).to.deep.include({
      keeperTakerFactory: '0xfactory',
      lifi: { mode: 'canary' },
      lifiTaker: '0xlifi',
    });
    expect(context.logPrefix).to.equal('LI.FI: ');
    expect(context.foundLogLevel).to.equal('info');
  });

  it('uses takers.contracts.Lifi as the canonical manual LI.FI taker address', () => {
    const context = resolveManualTakeContext({
      poolConfig: {
        name: 'LI.FI pool',
        take: { liquiditySource: LiquiditySource.LIFI },
      } as any,
      config: {
        dryRun: true,
        keeperTakerFactory: '0xfactory',
        lifiTaker: '0x1111111111111111111111111111111111111111',
        takerContracts: {
          Lifi: '0x2222222222222222222222222222222222222222',
        },
      },
    }).context;

    expect(context.externalTakeAdapter.kind).to.equal('calldata_aggregator');
    expect(context.externalExecutionConfig).to.deep.include({
      lifiTaker: '0x2222222222222222222222222222222222222222',
    });
  });
});
