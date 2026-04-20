import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, constants } from 'ethers';
import {
  LpIngester,
  LpManager,
  LpRedeemer,
  LpRedeemerResolver,
} from '../rewards/collect-lp';
import { TokenToCollect } from '../config';

const POOL_A = '0xaaa0000000000000000000000000000000000001';
const POOL_B = '0xbbb0000000000000000000000000000000000002';

function makeFakeBucket() {
  return {
    getStatus: sinon.stub().resolves({
      deposit: constants.Zero,
      collateral: constants.Zero,
    }),
    getPosition: sinon.stub().resolves({
      lpBalance: constants.Zero,
      depositRedeemable: constants.Zero,
      collateralRedeemable: constants.Zero,
    }),
    lpToQuoteTokens: sinon.stub().resolves(constants.Zero),
    lpToCollateral: sinon.stub().resolves(constants.Zero),
  };
}

function makeFakePool(poolAddress: string, name: string) {
  return {
    poolAddress,
    name,
    quoteAddress: '0xquote',
    collateralAddress: '0xcollat',
    collateralSymbol: 'TCOL',
    getBucketByIndex: sinon.stub().returns(makeFakeBucket()),
  } as any;
}

function makeFakeSigner(address: string) {
  return { getAddress: sinon.stub().resolves(address) } as any;
}

describe('LpManager chain-wide dispatch', () => {
  afterEach(() => sinon.restore());

  it('dispatches events to the correct per-pool redeemer', async () => {
    const signer = '0xdef0000000000000000000000000000000000999';
    const fakeSigner = makeFakeSigner(signer);
    const fakeTracker: any = { addToken: sinon.stub() };

    // Events for TWO distinct pools in a single chain-wide subgraph response.
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-A-1',
          index: 1000,
          taker: signer,
          pool: { id: POOL_A },
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xkickerA',
          },
          blockTimestamp: '100',
        },
        {
          id: 'take-B-1',
          index: 2000,
          taker: signer,
          pool: { id: POOL_B },
          lpAwarded: {
            lpAwardedTaker: '2.5',
            lpAwardedKicker: '0',
            kicker: '0xkickerB',
          },
          blockTimestamp: '200',
        },
      ],
    });

    const ingester = new LpIngester(
      fakeSigner,
      { getBucketTakeLPAwards: getAwards } as any,
      {}
    );

    const redeemerA = new LpRedeemer(
      makeFakePool(POOL_A, 'POOL-A'),
      fakeSigner,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
      { dryRun: false },
      fakeTracker
    );
    const redeemerB = new LpRedeemer(
      makeFakePool(POOL_B, 'POOL-B'),
      fakeSigner,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
      { dryRun: false },
      fakeTracker
    );

    const resolver: LpRedeemerResolver = async (addr) => {
      if (addr === POOL_A) return redeemerA;
      if (addr === POOL_B) return redeemerB;
      return undefined;
    };

    const manager = new LpManager(ingester, resolver);
    const touched = await manager.ingestAndDispatch();

    expect(touched).to.have.length(2);
    // Each redeemer got only its own pool's reward.
    expect(redeemerA.lpMap.get(1000)!.toString()).to.equal(
      BigNumber.from('1000000000000000000').toString()
    );
    expect(redeemerA.lpMap.has(2000)).to.be.false;
    expect(redeemerB.lpMap.get(2000)!.toString()).to.equal(
      BigNumber.from('2500000000000000000').toString()
    );
    expect(redeemerB.lpMap.has(1000)).to.be.false;
  });

  it('skips pools the resolver cannot hydrate (returns undefined)', async () => {
    const signer = '0xdef0000000000000000000000000000000000999';
    const fakeSigner = makeFakeSigner(signer);
    const fakeTracker: any = { addToken: sinon.stub() };

    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-erc721-1',
          index: 1000,
          taker: signer,
          pool: { id: POOL_A }, // pretend this is ERC721 → resolver fails
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xk',
          },
          blockTimestamp: '100',
        },
        {
          id: 'take-ok-1',
          index: 2000,
          taker: signer,
          pool: { id: POOL_B },
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xk',
          },
          blockTimestamp: '200',
        },
      ],
    });

    const ingester = new LpIngester(
      fakeSigner,
      { getBucketTakeLPAwards: getAwards } as any,
      {}
    );

    const redeemerB = new LpRedeemer(
      makeFakePool(POOL_B, 'POOL-B'),
      fakeSigner,
      {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
      { dryRun: false },
      fakeTracker
    );

    const resolver: LpRedeemerResolver = async (addr) => {
      if (addr === POOL_B) return redeemerB;
      return undefined; // POOL_A not hydratable
    };

    const manager = new LpManager(ingester, resolver);
    const touched = await manager.ingestAndDispatch();

    // Only POOL_B redeemer was returned. POOL_A's event was silently skipped
    // (event is already in seenEventIds so it won't be retried this process).
    expect(touched).to.have.length(1);
    expect(touched[0]).to.equal(redeemerB);
    expect(redeemerB.lpMap.get(2000)!.toString()).to.equal(
      BigNumber.from('1000000000000000000').toString()
    );
  });

  it('memoizes redeemer construction: same pool resolves to the same instance', async () => {
    const signer = '0xdef0000000000000000000000000000000000999';
    const fakeSigner = makeFakeSigner(signer);
    const fakeTracker: any = { addToken: sinon.stub() };

    const getAwards = sinon.stub();
    getAwards.onCall(0).resolves({
      bucketTakes: [
        {
          id: 'take-1',
          index: 1000,
          taker: signer,
          pool: { id: POOL_A },
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xk',
          },
          blockTimestamp: '100',
        },
      ],
    });
    getAwards.onCall(1).resolves({
      bucketTakes: [
        {
          id: 'take-2',
          index: 1001,
          taker: signer,
          pool: { id: POOL_A },
          lpAwarded: {
            lpAwardedTaker: '2.0',
            lpAwardedKicker: '0',
            kicker: '0xk',
          },
          blockTimestamp: '200',
        },
      ],
    });

    const ingester = new LpIngester(
      fakeSigner,
      { getBucketTakeLPAwards: getAwards } as any,
      {}
    );

    // Simulate a caller-side cache so the resolver returns the same
    // redeemer instance across cycles for the same pool.
    const cache = new Map<string, LpRedeemer>();
    const resolver: LpRedeemerResolver = async (addr) => {
      const cached = cache.get(addr);
      if (cached) return cached;
      const r = new LpRedeemer(
        makeFakePool(addr, 'P'),
        fakeSigner,
        {
          redeemFirst: TokenToCollect.QUOTE,
          minAmountQuote: 0,
          minAmountCollateral: 0,
        },
        { dryRun: false },
        fakeTracker
      );
      cache.set(addr, r);
      return r;
    };

    const manager = new LpManager(ingester, resolver);
    const firstTouched = await manager.ingestAndDispatch();
    const secondTouched = await manager.ingestAndDispatch();

    expect(firstTouched[0]).to.equal(secondTouched[0]);
    expect(firstTouched[0].lpMap.size).to.equal(2);
  });
});
