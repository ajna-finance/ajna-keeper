import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../config';
import { evaluateGasPolicy } from '../discovery/gas-policy';
import { DexRouter } from '../dex/router';
import { UniswapV3QuoteProvider } from '../dex/providers/uniswap-quote-provider';
import * as erc20 from '../erc20';

describe('Discovery Gas Policy', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('quotes native-to-quote gas conversions fresh within a discovery cycle', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const signer = {
      provider: {},
      getChainId: sinon.stub().resolves(1),
    };
    const rpcCache = {};
    const params = {
      signer: signer as any,
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
      rpcCache,
    };

    const firstResult = await evaluateGasPolicy(params);
    const secondResult = await evaluateGasPolicy(params);

    expect(firstResult.approved).to.be.true;
    expect(secondResult.approved).to.be.true;
    expect(firstResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to
      .be.true;
    expect(firstResult.quoteTokenDecimals).to.equal(6);
    expect(oneInchQuoteStub.calledTwice).to.be.true;
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
      signer: {
        provider: {},
        getChainId: sinon
          .stub()
          .rejects(new Error('should use cached chainId')),
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

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('applies the L2 gas buffer when only signer.getChainId can resolve the chain', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const gasLimit = BigNumber.from(900000);
    const bufferedGasCostNativeRaw = gasPrice
      .mul(gasLimit)
      .mul(13000)
      .add(9999)
      .div(10000);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => ({
        success: true,
        dstAmount: amountIn.eq(bufferedGasCostNativeRaw)
          ? ethers.utils.parseUnits('1.3', 6).toString()
          : ethers.utils.parseUnits('1', 6).toString(),
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
            maxGasCostQuote: 2,
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
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
      },
      policy: {
        maxGasCostQuote: 2,
      },
      gasLimit,
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1.3', 6))).to.be
      .true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
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

  it('falls back to uniswap gas quoting when 1inch is unavailable on the active chain', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon.stub(
      DexRouter.prototype,
      'getQuoteFromOneInch'
    );
    const uniswapAvailabilityStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'isAvailable')
      .returns(true);
    const uniswapPoolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      } as any);

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          settlement: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        universalRouterOverrides: {
          universalRouterAddress: '0x2222222222222222222222222222222222222222',
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
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
      rpcCache: {},
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.called).to.be.false;
    expect(uniswapAvailabilityStub.calledOnce).to.be.true;
    expect(uniswapPoolExistsStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
  });

  it('tries another configured gas quote source when the preferred source cannot quote', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({ success: false, error: 'no route' });
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      } as any);

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
        universalRouterOverrides: {
          universalRouterAddress: '0x2222222222222222222222222222222222222222',
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
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

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to.be
      .true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
  });

  it('uses candidate fee tiers for Uniswap gas quote conversion', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    const poolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .callsFake(
        async (_tokenIn, _tokenOut, feeTier?: number) => feeTier === 500
      );
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .callsFake(
        async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) =>
          ({
            success: feeTier === 500,
            dstAmount:
              feeTier === 500
                ? ethers.utils.parseUnits('3', 6).toString()
                : undefined,
          }) as any
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
        universalRouterOverrides: {
          universalRouterAddress: '0x2222222222222222222222222222222222222222',
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          candidateFeeTiers: [500],
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
      preferredLiquiditySource: LiquiditySource.UNISWAPV3,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('3', 6))).to.be
      .true;
    expect(poolExistsStub.calledTwice).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.firstCall.args[3]).to.equal(500);
  });

  it('quotes minProfitNative as a fresh exact native amount separate from gas cost', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasCostNativeRaw = ethers.utils.parseUnits('1', 'gwei').mul(900000);
    const bufferedGasCostNativeRaw = gasCostNativeRaw
      .mul(13000)
      .add(9999)
      .div(10000);
    const minProfitNative = ethers.utils.parseEther('0.01');
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => ({
        success: true,
        dstAmount: amountIn.eq(bufferedGasCostNativeRaw)
          ? ethers.utils.parseUnits('1', 6).toString()
          : ethers.utils.parseUnits('20', 6).toString(),
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
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to.be
      .true;
    expect(result.minProfitNativeQuoteRaw?.eq(ethers.utils.parseUnits('20', 6)))
      .to.be.true;
    expect(oneInchQuoteStub.calledTwice).to.be.true;
  });
});
