import { expect } from 'chai';
import { BigNumber, ethers, providers, Signer } from 'ethers';
import sinon from 'sinon';
import { DexRouter } from '../../src/dex/router';
import { executeOneInchSwap } from '../../src/dex/oneinch';
import {
  DEX_ROUTER_FIXTURE,
  installDexRouterFixture,
  stubOneInchTokenReads,
} from './helpers/dex-router-fixture';

describe('DexRouter 1inch quote and swap-data validation', () => {
  let signer: Signer;
  let mockProvider: providers.JsonRpcProvider;
  let dexRouter: DexRouter;
  let axiosGetStub: sinon.SinonStub;

  const { chainId, amount, tokenIn, tokenOut, to, fromAddress, slippage } =
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

  function executeSwap(amountIn: BigNumber = BigNumber.from('100000000')) {
    return executeOneInchSwap(
      {
        signer,
        getQuote: dexRouter.getQuoteFromOneInch.bind(dexRouter),
        getSwapData: dexRouter.getSwapDataFromOneInch.bind(dexRouter),
        queueTransaction: async (_signer, txFunc) => await txFunc(10),
        delayMs: async () => undefined,
      },
      {
        chainId,
        amount: amountIn,
        tokenIn,
        tokenOut,
        slippage,
      }
    );
  }

  it('should execute swap with 1inch successfully', async () => {
    axiosGetStub.onCall(0).resolves({
      data: {
        dstAmount: '900000000000000000',
        toTokenAmount: '900000000000000000',
        protocols: [],
      },
    });
    axiosGetStub.onCall(1).resolves({
      data: {
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
          gas: '100000',
        },
      },
    });

    const result = await executeSwap();

    expect(result.success).to.be.true;
    expect(axiosGetStub.calledTwice).to.be.true;

    expect(
      axiosGetStub
        .getCall(0)
        .calledWith(`${process.env.ONEINCH_API}/${chainId}/quote`, {
          params: {
            fromTokenAddress: tokenIn,
            toTokenAddress: tokenOut,
            amount: '100000000',
          },
          timeout: undefined,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
          },
        })
    ).to.be.true;

    expect(
      axiosGetStub
        .getCall(1)
        .calledWith(`${process.env.ONEINCH_API}/${chainId}/swap`, {
          params: {
            fromTokenAddress: tokenIn,
            toTokenAddress: tokenOut,
            amount: '100000000',
            fromAddress,
            slippage,
          },
          timeout: undefined,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
          },
        })
    ).to.be.true;
  });

  it('ignores gasPrice supplied by 1inch swap data', async () => {
    axiosGetStub.onCall(0).resolves({
      data: {
        dstAmount: '900000000000000000',
        toTokenAmount: '900000000000000000',
        protocols: [],
      },
    });
    axiosGetStub.onCall(1).resolves({
      data: {
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
          gas: '100000',
          gasPrice: '1000000000000',
        },
      },
    });

    const result = await executeSwap();

    expect(result.success).to.be.true;
    const sentTx = (signer.sendTransaction as sinon.SinonStub).firstCall
      .args[0];
    expect(sentTx.gasPrice).to.be.undefined;
  });

  it('should log error if axios fails', async () => {
    axiosGetStub.rejects(new Error('API error'));

    const result = await executeSwap(amount);

    expect(result).to.deep.equal({ success: false, error: 'API error' });
  });

  it('classifies timed-out 1inch quote requests as retryable', async () => {
    const timeoutError = new Error('timeout of 2000ms exceeded') as Error & {
      code: string;
    };
    timeoutError.code = 'ECONNABORTED';
    axiosGetStub.rejects(timeoutError);

    const result = await dexRouter.getQuoteFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      { timeoutMs: 2000 }
    );

    expect(result.success).to.be.false;
    expect(result.retryable).to.be.true;
    expect(result.errorCode).to.equal('ECONNABORTED');
    expect(axiosGetStub.firstCall.args[1].timeout).to.equal(2000);
  });

  it('fails 1inch quote requests before calling the API when env is missing', async () => {
    delete process.env.ONEINCH_API_KEY;

    const result = await dexRouter.getQuoteFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut
    );

    expect(result).to.deep.include({
      success: false,
      retryable: false,
      errorCode: 'missing_oneinch_env',
    });
    expect(axiosGetStub.called).to.be.false;
  });

  it('fails 1inch swap-data requests before calling the API when env is missing', async () => {
    delete process.env.ONEINCH_API;

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result).to.deep.include({
      success: false,
      retryable: false,
      errorCode: 'missing_oneinch_env',
    });
    expect(axiosGetStub.called).to.be.false;
  });

  it('passes connector tokens, timeout, and abort signal to 1inch quote requests', async () => {
    const controller = new AbortController();
    const routerWithConnectors = new DexRouter(signer, {
      oneInchRouters: {
        [chainId]: '0x1111111254EEB25477B68fb85Ed929f73A960582',
      },
      connectorTokens: [tokenOut, to],
    });
    axiosGetStub.resolves({
      data: {
        dstAmount: '900000000000000000',
      },
    });

    const result = await routerWithConnectors.getQuoteFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      { timeoutMs: 2500, signal: controller.signal }
    );

    expect(result.success).to.be.true;
    expect(axiosGetStub.firstCall.args[1]).to.deep.include({
      timeout: 2500,
      signal: controller.signal,
    });
    expect(axiosGetStub.firstCall.args[1].params.connectorTokens).to.equal(
      `${tokenOut},${to}`
    );
  });

  it('passes connector tokens and patching flags to 1inch swap-data requests', async () => {
    const controller = new AbortController();
    const routerWithConnectors = new DexRouter(signer, {
      oneInchRouters: {
        [chainId]: '0x1111111254EEB25477B68fb85Ed929f73A960582',
      },
      connectorTokens: [tokenOut, to],
    });
    axiosGetStub.resolves({
      data: {
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
        },
      },
    });

    const result = await routerWithConnectors.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress,
      true,
      { signal: controller.signal }
    );

    expect(result.success).to.be.true;
    expect(axiosGetStub.firstCall.args[1].signal).to.equal(controller.signal);
    expect(axiosGetStub.firstCall.args[1].params).to.deep.include({
      connectorTokens: `${tokenOut},${to}`,
      usePatching: true,
      disableEstimate: true,
    });
  });

  it('rejects malformed 1inch quote amounts before callers parse them', async () => {
    axiosGetStub.resolves({
      data: {
        dstAmount: '1e18',
      },
    });

    const result = await dexRouter.getQuoteFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('dstAmount is not a decimal uint string');
  });

  it('rejects 1inch quote amounts that exceed uint256', async () => {
    axiosGetStub.resolves({
      data: {
        dstAmount: ethers.constants.MaxUint256.add(1).toString(),
      },
    });

    const result = await dexRouter.getQuoteFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('dstAmount exceeds uint256');
  });

  it('classifies 1inch response status and code failures without losing API descriptions', async () => {
    const cases: Array<{
      error: any;
      retryable: boolean;
      errorCode: number | string;
    }> = [
      {
        error: {
          response: {
            status: 429,
            data: { description: 'rate limited' },
          },
        },
        retryable: true,
        errorCode: 429,
      },
      {
        error: {
          response: {
            status: 503,
            data: { description: 'upstream unavailable' },
          },
        },
        retryable: true,
        errorCode: 503,
      },
      {
        error: {
          response: {
            status: 400,
            data: { description: 'bad request' },
          },
          code: 'ETIMEDOUT',
        },
        retryable: true,
        errorCode: 400,
      },
      {
        error: {
          response: {
            status: 400,
            data: { description: 'permanent rejection' },
          },
        },
        retryable: false,
        errorCode: 400,
      },
    ];

    for (const testCase of cases) {
      axiosGetStub.reset();
      axiosGetStub.rejects(testCase.error);

      const result = await dexRouter.getQuoteFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal(testCase.error.response.data.description);
      expect(result.retryable).to.equal(testCase.retryable);
      expect(result.errorCode).to.equal(testCase.errorCode);
    }
  });

  it('rejects 1inch swap data without a complete transaction payload', async () => {
    axiosGetStub.resolves({
      data: {
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        },
      },
    });

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result.success).to.be.false;
    expect(result.error).to.equal('No valid transaction received from 1inch');
  });

  it('rejects 1inch swap data when the configured router is missing or malformed', async () => {
    axiosGetStub.resolves({
      data: {
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
        },
      },
    });

    const resultWithoutRouter = await new DexRouter(
      signer
    ).getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(resultWithoutRouter.success).to.be.false;
    expect(resultWithoutRouter.error).to.include('router validation failed');

    const resultWithMalformedRouter = await new DexRouter(signer, {
      oneInchRouters: {
        [chainId]: 'not-an-address',
      },
    }).getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(resultWithMalformedRouter.success).to.be.false;
    expect(resultWithMalformedRouter.error).to.include(
      'router validation failed'
    );
  });

  it('rejects 1inch swap data with a malformed tx target address', async () => {
    axiosGetStub.resolves({
      data: {
        tx: {
          to: 'not-an-address',
          data: '0xdata',
          value: '0',
        },
      },
    });

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('router validation failed');
  });

  it('rejects 1inch swap data when tx.to is not the configured router', async () => {
    axiosGetStub.resolves({
      data: {
        tx: {
          to: '0x9999999999999999999999999999999999999999',
          data: '0xdata',
          value: '0',
          gas: '100000',
        },
      },
    });

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('does not match configured router');
  });

  it('rejects 1inch swap data with non-zero native tx.value', async () => {
    axiosGetStub.resolves({
      data: {
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '1',
          gas: '100000',
        },
      },
    });

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('unexpected non-zero 1inch tx.value');
  });

  for (const zeroValue of [undefined, null, '', BigNumber.from(0), 0]) {
    it(`accepts zero 1inch native tx.value ${String(zeroValue)}`, async () => {
      const tx: any = {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdata',
      };
      if (zeroValue !== undefined) {
        tx.value = zeroValue;
      }
      axiosGetStub.resolves({
        data: {
          tx,
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.true;
    });
  }

  for (const invalidValue of [
    BigNumber.from(-1),
    BigNumber.from(1),
    ethers.constants.MaxUint256.add(1),
    -1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    it(`rejects unsafe 1inch native tx.value ${invalidValue.toString()}`, async () => {
      axiosGetStub.resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: invalidValue,
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('1inch tx.value');
    });
  }

  it('rejects 1inch swap data with negative native tx.value', async () => {
    axiosGetStub.resolves({
      data: {
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '-1',
          gas: '100000',
        },
      },
    });

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('1inch tx.value must be');
  });

  for (const malformedValue of [
    '0x',
    '0x0',
    '1.5',
    ethers.constants.MaxUint256.add(1).toString(),
  ]) {
    it(`rejects malformed 1inch native tx.value ${malformedValue}`, async () => {
      axiosGetStub.resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: malformedValue,
            gas: '100000',
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('1inch tx.value');
    });
  }

  it('returns validated dstAmount from 1inch swap data', async () => {
    axiosGetStub.resolves({
      data: {
        dstAmount: '900000000000000000',
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
          gas: '100000',
        },
      },
    });

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result.success).to.be.true;
    expect(result.dstAmount).to.equal('900000000000000000');
  });

  it('rejects malformed dstAmount from 1inch swap data', async () => {
    axiosGetStub.resolves({
      data: {
        dstAmount: '1e18',
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
          gas: '100000',
        },
      },
    });

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result.success).to.be.false;
    expect(result.error).to.include('dstAmount is not a decimal uint string');
  });

  it('returns 1inch swap-data API descriptions and retry classification on failures', async () => {
    axiosGetStub.rejects({
      response: {
        status: 503,
        data: { description: 'swap endpoint unavailable' },
      },
    });

    const result = await dexRouter.getSwapDataFromOneInch(
      chainId,
      amount,
      tokenIn,
      tokenOut,
      slippage,
      fromAddress
    );

    expect(result.success).to.be.false;
    expect(result.error).to.equal('swap endpoint unavailable');
    expect(result.retryable).to.be.true;
    expect(result.errorCode).to.equal(503);
  });
});
