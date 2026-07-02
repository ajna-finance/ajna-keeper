import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { evaluateGasPolicy } from '../../src/discovery/gas-policy';
import { DexRouter } from '../../src/dex/router';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import * as erc20 from '../../src/erc20';
import {
  QUOTE_TOKEN_ADDRESS,
  WETH_ADDRESS,
  oneInchGasConfig,
  readRpcWithGasPrice,
  signerWithChain,
} from './helpers/discovery-gas-policy-fixture';

describe('Discovery Gas Policy Cache', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('reuses identical native-to-quote gas conversions within a discovery cycle', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const rpcCache = { stats: {} };
    const params = {
      signer: signerWithChain(1),
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache,
    };

    const firstResult = await evaluateGasPolicy(params);
    const secondResult = await evaluateGasPolicy(params);

    expect(firstResult.approved).to.be.true;
    expect(secondResult.approved).to.be.true;
    expect(firstResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to
      .be.true;
    expect(firstResult.quoteTokenDecimals).to.equal(6);
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(rpcCache.stats).to.deep.include({
      gasQuoteConversionCacheMisses: 1,
      gasQuoteConversionCacheHits: 1,
    });
  });

  it('expires native-to-quote gas conversion cache entries', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .onFirstCall()
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      })
      .onSecondCall()
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      });

    const rpcCache = { stats: {} };
    const params = {
      signer: signerWithChain(1),
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache,
    };

    const firstResult = await evaluateGasPolicy(params);
    const cachedResult = await evaluateGasPolicy(params);
    clock.tick(30_001);
    const refreshedResult = await evaluateGasPolicy(params);

    expect(firstResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to
      .be.true;
    expect(cachedResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to
      .be.true;
    expect(refreshedResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6)))
      .to.be.true;
    expect(oneInchQuoteStub.calledTwice).to.be.true;
    expect(rpcCache.stats).to.deep.include({
      gasQuoteConversionCacheMisses: 2,
      gasQuoteConversionCacheHits: 1,
    });
  });

  it('uses the cached discovery chainId instead of calling signer.getChainId per evaluation', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const result = await evaluateGasPolicy({
      signer: signerWithChain(new Error('should use cached chainId')),
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('retries a preferred gas quote source after a short fallback-cache window', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .onFirstCall()
      .resolves({ success: false, error: 'temporary no route' })
      .onSecondCall()
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      } as any);
    const rpcCache = {
      chainId: 8453,
      stats: {},
    };
    const params = {
      signer: signerWithChain(8453),
      config: oneInchGasConfig(
        { maxGasCostQuote: 5 },
        {
          chainId: 8453,
          overrides: {
            uniswapV3RouterOverrides: {
              poolFactoryAddress: '0x3333333333333333333333333333333333333333',
              quoterV2Address: '0x4444444444444444444444444444444444444444',
              wethAddress: WETH_ADDRESS,
              defaultFeeTier: 3000,
              candidateFeeTiers: [3000],
            },
          },
        }
      ),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache,
    };

    const firstResult = await evaluateGasPolicy(params);
    const cachedFallbackResult = await evaluateGasPolicy(params);
    clock.tick(5_001);
    const preferredResult = await evaluateGasPolicy(params);

    expect(firstResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to
      .be.true;
    expect(
      cachedFallbackResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))
    ).to.be.true;
    expect(preferredResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6)))
      .to.be.true;
    expect(oneInchQuoteStub.calledTwice).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
    expect(rpcCache.stats).to.deep.include({
      gasQuoteConversionCacheMisses: 2,
      gasQuoteConversionCacheHits: 1,
    });
  });
});
