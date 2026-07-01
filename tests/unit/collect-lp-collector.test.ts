import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, constants, utils } from 'ethers';
import { LP_REWARD_LOOKBACK_SECONDS_DEFAULT } from '../../src/rewards/collect-lp';
import { RewardActionLabel, TokenToCollect } from '../../src/config';
import * as transactions from '../../src/transactions';
import {
  makeBucketPosition,
  makeCollector,
  makeFakeBucket,
  setBucketPositionSequence,
} from './helpers/lp-collector-fixture';

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

  it('deletes stale bucket entry when Ajna rejects LP redemption with stale-claim errors', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const rewardLp = utils.parseUnits('1', 18);
    const staleErrorMarkers = [
      'InvalidAmount',
      'BucketBankruptcy',
      'NoClaim',
      'LPAmountTooLow',
    ];
    const removeQuoteStub = sinon.stub(transactions, 'bucketRemoveQuoteToken');
    staleErrorMarkers.forEach((marker, index) => {
      removeQuoteStub
        .onCall(index)
        .rejects(new Error(`execution reverted: ${marker}`));
    });

    for (let i = 0; i < staleErrorMarkers.length; i++) {
      const bucketIndex = 2000 + i;
      const bucket = makeFakeBucket({
        lpBalance: rewardLp,
        deposit: rewardLp,
        depositRedeemable: rewardLp,
      });
      const collector = makeCollector({
        signerAddress: signer,
        getBucketTakeLPAwards: sinon.stub().resolves({ bucketTakes: [] }),
        bucket,
      });

      collector.lpMap.set(bucketIndex, rewardLp);
      await collector.collectLpRewards();

      expect(collector.lpMap.has(bucketIndex)).to.be.false;
    }
  });
});

describe('LpCollector principal preservation (defect #9)', () => {
  afterEach(() => sinon.restore());

  it('redeems only the reward-equivalent, not the full redeemable position, when the signer also holds principal LP', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const rewardLp = utils.parseUnits('1', 18);
    // The signer's redeemable position is 5x the tracked reward (reward +
    // principal it lent from the same wallet) — the over-redeem scenario the
    // 1:1 fixtures elsewhere cannot distinguish.
    const principal = utils.parseUnits('5', 18);
    const bucket = makeFakeBucket({
      lpBalance: principal,
      deposit: principal,
      depositRedeemable: principal,
    });
    const removeQuoteStub = sinon
      .stub(transactions, 'bucketRemoveQuoteToken')
      .resolves();
    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: sinon.stub().resolves({ bucketTakes: [] }),
      bucket,
    });

    collector.lpMap.set(3000, rewardLp);
    await collector.collectLpRewards();

    // Money-safety: the quote leg must withdraw at most the reward's quote-
    // equivalent (lpToQuoteTokens(rewardLp) == rewardLp under the 1:1 mock), NOT
    // the signer's full redeemable deposit. Pre-fix code withdrew
    // min(depositRedeemable, deposit) == principal (5x), burning principal — so
    // this assertion fails against the unfixed code.
    expect(removeQuoteStub.calledOnce).to.equal(true);
    const withdrawn = removeQuoteStub.firstCall.args[2] as BigNumber;
    expect(withdrawn.toString()).to.equal(rewardLp.toString());
  });
});

