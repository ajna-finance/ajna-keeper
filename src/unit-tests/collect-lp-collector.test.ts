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
