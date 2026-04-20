import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, constants, utils } from 'ethers';
import { LpCollector, LP_REWARD_LOOKBACK_SECONDS } from '../rewards/collect-lp';
import { TokenToCollect } from '../config';

function makeFakeBucket(position: {
  lpBalance: BigNumber;
  depositRedeemable?: BigNumber;
  collateralRedeemable?: BigNumber;
  deposit?: BigNumber;
  collateral?: BigNumber;
}) {
  return {
    getStatus: sinon.stub().resolves({
      exchangeRate: BigNumber.from(1),
      deposit: position.deposit ?? constants.Zero,
      collateral: position.collateral ?? constants.Zero,
    }),
    getPosition: sinon.stub().resolves({
      lpBalance: position.lpBalance,
      depositRedeemable: position.depositRedeemable ?? constants.Zero,
      collateralRedeemable: position.collateralRedeemable ?? constants.Zero,
    }),
    lpToQuoteTokens: sinon.stub().resolves(constants.Zero),
    lpToCollateral: sinon.stub().resolves(constants.Zero),
  };
}

function makeCollector(opts: {
  signerAddress: string;
  getBucketTakeLPAwards: sinon.SinonStub;
  bucket?: ReturnType<typeof makeFakeBucket>;
}) {
  const fakePool: any = {
    poolAddress: '0xpool',
    name: 'TEST',
    quoteAddress: '0xquote',
    collateralAddress: '0xcollat',
    collateralSymbol: 'TCOL',
    getBucketByIndex: sinon.stub().returns(opts.bucket ?? makeFakeBucket({ lpBalance: constants.Zero })),
  };
  const fakeSigner: any = {
    getAddress: sinon.stub().resolves(opts.signerAddress),
  };
  const fakeSubgraph: any = {
    getBucketTakeLPAwards: opts.getBucketTakeLPAwards,
  };
  const fakeTracker: any = { addToken: sinon.stub() };

  return new LpCollector(
    fakePool,
    fakeSigner,
    {
      collectLpReward: {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
    },
    { dryRun: false },
    fakeTracker,
    fakeSubgraph
  );
}

describe('LpCollector stale-entry prune', () => {
  afterEach(() => sinon.restore());

  it('deletes bucket entry from lpMap when on-chain lpBalance is zero', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const bucket = makeFakeBucket({ lpBalance: constants.Zero });
    const getAwards = sinon.stub().resolves({ bucketTakes: [], truncated: false });
    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
      bucket,
    });

    collector.lpMap.set(2000, utils.parseUnits('1', 18));
    await collector.collectLpRewards();

    expect(collector.lpMap.has(2000)).to.be.false;
  });
});

