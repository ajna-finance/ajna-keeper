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

describe('Discovery Gas Policy 1inch Conversion', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('passes the configured 1inch timeout to gas quote conversions', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({
        maxGasCostQuote: 5,
        oneInchQuoteTimeoutMs: 750,
      }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
        oneInchQuoteTimeoutMs: 750,
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
    expect(oneInchQuoteStub.firstCall.args[4]).to.deep.equal({
      timeoutMs: 750,
    });
  });

  it('ceil-rounds gas quote apportionment and quotes gas plus native profit in one request', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasPrice = BigNumber.from(1);
    const gasLimit = BigNumber.from(100000);
    const gasCostNativeRaw = gasPrice.mul(gasLimit);
    const minProfitNativeRaw = ethers.utils.parseEther('1');
    const combinedNativeRaw = gasCostNativeRaw.add(minProfitNativeRaw);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => {
        expect(amountIn.eq(combinedNativeRaw)).to.be.true;
        return {
          success: true,
          dstAmount: '1',
        };
      });

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({
        maxGasCostQuote: 1,
        minProfitNative: minProfitNativeRaw.toString(),
      }),
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        maxGasCostQuote: 1,
        minProfitNative: minProfitNativeRaw.toString(),
      },
      gasLimit,
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice,
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(1)).to.be.true;
    expect(result.minProfitNativeQuoteRaw?.eq(0)).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('rejects zero-output 1inch gas quote conversions', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: '0',
      });

    const result = await evaluateGasPolicy({
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
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.false;
    expect(result.reason).to.equal('failed to quote gas cost into quote token');
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: '1inch gas quote conversion returned zero output',
    });
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('returns structured native-to-quote conversion rejection and per-source attempts when every gas quote source fails', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({ success: false, error: 'insufficient liquidity' });
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    const poolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .resolves(false);
    const uniswapQuoteStub = sinon.stub(
      UniswapV3QuoteProvider.prototype,
      'getQuote'
    );

    const result = await evaluateGasPolicy({
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
              candidateFeeTiers: [500, 100, 10000],
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
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.equal(false);
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.reason).to.equal('failed to quote gas cost into quote token');
    expect(
      result.gasQuoteAttempts?.map((attempt) => attempt.source)
    ).to.deep.equal([LiquiditySource.ONEINCH, LiquiditySource.UNISWAPV3]);
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: 'insufficient liquidity',
    });
    expect(result.gasQuoteAttempts?.[1]).to.deep.include({
      source: LiquiditySource.UNISWAPV3,
      success: false,
      reason: 'no direct DEX pool at configured fee tiers',
    });
    expect(result.gasQuoteAttempts?.[1].feeTiers).to.deep.equal([
      3000, 500, 100, 10000,
    ]);
    expect(poolExistsStub.callCount).to.equal(4);
    expect(uniswapQuoteStub.called).to.equal(false);
  });

  it('falls back when oneInchRouters is present but empty', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig(
        { maxGasCostQuote: 5 },
        { overrides: { oneInchRouters: {} } }
      ),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {},
    });

    expect(result.approved).to.be.false;
    expect(result.reason).to.equal(
      'no liquidity source available for gas cost conversion'
    );
  });

  it('recognizes wrapped native aliases from tokenAddresses for quote-denominated gas conversion', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const result = await evaluateGasPolicy({
      signer: signerWithChain(43114),
      config: oneInchGasConfig(
        { maxGasCostQuote: 5 },
        {
          chainId: 43114,
          overrides: {
            tokenAddresses: {
              wavax: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
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
      rpcCache: {},
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.firstCall.args[2]).to.equal(
      '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'
    );
  });

  it('quotes gas cost and minProfitNative together when no quote gas cap is configured', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasCostNativeRaw = ethers.utils.parseUnits('1', 'gwei').mul(900000);
    const bufferedGasCostNativeRaw = gasCostNativeRaw
      .mul(13000)
      .add(9999)
      .div(10000);
    const minProfitNative = ethers.utils.parseEther('0.01');
    const combinedNativeRaw = bufferedGasCostNativeRaw.add(minProfitNative);
    const combinedQuoteRaw = ethers.utils.parseUnits('21', 6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => ({
        success: true,
        dstAmount: amountIn.eq(combinedNativeRaw)
          ? combinedQuoteRaw.toString()
          : ethers.utils.parseUnits('999', 6).toString(),
      }));

    const result = await evaluateGasPolicy({
      signer: signerWithChain(8453),
      config: oneInchGasConfig({}, { chainId: 8453 }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        minProfitNative: minProfitNative.toString(),
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      useProfitFloor: true,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.be.true;
    expect(
      result.gasCostQuoteRaw
        ?.add(result.minProfitNativeQuoteRaw ?? BigNumber.from(0))
        .eq(combinedQuoteRaw)
    ).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.firstCall.args[1].eq(combinedNativeRaw)).to.be.true;
  });
});
