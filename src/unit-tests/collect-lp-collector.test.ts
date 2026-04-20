import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, constants, utils } from 'ethers';
import {
  LpIngester,
  LpRedeemer,
  LP_REWARD_LOOKBACK_SECONDS_DEFAULT,
} from '../rewards/collect-lp';
import { TokenToCollect } from '../config';

const FAKE_POOL_ADDRESS = '0xpool';

function makeFakeBucket(position: {
  lpBalance: BigNumber;
  depositRedeemable?: BigNumber;
  collateralRedeemable?: BigNumber;
  deposit?: BigNumber;
  collateral?: BigNumber;
}) {
  return {
    getStatus: sinon.stub().resolves({
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

/**
 * Test facade: wires an LpIngester + LpRedeemer for a single fake pool and
 * exposes the legacy `collectLpRewards` / `ingestNewAwardsFromSubgraph` /
 * `lpMap` surface the existing tests rely on. Each event's `pool.id` is
 * auto-injected if missing so test fixtures stay terse.
 */
function makeCollector(opts: {
  signerAddress: string;
  getBucketTakeLPAwards: sinon.SinonStub;
  bucket?: ReturnType<typeof makeFakeBucket>;
}) {
  const fakePool: any = {
    poolAddress: FAKE_POOL_ADDRESS,
    name: 'TEST',
    quoteAddress: '0xquote',
    collateralAddress: '0xcollat',
    collateralSymbol: 'TCOL',
    getBucketByIndex: sinon.stub().returns(opts.bucket ?? makeFakeBucket({ lpBalance: constants.Zero })),
  };
  const fakeSigner: any = {
    getAddress: sinon.stub().resolves(opts.signerAddress),
  };
  // Wrap the caller-supplied stub so events without `pool` get a synthetic
  // `pool.id = FAKE_POOL_ADDRESS` — keeps existing fixtures working.
  const wrappedGetAwards = async (...args: any[]) => {
    const result = await opts.getBucketTakeLPAwards(...args);
    if (result && Array.isArray(result.bucketTakes)) {
      return {
        ...result,
        bucketTakes: result.bucketTakes.map((t: any) =>
          t && !t.pool ? { ...t, pool: { id: FAKE_POOL_ADDRESS } } : t
        ),
      };
    }
    return result;
  };
  const fakeSubgraph: any = { getBucketTakeLPAwards: wrappedGetAwards };
  const fakeTracker: any = { addToken: sinon.stub() };

  const ingester = new LpIngester(fakeSigner, fakeSubgraph, {});
  const redeemer = new LpRedeemer(
    fakePool,
    fakeSigner,
    {
      redeemFirst: TokenToCollect.QUOTE,
      minAmountQuote: 0,
      minAmountCollateral: 0,
    },
    { dryRun: false },
    fakeTracker
  );

  return {
    get lpMap() {
      return redeemer.lpMap;
    },
    pool: fakePool,
    ingester,
    redeemer,
    async ingestNewAwardsFromSubgraph() {
      const byPool = await ingester.ingest();
      for (const reward of byPool.get(FAKE_POOL_ADDRESS) ?? []) {
        redeemer.creditReward(reward);
      }
    },
    async collectLpRewards() {
      const byPool = await ingester.ingest();
      for (const reward of byPool.get(FAKE_POOL_ADDRESS) ?? []) {
        redeemer.creditReward(reward);
      }
      await redeemer.sweep();
    },
  };
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
    expect(getAwards.firstCall.args[1]).to.equal('0');

    await collector.ingestNewAwardsFromSubgraph();
    // Second call queries cursor minus the lookback window (300 - 60 = 240)
    expect(getAwards.secondCall.args[1]).to.equal(
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
    expect(getAwards.firstCall.args[1]).to.equal('0');
    expect(getAwards.secondCall.args[1]).to.equal(String(5000 - 60));
  });

  it('does not double-count events at exactly the lookback cutoff boundary', async () => {
    // Regression test: an event whose blockTimestamp lands exactly on
    // (cursor - lookback) must be retained in seenEventIds across prune.
    // Production's query is a composite OR: `blockTimestamp_gt: cursorTs`
    // OR `(blockTimestamp == cursorTs AND id_gt: '0x')`. The boundary event
    // at ts == cutoff IS returned by the SECOND branch (since every real
    // Bytes id sorts strictly above the canonical empty sentinel `'0x'`),
    // so dedupe — not query-side filtering — is what prevents the double
    // count when that event re-surfaces in the next cycle.
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
      index: 7001,
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
    expect(getAwards.secondCall.args[1]).to.equal(String(300 - 60));
  });

  it('emits aggregate WARN when quarantine count crosses alarm threshold', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const bucketTakes = Array.from({ length: 5 }, (_, i) => ({
      id: `take-malformed-${i}`,
      index: 5000 + i,
      taker: signer,
      lpAwarded: {
        lpAwardedTaker: 'garbage', // parse throws
        lpAwardedKicker: '0',
        kicker: '0xdef',
      },
      blockTimestamp: String(100 + i),
    }));
    const getAwards = sinon.stub().resolves({ bucketTakes });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });
    const loggerModule = require('../logging');
    const warnStub = sinon.stub(loggerModule.logger, 'warn');

    await collector.ingestNewAwardsFromSubgraph();

    // All 5 events quarantined → threshold of 5 → one aggregate WARN.
    expect(
      warnStub.getCalls().some((call) =>
        String(call.args[0]).includes('Quarantined 5 BucketTake event(s)')
      )
    ).to.equal(true);
    expect(collector.lpMap.size).to.equal(0);
  });
});

