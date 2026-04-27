import { expect } from 'chai';
import { CurvePoolType, LiquiditySource } from '../config';
import {
  createManualFactoryTakeContext,
  createManualOneInchTakeContext,
  isFactoryExternalTakeSource,
} from '../take/manual-context';

describe('manual take context helpers', () => {
  it('classifies factory external take sources explicitly', () => {
    expect(isFactoryExternalTakeSource(LiquiditySource.UNISWAPV3)).to.equal(
      true
    );
    expect(isFactoryExternalTakeSource(LiquiditySource.SUSHISWAP)).to.equal(
      true
    );
    expect(isFactoryExternalTakeSource(LiquiditySource.CURVE)).to.equal(true);
    expect(isFactoryExternalTakeSource(LiquiditySource.ONEINCH)).to.equal(
      false
    );
    expect(isFactoryExternalTakeSource(undefined)).to.equal(false);
  });

  it('builds the manual 1inch adapter only for 1inch pools', () => {
    const oneInchContext = createManualOneInchTakeContext({
      poolConfig: {
        name: '1inch pool',
        take: { liquiditySource: LiquiditySource.ONEINCH },
      } as any,
      config: {
        dryRun: true,
        delayBetweenActions: 123,
        connectorTokens: ['0xconnector'],
        oneInchRouters: { 1: '0xrouter' },
        keeperTaker: '0xkeeper',
      },
    });

    expect(oneInchContext.externalTakeAdapter.kind).to.equal('oneinch');

    const arbOnlyContext = createManualOneInchTakeContext({
      poolConfig: {
        name: 'arb-only pool',
        take: {},
      } as any,
      config: {
        dryRun: true,
        delayBetweenActions: 123,
        connectorTokens: ['0xconnector'],
        oneInchRouters: { 1: '0xrouter' },
        keeperTaker: '0xkeeper',
      },
    });

    expect(arbOnlyContext.externalTakeAdapter.kind).to.equal('none');
  });

  it('builds a factory context without carrying 1inch-only config', () => {
    const context = createManualFactoryTakeContext({
      config: {
        dryRun: true,
        delayBetweenActions: 0,
        keeperTakerFactory: '0xfactory',
        universalRouterOverrides: { universalRouterAddress: '0xuniversal' },
        sushiswapRouterOverrides: { swapRouterAddress: '0xsushi' },
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
    });

    expect(context.externalTakeAdapter.kind).to.equal('factory');
    expect(context.externalExecutionConfig.keeperTakerFactory).to.equal(
      '0xfactory'
    );
    expect(context.foundLogLevel).to.equal('debug');
  });
});
