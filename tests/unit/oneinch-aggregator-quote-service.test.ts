import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import sinon from 'sinon';
import { DexRouter } from '../../src/dex/router';
import * as oneInch from '../../src/dex/one-inch';
import {
  getOneInchAggregatorQuoteFailureMetadata,
  requestValidatedOneInchAggregatorQuote,
  resolveOneInchAggregatorChainId,
} from '../../src/take/oneinch-aggregator/quote-service';

const chainId = 8453;
const router = '0x' + '11'.repeat(20);
const taker = '0x' + '22'.repeat(20);
const collateral = '0x' + '33'.repeat(20);
const quote = '0x' + '44'.repeat(20);
const executor = '0x' + '55'.repeat(20);
const callData = '0x12345678abcdef';
const amountIn = BigNumber.from('1000000');
const minReturn = BigNumber.from('900000');
const dstAmount = BigNumber.from('1000000');

describe('1inch aggregator quote service', () => {
  const pool = {
    collateralAddress: collateral,
    quoteAddress: quote,
  } as any;
  const signer = { provider: {} } as any;

  afterEach(() => {
    sinon.restore();
  });

  function stubDecodedSwap() {
    sinon.stub(oneInch, 'convertSwapApiResponseToDetails').returns({
      aggregationExecutor: executor,
      swapDescription: {
        srcToken: collateral,
        dstToken: quote,
        srcReceiver: router,
        dstReceiver: taker,
        amount: amountIn,
        minReturnAmount: minReturn,
        flags: 0,
      },
      opaqueData: '0x',
    } as any);
  }

  it('normalizes validated 1inch swap calldata into the shared aggregator quote', async () => {
    sinon.stub(DexRouter.prototype, 'getSwapDataFromOneInch').resolves({
      success: true,
      data: {
        to: router,
        data: callData,
        value: '0',
      },
      dstAmount: dstAmount.toString(),
    });
    stubDecodedSwap();

    const normalized = await requestValidatedOneInchAggregatorQuote({
      pool,
      signer,
      config: {
        oneInchRouters: { [chainId]: router },
      },
      takerAddress: taker,
      chainId,
      collateralInTokenDecimals: amountIn,
    });

    expect(normalized).to.include({
      providerId: 'oneinch',
      chainId,
      srcToken: collateral,
      dstToken: quote,
      dstReceiver: taker,
      transactionTarget: router,
      approvalSpender: router,
      callData,
      selector: ethers.utils.hexDataSlice(callData, 0, 4),
      txValue: '0',
    });
    expect(normalized.amountInTokenUnits.eq(amountIn)).to.equal(true);
    expect(normalized.quoteAmountRaw.eq(dstAmount)).to.equal(true);
    expect(normalized.routeMinOutRaw.eq(minReturn)).to.equal(true);
    expect(normalized.routeSummary).to.deep.equal({
      providerId: 'oneinch',
      tool: '1inch',
      feeCosts: [],
    });
  });

  it('rejects swap calldata without a normalized 1inch dstAmount', async () => {
    sinon.stub(DexRouter.prototype, 'getSwapDataFromOneInch').resolves({
      success: true,
      data: {
        to: router,
        data: callData,
        value: '0',
      },
    });

    try {
      await requestValidatedOneInchAggregatorQuote({
        pool,
        signer,
        config: {
          oneInchRouters: { [chainId]: router },
        },
        takerAddress: taker,
        chainId,
        collateralInTokenDecimals: amountIn,
      });
      expect.fail('expected missing dstAmount to reject');
    } catch (error) {
      expect((error as Error).message).to.equal(
        '1inch swap data is missing dstAmount'
      );
      expect(getOneInchAggregatorQuoteFailureMetadata(error)).to.deep.equal({
        retryable: true,
        code: 'invalid_response',
      });
    }
  });

  it('classifies decoded route validation failures as local fail-closed rejects', async () => {
    sinon.stub(DexRouter.prototype, 'getSwapDataFromOneInch').resolves({
      success: true,
      data: {
        to: router,
        data: callData,
        value: '0',
      },
      dstAmount: dstAmount.toString(),
    });
    stubDecodedSwap();
    sinon
      .stub(oneInch, 'validateOneInchSwapDetailsForAtomicTake')
      .returns('1inch swap description dstReceiver mismatch');

    try {
      await requestValidatedOneInchAggregatorQuote({
        pool,
        signer,
        config: {
          oneInchRouters: { [chainId]: router },
        },
        takerAddress: taker,
        chainId,
        collateralInTokenDecimals: amountIn,
      });
      expect.fail('expected validation failure to reject');
    } catch (error) {
      expect((error as Error).message).to.equal(
        '1inch swap description dstReceiver mismatch'
      );
      expect(getOneInchAggregatorQuoteFailureMetadata(error)).to.deep.equal({
        retryable: false,
        code: 'route_validation',
      });
    }
  });

  it('caches the configured chain-id verification per signer across evaluations', async () => {
    // resolveOneInchAggregatorChainId verifies the signer chain id matches the
    // configured one, memoized per signer (assertConfiguredChainIdMatchesSigner's
    // WeakMap), so repeated quote evaluations do not re-issue eth_chainId.
    const getChainId = sinon.stub().resolves(chainId);
    const memoSigner = { getChainId, provider: {} } as any;
    const config = { chainId };

    await resolveOneInchAggregatorChainId(config, memoSigner);
    await resolveOneInchAggregatorChainId(config, memoSigner);

    expect(getChainId.calledOnce).to.equal(true);
  });

  it('forwards the configured abort signal to the 1inch swap request', async () => {
    const controller = new AbortController();
    const swapDataStub = sinon
      .stub(DexRouter.prototype, 'getSwapDataFromOneInch')
      .resolves({
        success: true,
        data: {
          to: router,
          data: callData,
          value: '0',
        },
        dstAmount: dstAmount.toString(),
      });
    stubDecodedSwap();

    await requestValidatedOneInchAggregatorQuote({
      pool,
      signer,
      config: {
        oneInchRouters: { [chainId]: router },
        oneInchRequestAbortSignal: controller.signal,
      },
      takerAddress: taker,
      chainId,
      collateralInTokenDecimals: amountIn,
    });

    expect(swapDataStub.calledOnce).to.equal(true);
    // getSwapDataFromOneInch(chainId, amount, tokenIn, tokenOut, slippage,
    //   fromAddress, usePatching, options) — options is the 8th positional arg.
    expect(swapDataStub.firstCall.args[7]).to.deep.equal({
      timeoutMs: undefined,
      signal: controller.signal,
    });
  });
});