describe('LpCollector null-field defense', () => {
  afterEach(() => sinon.restore());

  it('credits taker even when lpAwarded.kicker is null (best-effort non-fatal)', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-null-kicker-taker-is-signer',
          index: 7000,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            // Schema-drift simulation — guard must not drop the taker reward.
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

    // Would throw on .toLowerCase() of null before the null-safe fix.
    await collector.ingestNewAwardsFromSubgraph();

    expect(collector.lpMap.get(7000)!.toString()).to.equal(
      utils.parseUnits('1.0', 18).toString()
    );
    expect(collector.lpMap.get(7001)!.toString()).to.equal(
      utils.parseUnits('2.0', 18).toString()
    );
  });

  it('skips events with null kicker when signer is neither taker nor kicker', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-null-kicker-unrelated',
          index: 7000,
          taker: '0xstranger',
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '5.0',
            kicker: null as any,
          },
          blockTimestamp: '600',
        },
      ],
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();

    // Null kicker + unrelated taker = no role match for signer; lpMap empty.
    expect(collector.lpMap.size).to.equal(0);
  });

  it('skips events with out-of-range bucket index', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-bad-index-negative',
          index: -1,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '1.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '900',
        },
        {
          id: 'take-bad-index-too-big',
          index: 999_999,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '1.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '901',
        },
        {
          id: 'take-ok-index-0',
          index: 0,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '1.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '902',
        },
        {
          id: 'take-ok-index-max',
          index: 7388,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '2.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: '903',
        },
      ],
    });

    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: getAwards,
    });

    await collector.ingestNewAwardsFromSubgraph();

    expect(collector.lpMap.has(-1)).to.be.false;
    expect(collector.lpMap.has(999_999)).to.be.false;
    expect(collector.lpMap.get(0)!.toString()).to.equal(
      utils.parseUnits('1.0', 18).toString()
    );
    expect(collector.lpMap.get(7388)!.toString()).to.equal(
      utils.parseUnits('2.0', 18).toString()
    );
  });

  it('skips events with unparseable blockTimestamp without pinning the seen set', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const getAwards = sinon.stub().resolves({
      bucketTakes: [
        {
          id: 'take-bad-ts',
          index: 5000,
          taker: signer,
          lpAwarded: { lpAwardedTaker: '1.0', lpAwardedKicker: '0', kicker: '0xdef' },
          blockTimestamp: 'not-a-number',
        },
        {
          id: 'take-ok',
          index: 5001,
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
    expect(collector.lpMap.has(5000)).to.be.false;
    expect(collector.lpMap.get(5001)!.toString()).to.equal(
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
