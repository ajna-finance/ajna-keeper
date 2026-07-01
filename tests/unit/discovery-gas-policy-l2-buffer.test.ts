import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { evaluateGasPolicy } from '../../src/discovery/gas-policy';
import { DexRouter } from '../../src/dex/router';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import * as erc20 from '../../src/erc20';

describe('Discovery Gas Policy L2 Buffer', () => {
  afterEach(() => {
    sinon.restore();
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

  it('uses configured L2 gas buffer basis points', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const gasLimit = BigNumber.from(900000);
    const bufferedGasCostNativeRaw = gasPrice
      .mul(gasLimit)
      .mul(20000)
      .add(9999)
      .div(10000);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => ({
        success: true,
        dstAmount: amountIn.eq(bufferedGasCostNativeRaw)
          ? ethers.utils.parseUnits('2', 6).toString()
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
            maxGasCostQuote: 3,
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
        maxGasCostQuote: 3,
        l2GasCostBufferBasisPoints: 20_000,
      },
      gasLimit,
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to.be
      .true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });
});