describe('LpCollector collateral redemption legs', () => {
  afterEach(() => sinon.restore());

  it('redeems only the reward-equivalent collateral, not the full redeemable position', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const rewardLp = utils.parseUnits('1', 18);
    const principal = utils.parseUnits('5', 18);
    const bucket = makeFakeBucket({
      lpBalance: principal,
      collateral: principal,
      collateralRedeemable: principal,
    });
    setBucketPositionSequence(bucket, [
      { lpBalance: principal, collateralRedeemable: principal },
      { lpBalance: principal, collateralRedeemable: principal },
      {
        lpBalance: principal.sub(rewardLp),
        collateralRedeemable: principal.sub(rewardLp),
      },
      {
        lpBalance: principal.sub(rewardLp),
        collateralRedeemable: principal.sub(rewardLp),
      },
    ]);
    const removeCollateralStub = sinon
      .stub(transactions, 'bucketRemoveCollateralToken')
      .resolves();
    const exchangeTracker = { addToken: sinon.stub() };
    const collateralRewardAction = {
      action: RewardActionLabel.TRANSFER,
      to: signer,
    } as const;
    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: sinon.stub().resolves({ bucketTakes: [] }),
      bucket,
      exchangeTracker,
      settings: {
        redeemFirst: TokenToCollect.COLLATERAL,
        minAmountQuote: 0,
        minAmountCollateral: 0,
        rewardActionCollateral: collateralRewardAction,
      },
    });

    collector.lpMap.set(3100, rewardLp);
    await collector.collectLpRewards();

    expect(removeCollateralStub.calledOnce).to.equal(true);
    const withdrawn = removeCollateralStub.firstCall.args[2] as BigNumber;
    expect(withdrawn.toString()).to.equal(rewardLp.toString());
    expect(exchangeTracker.addToken.calledOnce).to.equal(true);
    expect(exchangeTracker.addToken.firstCall.args[0]).to.equal(
      collateralRewardAction
    );
    expect(exchangeTracker.addToken.firstCall.args[1]).to.equal('0xcollat');
    expect(exchangeTracker.addToken.firstCall.args[2].toString()).to.equal(
      rewardLp.toString()
    );
  });

  it('falls back from quote to collateral for the remaining reward LP only', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const rewardLp = utils.parseUnits('2', 18);
    const oneLp = utils.parseUnits('1', 18);
    const principal = utils.parseUnits('5', 18);
    const bucket = makeFakeBucket({
      lpBalance: rewardLp,
      deposit: oneLp,
      depositRedeemable: oneLp,
      collateral: principal,
      collateralRedeemable: principal,
    });
    setBucketPositionSequence(bucket, [
      {
        lpBalance: rewardLp,
        depositRedeemable: oneLp,
        collateralRedeemable: principal,
      },
      {
        lpBalance: rewardLp,
        depositRedeemable: oneLp,
        collateralRedeemable: principal,
      },
      {
        lpBalance: rewardLp.sub(oneLp),
        depositRedeemable: constants.Zero,
        collateralRedeemable: principal,
      },
      {
        lpBalance: rewardLp.sub(oneLp),
        depositRedeemable: constants.Zero,
        collateralRedeemable: principal,
      },
      {
        lpBalance: rewardLp.sub(oneLp),
        depositRedeemable: constants.Zero,
        collateralRedeemable: principal,
      },
      {
        lpBalance: constants.Zero,
        depositRedeemable: constants.Zero,
        collateralRedeemable: principal.sub(oneLp),
      },
    ]);
    const removeQuoteStub = sinon
      .stub(transactions, 'bucketRemoveQuoteToken')
      .resolves();
    const removeCollateralStub = sinon
      .stub(transactions, 'bucketRemoveCollateralToken')
      .resolves();
    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: sinon.stub().resolves({ bucketTakes: [] }),
      bucket,
    });

    collector.lpMap.set(3200, rewardLp);
    await collector.collectLpRewards();

    expect(removeQuoteStub.calledOnce).to.equal(true);
    const quoteCall = removeQuoteStub.getCall(0)!;
    const quoteWithdrawn = quoteCall.args[2] as BigNumber;
    expect(quoteWithdrawn.toString()).to.equal(oneLp.toString());
    expect(removeCollateralStub.calledOnce).to.equal(true);
    const collateralCall = removeCollateralStub.getCall(0)!;
    const collateralWithdrawn = collateralCall.args[2] as BigNumber;
    expect(collateralWithdrawn.toString()).to.equal(oneLp.toString());
    expect(collector.lpMap.has(3200)).to.equal(false);
  });

  it('falls back from collateral to quote for the remaining reward LP only', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const rewardLp = utils.parseUnits('2', 18);
    const oneLp = utils.parseUnits('1', 18);
    const principal = utils.parseUnits('5', 18);
    const bucket = makeFakeBucket({
      lpBalance: rewardLp,
      deposit: principal,
      depositRedeemable: principal,
      collateral: oneLp,
      collateralRedeemable: oneLp,
    });
    setBucketPositionSequence(bucket, [
      {
        lpBalance: rewardLp,
        depositRedeemable: principal,
        collateralRedeemable: oneLp,
      },
      {
        lpBalance: rewardLp,
        depositRedeemable: principal,
        collateralRedeemable: oneLp,
      },
      {
        lpBalance: rewardLp.sub(oneLp),
        depositRedeemable: principal,
        collateralRedeemable: constants.Zero,
      },
      {
        lpBalance: rewardLp.sub(oneLp),
        depositRedeemable: principal,
        collateralRedeemable: constants.Zero,
      },
      {
        lpBalance: rewardLp.sub(oneLp),
        depositRedeemable: principal,
        collateralRedeemable: constants.Zero,
      },
      {
        lpBalance: constants.Zero,
        depositRedeemable: principal.sub(oneLp),
        collateralRedeemable: constants.Zero,
      },
    ]);
    const removeQuoteStub = sinon
      .stub(transactions, 'bucketRemoveQuoteToken')
      .resolves();
    const removeCollateralStub = sinon
      .stub(transactions, 'bucketRemoveCollateralToken')
      .resolves();
    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: sinon.stub().resolves({ bucketTakes: [] }),
      bucket,
      settings: {
        redeemFirst: TokenToCollect.COLLATERAL,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
    });

    collector.lpMap.set(3300, rewardLp);
    await collector.collectLpRewards();

    expect(removeCollateralStub.calledOnce).to.equal(true);
    const collateralCall = removeCollateralStub.getCall(0)!;
    const collateralWithdrawn = collateralCall.args[2] as BigNumber;
    expect(collateralWithdrawn.toString()).to.equal(oneLp.toString());
    expect(removeQuoteStub.calledOnce).to.equal(true);
    const quoteCall = removeQuoteStub.getCall(0)!;
    const quoteWithdrawn = quoteCall.args[2] as BigNumber;
    expect(quoteWithdrawn.toString()).to.equal(oneLp.toString());
    expect(collector.lpMap.has(3300)).to.equal(false);
  });

  it('does not attempt quote fallback after collateral withdrawal succeeds but the post-read fails', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const rewardLp = utils.parseUnits('1', 18);
    const bucket = makeFakeBucket({
      lpBalance: rewardLp,
      deposit: rewardLp,
      depositRedeemable: rewardLp,
      collateral: rewardLp,
      collateralRedeemable: rewardLp,
    });
    bucket.getPosition.onCall(0).resolves(
      makeBucketPosition({
        lpBalance: rewardLp,
        depositRedeemable: rewardLp,
        collateralRedeemable: rewardLp,
      })
    );
    bucket.getPosition.onCall(1).resolves(
      makeBucketPosition({
        lpBalance: rewardLp,
        depositRedeemable: rewardLp,
        collateralRedeemable: rewardLp,
      })
    );
    bucket.getPosition.onCall(2).rejects(new Error('post-read failed'));
    const removeCollateralStub = sinon
      .stub(transactions, 'bucketRemoveCollateralToken')
      .resolves();
    const removeQuoteStub = sinon
      .stub(transactions, 'bucketRemoveQuoteToken')
      .resolves();
    const exchangeTracker = { addToken: sinon.stub() };
    const collateralRewardAction = {
      action: RewardActionLabel.TRANSFER,
      to: signer,
    } as const;
    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: sinon.stub().resolves({ bucketTakes: [] }),
      bucket,
      exchangeTracker,
      settings: {
        redeemFirst: TokenToCollect.COLLATERAL,
        minAmountQuote: 0,
        minAmountCollateral: 0,
        rewardActionCollateral: collateralRewardAction,
      },
    });

    collector.lpMap.set(3400, rewardLp);
    await collector.collectLpRewards();

    expect(removeCollateralStub.calledOnce).to.equal(true);
    expect(exchangeTracker.addToken.calledOnce).to.equal(true);
    expect(removeQuoteStub.called).to.equal(false);
    expect(collector.lpMap.has(3400)).to.equal(true);
  });

  it('drops stale LP entries when Ajna rejects collateral redemption amounts', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const rewardLp = utils.parseUnits('1', 18);
    const bucket = makeFakeBucket({
      lpBalance: rewardLp,
      collateral: rewardLp,
      collateralRedeemable: rewardLp,
    });
    sinon
      .stub(transactions, 'bucketRemoveCollateralToken')
      .rejects(new Error('execution reverted: InvalidAmount'));
    const removeQuoteStub = sinon
      .stub(transactions, 'bucketRemoveQuoteToken')
      .resolves();
    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: sinon.stub().resolves({ bucketTakes: [] }),
      bucket,
      settings: {
        redeemFirst: TokenToCollect.COLLATERAL,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
    });

    collector.lpMap.set(3500, rewardLp);
    await collector.collectLpRewards();

    expect(removeQuoteStub.called).to.equal(false);
    expect(collector.lpMap.has(3500)).to.equal(false);
  });

  it('does not submit collateral withdrawals in dry-run mode', async () => {
    const signer = '0xabc0000000000000000000000000000000000000';
    const rewardLp = BigNumber.from(1);
    const bucket = makeFakeBucket({
      lpBalance: rewardLp,
      collateral: rewardLp,
      collateralRedeemable: rewardLp,
    });
    const removeCollateralStub = sinon
      .stub(transactions, 'bucketRemoveCollateralToken')
      .resolves();
    const removeQuoteStub = sinon
      .stub(transactions, 'bucketRemoveQuoteToken')
      .resolves();
    const collector = makeCollector({
      signerAddress: signer,
      getBucketTakeLPAwards: sinon.stub().resolves({ bucketTakes: [] }),
      bucket,
      runtime: {
        logLevel: 'debug',
        delayBetweenRuns: 0,
        dryRun: true,
      },
      settings: {
        redeemFirst: TokenToCollect.COLLATERAL,
        minAmountQuote: 0,
        minAmountCollateral: 0,
      },
    });

    collector.lpMap.set(3600, rewardLp);
    await collector.collectLpRewards();

    expect(removeCollateralStub.called).to.equal(false);
    expect(removeQuoteStub.called).to.equal(false);
    expect(collector.lpMap.has(3600)).to.equal(true);
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
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
          blockTimestamp: '100',
        },
        {
          id: 't2',
          index: 2001,
          taker: signer,
          lpAwarded: {
            lpAwardedTaker: '2.0',
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
          lpAwarded: {
            lpAwardedTaker: '1.0',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
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
      lpAwarded: {
        lpAwardedTaker: '1.5',
        lpAwardedKicker: '0',
        kicker: '0xdef',
      },
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
          lpAwarded: {
            lpAwardedTaker: '2.5',
            lpAwardedKicker: '0',
            kicker: '0xdef',
          },
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
    const loggerModule = require('../../src/logging');
    const warnStub = sinon.stub(loggerModule.logger, 'warn');

    await collector.ingestNewAwardsFromSubgraph();

    // All 5 events quarantined → threshold of 5 → one aggregate WARN.
    expect(
      warnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('Quarantined 5 BucketTake event(s)')
        )
    ).to.equal(true);
    expect(collector.lpMap.size).to.equal(0);
  });
});
