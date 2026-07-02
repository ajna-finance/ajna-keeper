import { expect } from 'chai';
import { BigNumber, providers, Signer } from 'ethers';
import sinon from 'sinon';
import {
  executeOneInchSwap,
  OneInchQuoteResult,
  OneInchSwapDataResult,
} from '../../src/dex/oneinch';
import {
  DEX_ROUTER_FIXTURE,
  installDexRouterFixture,
} from './helpers/dex-router-fixture';

describe('1inch swap executor', () => {
  let signer: Signer;
  let mockProvider: providers.JsonRpcProvider;
  let getQuote: sinon.SinonStub;
  let getSwapData: sinon.SinonStub;
  let queueTransaction: sinon.SinonStub;

  const { chainId, tokenIn, tokenOut, slippage } = DEX_ROUTER_FIXTURE;

  beforeEach(() => {
    const fixture = installDexRouterFixture();
    signer = fixture.signer;
    mockProvider = fixture.mockProvider;
    getQuote = sinon.stub().resolves(successfulQuote());
    getSwapData = sinon.stub().resolves(successfulSwapData());
    queueTransaction = sinon
      .stub()
      .callsFake(async (_signer, txFunc) => await txFunc(10));
  });

  afterEach(() => {
    sinon.restore();
  });

  function successfulQuote(): OneInchQuoteResult {
    return {
      success: true,
      dstAmount: '900000000000000000',
    };
  }

  function successfulSwapData(): OneInchSwapDataResult {
    return {
      success: true,
      data: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdata',
        value: BigNumber.from(0),
      },
    };
  }

  function runSwap(amount: BigNumber = BigNumber.from('100000000')) {
    return executeOneInchSwap(
      {
        signer,
        getQuote,
        getSwapData,
        queueTransaction,
        delayMs: async () => undefined,
      },
      {
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
      }
    );
  }

  it('retries retryable 1inch swap-data failures before succeeding', async () => {
    getSwapData.onCall(0).resolves({
      success: false,
      error: 'network error',
      retryable: true,
    });
    getSwapData.onCall(1).resolves({
      success: false,
      error: 'network error',
      retryable: true,
    });
    getSwapData.onCall(2).resolves(successfulSwapData());

    const result = await runSwap();

    expect(result.success).to.be.true;
    expect(getSwapData.callCount).to.equal(3);
  });

  it('refuses to send swap data carrying a non-zero native value', async () => {
    getSwapData.resolves({
      success: true,
      data: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdata',
        value: BigNumber.from(5),
      },
    });

    const result = await runSwap();

    expect(result).to.deep.equal({
      success: false,
      error: 'unexpected non-zero 1inch tx.value 5 for ERC20 swap',
    });
    expect((mockProvider.estimateGas as sinon.SinonStub).called).to.be.false;
    expect(queueTransaction.called).to.be.false;
  });

  it('returns quote failures before requesting swap data', async () => {
    getQuote.resolves({
      success: false,
      error: 'ONEINCH_API is not configured',
      retryable: false,
      errorCode: 'missing_oneinch_env',
    });

    const result = await runSwap();

    expect(result).to.deep.equal({
      success: false,
      error: 'ONEINCH_API is not configured',
    });
    expect(getQuote.calledOnce).to.be.true;
    expect(getSwapData.called).to.be.false;
  });

  it('rejects out-of-range slippage before quote', async () => {
    const result = await executeOneInchSwap(
      {
        signer,
        getQuote,
        getSwapData,
        queueTransaction,
      },
      {
        chainId,
        amount: BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage: 101,
      }
    );

    expect(result).to.deep.equal({
      success: false,
      error: 'Slippage must be between 0 and 100',
    });
    expect(getQuote.called).to.be.false;
  });

  it('returns non-retryable 1inch swap-data failures without signing', async () => {
    getSwapData.resolves({
      success: false,
      error: 'permanent quote rejection',
      retryable: false,
    });

    const result = await runSwap();

    expect(result).to.deep.equal({
      success: false,
      error: 'permanent quote rejection',
    });
    expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
  });

  it('returns validated swap-data failures before signing', async () => {
    getSwapData.resolves({
      success: false,
      error: 'unexpected non-zero 1inch tx.value 1 for ERC20 swap',
      retryable: false,
    });

    const result = await runSwap();

    expect(result.success).to.be.false;
    if (result.success) expect.fail('Expected non-zero value to fail');
    expect(result.error).to.include('unexpected non-zero 1inch tx.value');
    expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
  });

  it('fails when gas estimation fails', async () => {
    (mockProvider.estimateGas as sinon.SinonStub).rejects(
      new Error('estimation unavailable')
    );

    const result = await runSwap();

    expect(result.success).to.be.false;
    if (result.success) expect.fail('Expected gas estimation failure');
    expect(result.error).to.include('Gas estimation failed');
    expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
  });

  it('uses the validated zero value and estimated gas', async () => {
    getSwapData.resolves({
      success: true,
      data: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdata',
        value: BigNumber.from(0),
      },
    });

    const result = await runSwap();

    expect(result.success).to.be.true;
    const sentTx = (signer.sendTransaction as sinon.SinonStub).firstCall
      .args[0];
    expect(BigNumber.from(sentTx.value).isZero()).to.equal(true);
    expect(sentTx.gasLimit.toString()).to.equal('110000');
  });

  it('retries thrown 1inch rate-limit errors before succeeding', async () => {
    getSwapData.onCall(0).rejects({
      response: {
        status: 429,
        data: { description: 'rate limited' },
      },
    });
    getSwapData.onCall(1).resolves(successfulSwapData());

    const result = await runSwap();

    expect(result.success).to.be.true;
    expect(getSwapData.callCount).to.equal(2);
  });
});
