import { expect } from 'chai';
import sinon from 'sinon';
import { utils } from 'ethers';
import { makeCollector } from './helpers/lp-collector-fixture';

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
          lpAwarded: {
            lpAwardedTaker: '2.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
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
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
          blockTimestamp: '900',
        },
        {
          id: 'take-bad-index-too-big',
          index: 999_999,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
          blockTimestamp: '901',
        },
        {
          id: 'take-ok-index-0',
          index: 0,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
          blockTimestamp: '902',
        },
        {
          id: 'take-ok-index-max',
          index: 7388,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '2.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
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
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
          blockTimestamp: 'not-a-number',
        },
        {
          id: 'take-ok',
          index: 5001,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '2.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
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
          lpAwarded: {
            lpAwardedTaker: '3.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
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
