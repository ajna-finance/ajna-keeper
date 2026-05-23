import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { getLoansToKick, handleKicks } from '../../src/kick';
import * as priceModule from '../../src/pricing';
import subgraph from '../../src/subgraph';
import { PriceOriginPoolReference, PriceOriginSource } from '../../src/config';

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

  it('does not clear quote allowance in dry-run mode', async () => {
    const getLoans = sinon.stub().resolves({ loans: [] });
    const pool = {
      name: 'Kick Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      getLoans: sinon.stub().resolves(new Map()),
    };
    const signer = {
      getAddress: sinon
        .stub()
        .rejects(new Error('dry-run must not inspect allowance')),
    };

    await handleKicks({
      pool: pool as any,
      signer: signer as any,
      poolConfig: {
        name: 'Kick Pool',
        address: pool.poolAddress,
        price: {
          source: PriceOriginSource.POOL,
          reference: PriceOriginPoolReference.LUP,
        },
        kick: {
          enabled: true,
          minDebt: 1,
          priceFactor: 0.9,
        },
      } as any,
      config: {
        dryRun: true,
        subgraph: {
          cacheKey: 'unit-test',
          getLoans,
        } as any,
      },
      chainId: 1,
    });

    expect(getLoans.calledOnceWith(pool.poolAddress)).to.be.true;
    expect(pool.getLoans.calledOnce).to.be.true;
    expect(signer.getAddress.called).to.be.false;
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
          enabled: true,
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

  it('reuses pool prices across skipped borrowers in one kick pass', async () => {
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
      getLoan: sinon
        .stub()
        .onFirstCall()
        .resolves({
          ...buildLoanDetails(),
          thresholdPrice: ethers.utils.parseEther('0.5'),
        })
        .onSecondCall()
        .resolves(buildLoanDetails()),
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
          enabled: true,
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

    expect(loans).to.have.length(1);
    expect(pool.getPrices.calledOnce).to.be.true;
    expect(getPriceStub.calledOnce).to.be.true;
  });

  it('invalidates cached pool prices after each yielded kick candidate', async () => {
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
          enabled: true,
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
    expect(pool.getPrices.callCount).to.equal(2);
    expect(getPriceStub.callCount).to.equal(2);
  });
});
