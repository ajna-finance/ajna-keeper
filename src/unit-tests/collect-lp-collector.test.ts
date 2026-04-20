import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, constants, utils } from 'ethers';
import { LpCollector, LP_REWARD_LOOKBACK_SECONDS_DEFAULT } from '../rewards/collect-lp';
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
    const getAwards = sinon.stub().resolves({ bucketTakes: [] });
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
    });
    getAwards.onCall(1).resolves({ bucketTakes: [] });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();
    expect(getAwards.firstCall.args[2]).to.equal('0');

    await collector.ingestNewAwardsFromSubgraph();
    // Second call queries cursor minus the lookback window (300 - 60 = 240)
    expect(getAwards.secondCall.args[2]).to.equal(
      String(300 - LP_REWARD_LOOKBACK_SECONDS_DEFAULT)
    );
  });

  it('advances cursor to the max observed timestamp across cycles', async () => {
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
    });
    getAwards.onCall(1).resolves({ bucketTakes: [] });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();
    await collector.ingestNewAwardsFromSubgraph();

    // Cycle 1 queries from '0' and observes an event at ts=5000.
    // Cycle 2 queries from `(cursorTs - lookback) = 5000 - 60 = 4940`,
    // confirming the cursor advanced to the max observed ts.
    expect(getAwards.firstCall.args[2]).to.equal('0');
    expect(getAwards.secondCall.args[2]).to.equal(String(5000 - 60));
  });

  it('does not double-count events at exactly the lookback cutoff boundary', async () => {
    // Regression test: an event whose blockTimestamp lands exactly on
    // (cursor - lookback) must be retained in seenEventIds across prune.
    // The production query uses `blockTimestamp_gt: cursorTs - lookback`,
    // which RE-INCLUDES any event strictly greater than the cutoff — i.e.
    // the event at the boundary itself is still returned by the next
    // query, so dedupe (not query-side filtering) is what prevents the
    // double count.
    const signer = '0xabc0000000000000000000000000000000000000';
    const LOOKBACK = LP_REWARD_LOOKBACK_SECONDS_DEFAULT;
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
    });
    // Second call: subgraph still returns boundaryEvent (its blockTimestamp
    // equals cutoff, so _gte picks it up). We must NOT re-ingest it.
    getAwards.onCall(1).resolves({
      bucketTakes: [boundaryEvent],
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
    getAwards.onCall(0).resolves({ bucketTakes: [event] });
    getAwards.onCall(1).resolves({ bucketTakes: [event] });

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

describe('LpCollector parse failure quarantine', () => {
  afterEach(() => sinon.restore());

  it('does not half-apply and does not halt when a reward amount fails to parse', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-malformed',
          index: 5000,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '1.0', // valid
            lpAwardedKicker: 'not-a-number', // parse throws
            kicker: signer,
          },
          blockTimestamp: '100',
        },
        {
          id: 'take-valid',
          index: 5001,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '2.5', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '200',
        },
      ],
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    // No throw — quarantine logs + skips the bad event, continues.
    await collector.ingestNewAwardsFromSubgraph();

    // Malformed take is skipped entirely (no partial taker reward applied)
    expect(collector.lpMap.has(5000)).to.be.false;
    // Subsequent valid take is processed normally
    expect(collector.lpMap.get(5001)!.toString()).to.equal(
      utils.parseUnits('2.5', 18).toString()
    );
  });

  it('advances cursor past a quarantined event so it does not freeze the pool', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub();
    getAwards.onCall(0).resolves({
      bucketTakes: [
        {
          id: 'take-malformed',
          index: 5000,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: 'garbage',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
          blockTimestamp: '300',
        },
      ],
    });
    getAwards.onCall(1).resolves({ bucketTakes: [] });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();
    await collector.ingestNewAwardsFromSubgraph();

    // Second call's timestamp cursor must have advanced past the quarantined
    // event's block (300 - 60 lookback = 240). This proves the pool is not
    // frozen on the bad record.
    expect(getAwards.secondCall.args[2]).to.equal(String(300 - 60));
  });
});

describe('LpCollector null-field defense', () => {
  afterEach(() => sinon.restore());

  it('skips events with missing lpAwarded.kicker without throwing', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-null-kicker',
          index: 7000,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: null as any,
          },
          blockTimestamp: '600',
        },
        {
          id: 'take-ok',
          index: 7001,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '2.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '700',
        },
      ],
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    // Would throw on .toLowerCase() of null before the fix — must not throw now
    await collector.ingestNewAwardsFromSubgraph();

    expect(collector.lpMap.has(7000)).to.be.false;
    expect(collector.lpMap.get(7001)!.toString()).to.equal(
      utils.parseUnits('2.0', 18).toString()
    );
  });

  it('skips events with unparseable blockTimestamp without pinning the seen set', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-bad-ts',
          index: 8000,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '1.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: 'not-a-number',
        },
        {
          id: 'take-ok',
          index: 8001,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '2.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '800',
        },
      ],
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();

    // The malformed-ts event is skipped entirely (not seen, not credited).
    // Without this guard the entry would land in `seenEventIds` with a junk
    // ts that neither prune nor cap can evict.
    expect(collector.lpMap.has(8000)).to.be.false;
    expect(collector.lpMap.get(8001)!.toString()).to.equal(
      utils.parseUnits('2.0', 18).toString()
    );
  });

  it('skips events with missing lpAwarded without throwing', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-null',
          index: 6000,
          taker: signer,
          lpAwarded: null as any,
          blockTimestamp: '400',
        },
        {
          id: 'take-ok',
          index: 6001,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '3.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '500',
        },
      ],
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();

    expect(collector.lpMap.has(6000)).to.be.false;
    expect(collector.lpMap.get(6001)!.toString()).to.equal(
      utils.parseUnits('3.0', 18).toString()
    );
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
