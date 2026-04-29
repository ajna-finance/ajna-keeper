import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import {
  createTakeAuctionStatusReader,
  TAKE_STATUS_BATCH_SIZE,
} from '../../src/take/liquidation-status';

describe('take auction status reader', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('maps direct auctionStatus fields without calling the SDK liquidation status helper', async () => {
    const stats = {};
    const pool = {
      name: 'Status Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      poolInfoContractUtils: {
        auctionStatus: sinon.stub().resolves({
          collateral_: ethers.utils.parseEther('2'),
          price_: ethers.utils.parseEther('3'),
        }),
      },
      getLiquidation: sinon.stub().throws(new Error('unused SDK status path')),
    };

    const status = await createTakeAuctionStatusReader({ stats }).read({
      pool: pool as any,
      borrower: '0xBorrower',
    });

    expect(status.borrower).to.equal('0xBorrower');
    expect(status.collateral.eq(ethers.utils.parseEther('2'))).to.equal(true);
    expect(status.auctionPrice.eq(ethers.utils.parseEther('3'))).to.equal(true);
    expect(pool.poolInfoContractUtils.auctionStatus.calledOnceWithExactly(
      pool.poolAddress,
      '0xBorrower'
    )).to.equal(true);
    expect(pool.getLiquidation.called).to.equal(false);
    expect(stats).to.deep.include({ takeStatusReadCount: 1 });
  });

  it('batch reads preserve borrower mapping across chunks', async () => {
    const stats = {};
    const borrowers = Array.from(
      { length: TAKE_STATUS_BATCH_SIZE + 1 },
      (_, index) => `0xBorrower${index}`
    );
    const pool = {
      name: 'Batch Pool',
      poolAddress: '0x2222222222222222222222222222222222222222',
      contractUtilsMulti: {
        auctionStatus: sinon
          .stub()
          .callsFake((_poolAddress: string, borrower: string) => borrower),
      },
      ethcallProvider: {
        all: sinon.stub().callsFake(async (calls: string[]) =>
          calls.map((borrower, index) => ({
            collateral_: BigNumber.from(index + 1),
            price_: BigNumber.from(index + 100),
          }))
        ),
      },
    };

    const statuses = await createTakeAuctionStatusReader({ stats }).readMany!({
      pool: pool as any,
      borrowers,
    });

    expect(pool.ethcallProvider.all.callCount).to.equal(2);
    expect(statuses.get('0xborrower0')?.collateral.eq(1)).to.equal(true);
    expect(
      statuses
        .get(`0xborrower${TAKE_STATUS_BATCH_SIZE}`)
        ?.auctionPrice.eq(100)
    ).to.equal(true);
    expect(stats).to.deep.include({
      takeStatusBatchReadCount: 2,
      takeStatusBatchBorrowerCount: TAKE_STATUS_BATCH_SIZE + 1,
    });
  });
});
