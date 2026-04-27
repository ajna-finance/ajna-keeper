import { expect } from 'chai';
import sinon from 'sinon';
import { CurvePoolType, LiquiditySource } from '../config';
import {
  createManualFactoryTakeContext,
  createManualSingleContractTakeContext,
  isFactoryExternalTakeSource,
} from '../take/manual-context';

describe('manual take context helpers', () => {
  afterEach(() => {
    sinon.restore();
  });

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

  it('builds the 1inch single-contract adapter only for 1inch pools', () => {
    const oneInchAdapter = { kind: 'oneinch' } as any;
    const noExternalAdapter = { kind: 'none' } as any;
    const createOneInchTakeAdapter = sinon.stub().returns(oneInchAdapter);
    const createNoExternalTakeAdapter = sinon.stub().returns(noExternalAdapter);

    const oneInchContext = createManualSingleContractTakeContext({
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
      adapters: {
        createOneInchTakeAdapter,
        createNoExternalTakeAdapter,
      },
    });

    expect(oneInchContext.externalTakeAdapter).to.equal(oneInchAdapter);
    expect(
      createOneInchTakeAdapter.calledOnceWithExactly({
        delayBetweenActions: 123,
        oneInchRouters: { 1: '0xrouter' },
        connectorTokens: ['0xconnector'],
      })
    ).to.equal(true);
    expect(createNoExternalTakeAdapter.called).to.equal(false);

    createOneInchTakeAdapter.resetHistory();
    createNoExternalTakeAdapter.resetHistory();

    const arbOnlyContext = createManualSingleContractTakeContext({
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
      adapters: {
        createOneInchTakeAdapter,
        createNoExternalTakeAdapter,
      },
    });

    expect(arbOnlyContext.externalTakeAdapter).to.equal(noExternalAdapter);
    expect(createOneInchTakeAdapter.called).to.equal(false);
    expect(createNoExternalTakeAdapter.calledOnce).to.equal(true);
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
