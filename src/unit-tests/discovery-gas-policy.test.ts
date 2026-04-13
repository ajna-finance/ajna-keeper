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
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(rpcCache.gasQuoteConversions.size).to.equal(1);
  });
});
