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

describe('Discovery Gas Policy Direct DEX Quotes', () => {
  afterEach(() => {
    sinon.restore();
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
      signer: signerWithChain(8453),
      config: oneInchGasConfig(
        {},
        {
          overrides: {
            autoDiscover: {
              enabled: true,
              settlement: {
                enabled: true,
                maxGasCostQuote: 5,
              },
            },
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
      rpcCache: {},
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.called).to.be.false;
    expect(uniswapAvailabilityStub.called).to.be.true;
    expect(uniswapPoolExistsStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
  });

  it('skips 1inch gas quote conversion while the quote circuit is open', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon.stub(
      DexRouter.prototype,
      'getQuoteFromOneInch'
    );
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      } as any);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(8453),
      config: oneInchGasConfig(
        {
          maxGasCostQuote: 5,
          oneInchQuoteFailureCooldownMs: 30_000,
          oneInchQuoteFailureThreshold: 2,
        },
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
        oneInchQuoteFailureCooldownMs: 30_000,
        oneInchQuoteFailureThreshold: 2,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
        providerCircuits: {
          oneinch: {
            gas_conversion: {
              failures: 2,
              cooldownUntilMs: Date.now() + 30_000,
            },
          },
        },
      },
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.called).to.be.false;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
    });
    expect(result.gasQuoteAttempts?.[0].reason).to.include(
      'purpose=gas_conversion'
    );
    expect(result.gasQuoteAttempts?.[1]).to.deep.include({
      source: LiquiditySource.UNISWAPV3,
      success: true,
      amountOut: ethers.utils.parseUnits('2', 6).toString(),
    });
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
      signer: signerWithChain(8453),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: WETH_ADDRESS,
          defaultFeeTier: 3000,
          candidateFeeTiers: [500],
        },
        tokenAddresses: {
          weth: WETH_ADDRESS,
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
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

  it('records a failed Uniswap gas quote attempt when pools exist but return no usable quote', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    const poolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({ success: false } as any);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(8453),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: WETH_ADDRESS,
          defaultFeeTier: 3000,
        },
        tokenAddresses: {
          weth: WETH_ADDRESS,
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.UNISWAPV3,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.equal(false);
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.gasQuoteAttempts).to.have.length(1);
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.UNISWAPV3,
      success: false,
      reason: 'direct DEX pool exists but returned no usable gas quote',
    });
    expect(result.gasQuoteAttempts?.[0].feeTiers).to.deep.equal([
      3000, 100, 500, 10000,
    ]);
    expect(poolExistsStub.callCount).to.equal(4);
    expect(uniswapQuoteStub.callCount).to.equal(4);
  });

  it('keeps the best V3 gas quote when a later fee tier fails', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    const poolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .callsFake(async (_tokenIn, _tokenOut, feeTier?: number) => {
        if (feeTier === 3000) {
          throw new Error('rpc timeout');
        }
        return feeTier === 500 || feeTier === 3000;
      });
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
      signer: signerWithChain(8453),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: WETH_ADDRESS,
          defaultFeeTier: 500,
        },
        tokenAddresses: {
          weth: WETH_ADDRESS,
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.UNISWAPV3,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('3', 6))).to.be
      .true;
    expect(poolExistsStub.callCount).to.equal(4);
    expect(uniswapQuoteStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.firstCall.args[3]).to.equal(500);
  });
});
