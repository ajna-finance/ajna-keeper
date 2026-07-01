import { expect } from 'chai';
import { BigNumber, providers, Signer } from 'ethers';
import sinon from 'sinon';
import { DexRouter } from '../../src/dex/router';
import {
  DEX_ROUTER_FIXTURE,
  installDexRouterFixture,
  stubOneInchTokenReads,
} from './helpers/dex-router-fixture';

describe('DexRouter private 1inch swaps', () => {
  let signer: Signer;
  let mockProvider: providers.JsonRpcProvider;
  let dexRouter: DexRouter;
  let axiosGetStub: sinon.SinonStub;

  const { chainId, tokenIn, tokenOut, fromAddress, slippage } =
    DEX_ROUTER_FIXTURE;

  beforeEach(() => {
    const fixture = installDexRouterFixture();
    signer = fixture.signer;
    mockProvider = fixture.mockProvider;
    dexRouter = fixture.dexRouter;
    axiosGetStub = fixture.axiosGetStub;
    stubOneInchTokenReads(mockProvider, fromAddress);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('retries retryable 1inch swap-data failures before succeeding', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    try {
      sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
        success: true,
        dstAmount: '900000000000000000',
      });
      const getSwapDataStub = sinon.stub(dexRouter, 'getSwapDataFromOneInch');
      getSwapDataStub.onCall(0).resolves({
        success: false,
        error: 'network error',
        retryable: true,
      });
      getSwapDataStub.onCall(1).resolves({
        success: false,
        error: 'network error',
        retryable: true,
      });
      getSwapDataStub.onCall(2).resolves({
        success: true,
        data: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
          gas: '100000',
        },
      });

      const resultPromise = dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      await clock.runAllAsync();
      const result = await resultPromise;

      expect(result.success).to.be.true;
      expect(getSwapDataStub.callCount).to.equal(3);
    } finally {
      clock.restore();
    }
  });

  it('fails private 1inch swaps before quote when the API env is missing', async () => {
    delete process.env.ONEINCH_API;

    const result = await dexRouter['swapWithOneInch'](
      chainId,
      BigNumber.from('100000000'),
      tokenIn,
      tokenOut,
      slippage
    );

    expect(result).to.deep.equal({
      success: false,
      error: 'ONEINCH_API is not configured',
    });
    expect(axiosGetStub.called).to.be.false;
  });

  it('fails private 1inch swaps before quote when the API key env is missing', async () => {
    delete process.env.ONEINCH_API_KEY;

    const result = await dexRouter['swapWithOneInch'](
      chainId,
      BigNumber.from('100000000'),
      tokenIn,
      tokenOut,
      slippage
    );

    expect(result).to.deep.equal({
      success: false,
      error: 'ONEINCH_API_KEY is not configured',
    });
    expect(axiosGetStub.called).to.be.false;
  });

  it('rejects private 1inch swaps with out-of-range slippage before quote', async () => {
    const result = await dexRouter['swapWithOneInch'](
      chainId,
      BigNumber.from('100000000'),
      tokenIn,
      tokenOut,
      101
    );

    expect(result).to.deep.equal({
      success: false,
      error: 'Slippage must be between 0 and 100',
    });
    expect(axiosGetStub.called).to.be.false;
  });

  it('returns non-retryable 1inch swap-data failures without signing', async () => {
    sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
      success: true,
      dstAmount: '900000000000000000',
    });
    sinon.stub(dexRouter, 'getSwapDataFromOneInch').resolves({
      success: false,
      error: 'permanent quote rejection',
      retryable: false,
    });

    const result = await dexRouter['swapWithOneInch'](
      chainId,
      BigNumber.from('100000000'),
      tokenIn,
      tokenOut,
      slippage
    );

    expect(result).to.deep.equal({
      success: false,
      error: 'permanent quote rejection',
    });
    expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
  });

  it('rejects private 1inch swap-data with non-zero native value before signing', async () => {
    sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
      success: true,
      dstAmount: '900000000000000000',
    });
    sinon.stub(dexRouter, 'getSwapDataFromOneInch').resolves({
      success: true,
      data: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdata',
        value: '1',
      },
    });

    const result = await dexRouter['swapWithOneInch'](
      chainId,
      BigNumber.from('100000000'),
      tokenIn,
      tokenOut,
      slippage
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('unexpected non-zero 1inch tx.value');
    expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
  });

  it('fails private 1inch swaps when gas estimation fails', async () => {
    sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
      success: true,
      dstAmount: '900000000000000000',
    });
    sinon.stub(dexRouter, 'getSwapDataFromOneInch').resolves({
      success: true,
      data: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdata',
        value: '0',
      },
    });
    (mockProvider.estimateGas as sinon.SinonStub).rejects(
      new Error('estimation unavailable')
    );

    const result = await dexRouter['swapWithOneInch'](
      chainId,
      BigNumber.from('100000000'),
      tokenIn,
      tokenOut,
      slippage
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('Gas estimation failed');
    expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
  });

  it('uses zero value and estimated gas when 1inch omits tx.value and tx.gas', async () => {
    sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
      success: true,
      dstAmount: '900000000000000000',
    });
    sinon.stub(dexRouter, 'getSwapDataFromOneInch').resolves({
      success: true,
      data: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdata',
      },
    });

    const result = await dexRouter['swapWithOneInch'](
      chainId,
      BigNumber.from('100000000'),
      tokenIn,
      tokenOut,
      slippage
    );

    expect(result.success).to.be.true;
    const sentTx = (signer.sendTransaction as sinon.SinonStub).firstCall
      .args[0];
    expect(sentTx.value).to.equal('0');
    expect(sentTx.gasLimit.toString()).to.equal('110000');
  });

  it('retries thrown 1inch rate-limit errors before succeeding', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    try {
      sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
        success: true,
        dstAmount: '900000000000000000',
      });
      const getSwapDataStub = sinon.stub(dexRouter, 'getSwapDataFromOneInch');
      getSwapDataStub.onCall(0).rejects({
        response: {
          status: 429,
          data: { description: 'rate limited' },
        },
      });
      getSwapDataStub.onCall(1).resolves({
        success: true,
        data: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
        },
      });

      const resultPromise = dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      await clock.runAllAsync();
      const result = await resultPromise;

      expect(result.success).to.be.true;
      expect(getSwapDataStub.callCount).to.equal(2);
    } finally {
      clock.restore();
    }
  });
});
