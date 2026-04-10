import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { getLoansToKick } from '../kick';
import * as priceModule from '../price';
import subgraph from '../subgraph';
import { PriceOriginPoolReference, PriceOriginSource } from '../config';

function buildLoanDetails() {
  return {
    thresholdPrice: ethers.utils.parseEther('5'),
    liquidationBond: ethers.utils.parseEther('1'),
    debt: ethers.utils.parseEther('10'),
    neutralPrice: ethers.utils.parseEther('2'),
  };
}

describe('kick', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('hoists non-pool kick price lookups once per kick pass', async () => {
    sinon.stub(subgraph, 'getLoans').resolves({
      loans: [{ borrower: '0xBorrowerA' }, { borrower: '0xBorrowerB' }],
    } as any);
    const getPriceStub = sinon.stub(priceModule, 'getPrice').resolves(1);

    const pool = {
      name: 'Kick Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      getLoans: sinon.stub().resolves(
        new Map([
          ['0xBorrowerA', { liquidationBond: ethers.utils.parseEther('2') }],
          ['0xBorrowerB', { liquidationBond: ethers.utils.parseEther('1') }],
        ])
      ),
      getPrices: sinon.stub().resolves({
        lup: ethers.utils.parseEther('1'),
        hpb: ethers.utils.parseEther('1'),
      }),
      getLoan: sinon.stub().callsFake(async () => buildLoanDetails()),
    };

    const loans = [];
    for await (const loan of getLoansToKick({
      pool: pool as any,
      poolConfig: {
        name: 'Kick Pool',
        address: pool.poolAddress,
        price: {
          source: PriceOriginSource.COINGECKO,
          query: 'price?ids=ethereum&vs_currencies=usd',
        },
        kick: {
          minDebt: 1,
          priceFactor: 0.9,
        },
      } as any,
      config: {
        subgraphUrl: 'http://example-subgraph',
        coinGeckoApiKey: 'test-key',
        ethRpcUrl: 'http://example-rpc',
        tokenAddresses: {},
      },
      chainId: 1,
    })) {
      loans.push(loan);
    }

    expect(loans).to.have.length(2);
    expect(getPriceStub.calledOnce).to.be.true;
  });

  it('keeps pool-derived kick price lookups per borrower iteration', async () => {
    sinon.stub(subgraph, 'getLoans').resolves({
      loans: [{ borrower: '0xBorrowerA' }, { borrower: '0xBorrowerB' }],
    } as any);
    const getPriceStub = sinon.stub(priceModule, 'getPrice').resolves(1);

    const pool = {
      name: 'Kick Pool',
      poolAddress: '0x2222222222222222222222222222222222222222',
      getLoans: sinon.stub().resolves(
        new Map([
          ['0xBorrowerA', { liquidationBond: ethers.utils.parseEther('2') }],
          ['0xBorrowerB', { liquidationBond: ethers.utils.parseEther('1') }],
        ])
      ),
      getPrices: sinon.stub().resolves({
        lup: ethers.utils.parseEther('1'),
        hpb: ethers.utils.parseEther('1'),
      }),
      getLoan: sinon.stub().callsFake(async () => buildLoanDetails()),
    };

    const loans = [];
    for await (const loan of getLoansToKick({
      pool: pool as any,
      poolConfig: {
        name: 'Kick Pool',
        address: pool.poolAddress,
        price: {
          source: PriceOriginSource.POOL,
          reference: PriceOriginPoolReference.LUP,
        },
        kick: {
          minDebt: 1,
          priceFactor: 0.9,
        },
      } as any,
      config: {
        subgraphUrl: 'http://example-subgraph',
        coinGeckoApiKey: undefined,
        ethRpcUrl: 'http://example-rpc',
        tokenAddresses: {},
      },
      chainId: 1,
    })) {
      loans.push(loan);
    }

    expect(loans).to.have.length(2);
    expect(getPriceStub.callCount).to.equal(2);
  });
});
