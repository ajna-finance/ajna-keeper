import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import {
  createTakeAuctionStatusReader,
  normalizeBorrowerKey,
  readCandidateStatusWindow,
  TAKE_STATUS_BATCH_SIZE,
  TakeAuctionStatus,
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
    expect(status.debtToCover).to.equal(undefined);
    expect(
      pool.poolInfoContractUtils.auctionStatus.calledOnceWithExactly(
        pool.poolAddress,
        '0xBorrower'
      )
    ).to.equal(true);
    expect(pool.getLiquidation.called).to.equal(false);
    expect(stats).to.deep.include({ takeStatusReadCount: 1 });
  });

  it('maps debtToCover from named fields and tuple position', async () => {
    const namedPool = {
      name: 'Named Debt Pool',
      poolAddress: '0x4444444444444444444444444444444444444444',
      poolInfoContractUtils: {
        auctionStatus: sinon.stub().resolves({
          collateral_: ethers.utils.parseEther('2'),
          debtToCover_: ethers.utils.parseEther('1.5'),
          price_: ethers.utils.parseEther('3'),
        }),
      },
    };
    const namedStatus = await createTakeAuctionStatusReader().read({
      pool: namedPool as any,
      borrower: '0xBorrower',
    });
    expect(
      namedStatus.debtToCover?.eq(ethers.utils.parseEther('1.5'))
    ).to.equal(true);

    const tupleResult: Record<number, BigNumber> = {
      0: BigNumber.from(123),
      1: ethers.utils.parseEther('2'),
      2: ethers.utils.parseEther('0.75'),
      3: BigNumber.from(1),
      4: ethers.utils.parseEther('3'),
    };
    const tuplePool = {
      name: 'Tuple Debt Pool',
      poolAddress: '0x5555555555555555555555555555555555555555',
      poolInfoContractUtils: {
        auctionStatus: sinon.stub().resolves(tupleResult),
      },
    };
    const tupleStatus = await createTakeAuctionStatusReader().read({
      pool: tuplePool as any,
      borrower: '0xBorrower',
    });
    expect(
      tupleStatus.debtToCover?.eq(ethers.utils.parseEther('0.75'))
    ).to.equal(true);
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
      statuses.get(`0xborrower${TAKE_STATUS_BATCH_SIZE}`)?.auctionPrice.eq(100)
    ).to.equal(true);
    expect(stats).to.deep.include({
      takeStatusBatchReadCount: 2,
      takeStatusBatchBorrowerCount: TAKE_STATUS_BATCH_SIZE + 1,
    });
  });

  it('keeps successful single-read fallback statuses when one borrower fails', async () => {
    const stats = {};
    const borrowers = ['0xBorrowerA', '0xBorrowerB', '0xBorrowerC'];
    const pool = {
      name: 'Partial Fallback Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      contractUtilsMulti: {
        auctionStatus: sinon
          .stub()
          .callsFake((_poolAddress: string, borrower: string) => borrower),
      },
      ethcallProvider: {
        all: sinon.stub().rejects(new Error('batch unavailable')),
      },
      poolInfoContractUtils: {
        auctionStatus: sinon
          .stub()
          .callsFake(async (_poolAddress: string, borrower: string) => {
            if (borrower === '0xBorrowerB') {
              throw new Error('borrower status unavailable');
            }
            return {
              collateral_: BigNumber.from(borrower === '0xBorrowerA' ? 1 : 3),
              price_: BigNumber.from(borrower === '0xBorrowerA' ? 100 : 300),
            };
          }),
      },
    };

    const statuses = await createTakeAuctionStatusReader({ stats }).readMany!({
      pool: pool as any,
      borrowers,
    });

    expect(statuses.size).to.equal(2);
    expect(statuses.get('0xborrowera')?.auctionPrice.eq(100)).to.equal(true);
    expect(statuses.has('0xborrowerb')).to.equal(false);
    expect(statuses.get('0xborrowerc')?.collateral.eq(3)).to.equal(true);
    expect(stats).to.deep.include({
      takeStatusReadCount: 3,
      takeStatusBatchFallbackCount: 1,
    });
  });
});

describe('readCandidateStatusWindow', () => {
  const pool = { name: 'Window Pool' } as any;
  const status = (borrower: string): TakeAuctionStatus => ({
    borrower,
    collateral: BigNumber.from(1),
    auctionPrice: BigNumber.from(2),
  });

  it('serves fully preloaded windows without touching the reader', async () => {
    const readMany = sinon.stub().rejects(new Error('must not be called'));
    const preloadedStatuses = new Map([
      [normalizeBorrowerKey('0xA'), status('0xA')],
      [normalizeBorrowerKey('0xB'), status('0xB')],
    ]);

    const result = await readCandidateStatusWindow({
      pool,
      borrowers: ['0xA', '0xB'],
      preloadedStatuses,
      reader: { read: sinon.stub(), readMany } as any,
    });

    expect(result?.size).to.equal(2);
    expect(readMany.called).to.equal(false);
  });

  it('batch-reads only the missing borrowers and merges results', async () => {
    const readMany = sinon.stub().resolves(
      new Map([
        [normalizeBorrowerKey('0xB'), status('0xB')],
        [normalizeBorrowerKey('0xC'), status('0xC')],
      ])
    );
    const preloadedStatuses = new Map([
      [normalizeBorrowerKey('0xA'), status('0xA')],
    ]);

    const result = await readCandidateStatusWindow({
      pool,
      borrowers: ['0xA', '0xB', '0xC'],
      preloadedStatuses,
      reader: { read: sinon.stub(), readMany } as any,
    });

    expect(readMany.calledOnce).to.equal(true);
    expect(readMany.firstCall.args[0].borrowers).to.deep.equal(['0xB', '0xC']);
    expect(result?.size).to.equal(3);
  });

  it('leaves a single missing borrower to per-candidate reads', async () => {
    const readMany = sinon.stub().rejects(new Error('must not be called'));
    const preloadedStatuses = new Map([
      [normalizeBorrowerKey('0xA'), status('0xA')],
    ]);

    const result = await readCandidateStatusWindow({
      pool,
      borrowers: ['0xA', '0xB'],
      preloadedStatuses,
      reader: { read: sinon.stub(), readMany } as any,
    });

    expect(readMany.called).to.equal(false);
    expect(result?.size).to.equal(1);
  });

  it('keeps preloaded statuses when the batch read fails', async () => {
    const readMany = sinon.stub().rejects(new Error('batch unavailable'));
    const preloadedStatuses = new Map([
      [normalizeBorrowerKey('0xA'), status('0xA')],
    ]);

    const result = await readCandidateStatusWindow({
      pool,
      borrowers: ['0xA', '0xB', '0xC'],
      preloadedStatuses,
      reader: { read: sinon.stub(), readMany } as any,
    });

    expect(result?.size).to.equal(1);
  });

  it('returns undefined when no status can be resolved', async () => {
    const result = await readCandidateStatusWindow({
      pool,
      borrowers: ['0xA'],
      preloadedStatuses: new Map(),
      reader: undefined,
    });

    expect(result).to.equal(undefined);
  });
});
