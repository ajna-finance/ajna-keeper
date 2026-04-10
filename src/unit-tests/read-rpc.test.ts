import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber } from 'ethers';
import { JsonRpcProvider } from '../provider';
import {
  getResilientReadGasPrice,
  resetReadRpcHealthForTests,
} from '../read-rpc';

describe('Read RPC Failover', () => {
  afterEach(() => {
    sinon.restore();
    resetReadRpcHealthForTests();
  });

  it('uses the primary provider when no dedicated readRpcUrls are configured', async () => {
    const primaryProvider = {
      getGasPrice: sinon.stub().resolves(BigNumber.from(42)),
    };

    const gasPrice = await getResilientReadGasPrice({
      config: {
        ethRpcUrl: 'http://write-rpc',
      } as any,
      primaryProvider: primaryProvider as any,
    });

    expect(primaryProvider.getGasPrice.calledOnce).to.be.true;
    expect(gasPrice.toString()).to.equal('42');
  });

  it('fails over across configured readRpcUrls when the primary read endpoint fails', async () => {
    sinon
      .stub(JsonRpcProvider.prototype, 'getGasPrice')
      .callsFake(function (this: JsonRpcProvider) {
        const endpoint = (this as any).connection?.url;
        if (endpoint === 'http://read-rpc-a') {
          return Promise.reject(new Error('read-rpc-a unavailable'));
        }
        if (endpoint === 'http://read-rpc-b') {
          return Promise.resolve(BigNumber.from(77));
        }
        return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
      });

    const gasPrice = await getResilientReadGasPrice({
      config: {
        ethRpcUrl: 'http://write-rpc',
        readRpcUrls: ['http://read-rpc-a', 'http://read-rpc-b'],
      } as any,
    });

    expect(gasPrice.toString()).to.equal('77');
  });
});
