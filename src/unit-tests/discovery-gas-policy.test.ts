import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../config';
import { evaluateGasPolicy } from '../discovery/gas-policy';
import { DexRouter } from '../dex/router';
import * as erc20 from '../erc20';

describe('Discovery Gas Policy', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('reuses cached native-to-quote gas conversions within a discovery cycle', async () => {
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
    const rpcCache = {
      gasQuoteConversions: new Map<string, BigNumber | null>(),
    };
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
          getGasPrice: sinon.stub().resolves(ethers.utils.parseUnits('1', 'gwei')),
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
    expect(firstResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to.be.true;
    expect(firstResult.quoteTokenDecimals).to.equal(6);
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(rpcCache.gasQuoteConversions.size).to.equal(1);
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
          getGasPrice: sinon.stub().resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        gasQuoteConversions: new Map<string, BigNumber | null>(),
      },
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
          getGasPrice: sinon.stub().resolves(ethers.utils.parseUnits('1', 'gwei')),
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
        gasQuoteConversions: new Map<string, BigNumber | null>(),
      },
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.firstCall.args[2]).to.equal(
      '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'
    );
  });
});