describe('LpCollector cursor advancement', () => {
  afterEach(() => sinon.restore());

  it('starts at cursor 0 and advances to max timestamp minus lookback', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub();
    getAwards.onCall(0).resolves({
      bucketTakes: [
        {
          id: 't1',
          index: 2000,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '1.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '100',
        },
        {
          id: 't2',
          index: 2001,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '2.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '300',
        },
      ],
      truncated: false,
    });
    getAwards.onCall(1).resolves({ bucketTakes: [], truncated: false });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();
    expect(getAwards.firstCall.args[2]).to.equal('0');

    await collector.ingestNewAwardsFromSubgraph();
    // Second call queries cursor minus the lookback window (300 - 60 = 240)
    expect(getAwards.secondCall.args[2]).to.equal(
      String(300 - LP_REWARD_LOOKBACK_SECONDS)
    );
  });

  it('does NOT advance cursor when the subgraph result was truncated', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub();
    getAwards.onCall(0).resolves({
      bucketTakes: [
        {
          id: 't1',
          index: 2000,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '1.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '5000',
        },
      ],
      truncated: true,
    });
    getAwards.onCall(1).resolves({ bucketTakes: [], truncated: false });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();
    await collector.ingestNewAwardsFromSubgraph();

    // Both calls used cursor '0' because truncation blocked advancement on the first.
    expect(getAwards.firstCall.args[2]).to.equal('0');
    expect(getAwards.secondCall.args[2]).to.equal('0');
  });

  it('does not double-count events at exactly the lookback cutoff boundary', async () => {
    // Regression test: an event whose blockTimestamp lands exactly on
    // (cursor - lookback) must be retained in seenEventIds across prune so
    // that the next query (using blockTimestamp_gte: cutoff) does not
    // re-ingest it as new.
    const signer = '0xabc0000000000000000000000000000000000000';
    const LOOKBACK = LP_REWARD_LOOKBACK_SECONDS;
    const boundaryEvent = {
      id: 't-boundary',
      index: 7000,
      taker: signer,
      lpAwarded: {
        lpAwardedTaker: '1.0',
        lpAwardedKicker: '0',
        kicker: '0xdef',
      },
      blockTimestamp: String(LOOKBACK), // cursor after = LOOKBACK, cutoff = 0
    };
    const anchorEvent = {
      id: 't-anchor',
      index: 8000,
      taker: signer,
      lpAwarded: {
        lpAwardedTaker: '2.0',
        lpAwardedKicker: '0',
        kicker: '0xdef',
      },
      blockTimestamp: String(LOOKBACK * 2), // cursor advances here; cutoff = LOOKBACK
    };
    const getAwards = sinon.stub();
    getAwards.onCall(0).resolves({
      bucketTakes: [boundaryEvent, anchorEvent],
      truncated: false,
    });
    // Second call: subgraph still returns boundaryEvent (its blockTimestamp
    // equals cutoff, so _gte picks it up). We must NOT re-ingest it.
    getAwards.onCall(1).resolves({
      bucketTakes: [boundaryEvent],
      truncated: false,
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();
    const afterFirst = collector.lpMap.get(7000)!.toString();

    await collector.ingestNewAwardsFromSubgraph();
    const afterSecond = collector.lpMap.get(7000)!.toString();

    expect(afterSecond).to.equal(afterFirst);
  });

  it('dedupes events across the lookback overlap window', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const event = {
      id: 't-shared',
      index: 2000,
      taker: signer,
      lpAwarded: { lpAwardedTaker: '1.5', lpAwardedKicker: '0', kicker: '0xdef' },
      blockTimestamp: '100',
    };
    const getAwards = sinon.stub();
    getAwards.onCall(0).resolves({ bucketTakes: [event], truncated: false });
    getAwards.onCall(1).resolves({ bucketTakes: [event], truncated: false });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();
    const firstAmount = collector.lpMap.get(2000)!.toString();

    await collector.ingestNewAwardsFromSubgraph();
    const secondAmount = collector.lpMap.get(2000)!.toString();

    expect(secondAmount).to.equal(firstAmount);
  });
});

describe('LpCollector parse failure atomicity', () => {
  afterEach(() => sinon.restore());

  it('does NOT half-apply rewards when taker parses but kicker throws', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-malformed',
          index: 5000,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '1.0', // valid
            lpAwardedKicker: 'not-a-number', // throws
            kicker: signer,
          },
          blockTimestamp: '100',
        },
      ],
      truncated: false,
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    let thrown: unknown;
    try {
      await collector.ingestNewAwardsFromSubgraph();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.not.be.undefined;
    // Taker reward must NOT have been added — kicker parse threw before any
    // mutation, so the whole take should be left untouched for retry.
    expect(collector.lpMap.has(5000)).to.be.false;
  });
});

describe('LpCollector role handling', () => {
  afterEach(() => sinon.restore());

  it('sums taker and kicker awards when signer fills both roles on one take', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take1',
          index: 1234,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '2.5',
            kicker: signer,
          },
          blockTimestamp: '100',
        },
      ],
      truncated: false,
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();
    expect(collector.lpMap.get(1234)!.toString()).to.equal(
      utils.parseUnits('3.5', 18).toString()
    );
  });
});
