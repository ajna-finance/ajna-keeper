import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { evaluateGasPolicy } from '../../src/discovery/gas-policy';
import { DexRouter } from '../../src/dex/router';
import * as erc20 from '../../src/erc20';
import {
  QUOTE_TOKEN_ADDRESS,
  oneInchGasConfig,
  readRpcWithGasPrice,
  signerWithChain,
} from './helpers/discovery-gas-policy-fixture';

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
      signer: signerWithChain(8453),
      config: oneInchGasConfig({ maxGasCostQuote: 2 }, { chainId: 8453 }),
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        maxGasCostQuote: 2,
      },
      gasLimit,
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
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
      signer: signerWithChain(8453),
      config: oneInchGasConfig({ maxGasCostQuote: 3 }, { chainId: 8453 }),
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        maxGasCostQuote: 3,
        l2GasCostBufferBasisPoints: 20_000,
      },
      gasLimit,
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to.be
      .true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });
});
