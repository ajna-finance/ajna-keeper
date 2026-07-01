import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { evaluateGasPolicy } from '../../src/discovery/gas-policy';
import { DexRouter } from '../../src/dex/router';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import * as erc20 from '../../src/erc20';

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
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
            oneInchQuoteTimeoutMs: 750,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
        oneInchQuoteTimeoutMs: 750,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
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
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 1,
            minProfitNative: minProfitNativeRaw.toString(),
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
      },
      policy: {
        maxGasCostQuote: 1,
        minProfitNative: minProfitNativeRaw.toString(),
      },
      gasLimit,
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
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
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
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
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          candidateFeeTiers: [500, 100, 10000],
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
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
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {},
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
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
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(43114),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          43114: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          wavax: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
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
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        minProfitNative: minProfitNative.toString(),
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
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
