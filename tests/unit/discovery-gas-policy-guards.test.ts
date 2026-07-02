import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { evaluateGasPolicy } from '../../src/discovery/gas-policy';
import { DexRouter } from '../../src/dex/router';
import * as erc20 from '../../src/erc20';
import {
  ONEINCH_ROUTER_ADDRESS,
  QUOTE_TOKEN_ADDRESS,
  WETH_ADDRESS,
  oneInchGasConfig,
  readRpcWithGasPrice,
  signerWithChain,
} from './helpers/discovery-gas-policy-fixture';

describe('Discovery Gas Policy Guards', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('rejects before gas reads when the signer provider is unavailable', async () => {
    const getGasPrice = sinon
      .stub()
      .rejects(new Error('gas price should not be read without a provider'));

    const result = await evaluateGasPolicy({
      signer: { provider: undefined } as any,
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: {
        readRpc: {
          getGasPrice,
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('provider_unavailable');
    expect(result.reason).to.equal('signer has no provider');
    expect(getGasPrice.called).to.be.false;
  });

  it('rejects gas prices above the configured cap', async () => {
    const gasPrice = ethers.utils.parseUnits('10', 'gwei');

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {},
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        maxGasPriceGwei: 1,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('gas_price_above_cap');
    expect(result.gasPriceRaw?.eq(gasPrice)).to.be.true;
    expect(result.gasPriceGwei).to.equal(10);
    expect(result.reason).to.equal(
      'gas price 10.00 gwei exceeds maxGasPriceGwei 1'
    );
  });

  it('rejects native gas cost above the configured cap before quote conversion', async () => {
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {},
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        maxGasCostNative: 0.0001,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('native_gas_cost_above_cap');
    expect(result.gasCostNative).to.equal(0.0009);
    expect(result.gasCostQuote).to.equal(0);
    expect(result.reason).to.equal(
      'estimated gas cost 0.000900 exceeds maxGasCostNative 0.0001'
    );
  });

  it('approves without quote conversion when no quote-denominated policy is required', async () => {
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {},
      transports: readRpcWithGasPrice(gasPrice),
      policy: {},
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostNative).to.equal(0.0009);
    expect(result.gasCostQuote).to.equal(0);
    expect(result.gasCostQuoteRaw).to.equal(undefined);
  });

  it('approves zero native gas cost without requiring wrapped-native config', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: readRpcWithGasPrice(BigNumber.from(0)),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice: BigNumber.from(0),
      requireGasCostQuote: true,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.isZero()).to.be.true;
    expect(result.quoteTokenDecimals).to.equal(6);
  });

  it('rejects quote-denominated gas policy when wrapped native is not configured', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          1: ONEINCH_ROUTER_ADDRESS,
        },
        connectorTokens: [],
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('wrapped_native_unconfigured');
    expect(result.reason).to.equal(
      'no wrapped native token configured for gas cost conversion'
    );
  });

  it('rejects when quoted gas cost exceeds the quote-token cap', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      });

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({ maxGasCostQuote: 1 }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 1,
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
    expect(result.rejectCode).to.equal('quote_gas_cost_above_cap');
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to.be
      .true;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: true,
      amountOut: ethers.utils.parseUnits('2', 6).toString(),
    });
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('prices gas and native profit directly when the quote token is wrapped native', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    const oneInchQuoteStub = sinon.stub(
      DexRouter.prototype,
      'getQuoteFromOneInch'
    );
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const gasLimit = BigNumber.from(900000);
    const minProfitNative = ethers.utils.parseEther('0.01');

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig(),
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        minProfitNative: minProfitNative.toString(),
        maxGasCostQuote: 1,
      },
      gasLimit,
      quoteTokenAddress: WETH_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      useProfitFloor: true,
      gasPrice,
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(gasPrice.mul(gasLimit))).to.be.true;
    expect(result.minProfitNativeQuoteRaw?.eq(minProfitNative)).to.be.true;
    expect(result.gasQuoteAttempts).to.equal(undefined);
    expect(oneInchQuoteStub.called).to.be.false;
  });
});
