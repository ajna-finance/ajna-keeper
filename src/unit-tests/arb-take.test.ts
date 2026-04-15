import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import * as erc20 from '../erc20';
import { LiquiditySource } from '../config';
import { arbTakeLiquidation, checkIfArbTakeable } from '../take/arb';
import { processTakeCandidates } from '../take/engine';
import { createNoExternalTakeAdapter } from '../take';
import * as transactions from '../transactions';

describe('shared arbTake helpers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns the expected arbTake evaluation', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

    const pool = {
      name: 'Test Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      collateralAddress: '0x2222222222222222222222222222222222222222',
      getBucketByIndex: sinon.stub().withArgs(321).returns({
        price: ethers.utils.parseEther('10'),
      }),
    };

    const poolConfig = {
      name: 'Test Pool',
      take: {
        minCollateral: 1,
        hpbPriceFactor: 0.9,
        liquiditySource: LiquiditySource.UNISWAPV3,
      },
    };

    const args = [
      pool as any,
      8,
      ethers.utils.parseEther('2'),
      poolConfig as any,
      {
        cacheKey: 'test-subgraph',
        getHighestMeaningfulBucket: async () => ({
          buckets: [{ bucketIndex: 321 }],
        }),
      } as any,
      '0.1',
      {} as any,
    ] as const;

    const result = await checkIfArbTakeable(...args);

    expect(result.isArbTakeable).to.be.true;
    expect(result.hpbIndex).to.equal(321);
    expect(result.maxArbTakePrice).to.equal(9);
  });

  it('supports custom labels without changing arbTake execution', async () => {
    const liquidationSdk = { kind: 'liquidation-sdk' };
    const liquidationArbTakeStub = sinon
      .stub(transactions, 'liquidationArbTake')
      .resolves();

    const pool = {
      name: 'Execution Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().withArgs('0xBorrower').returns(liquidationSdk),
    };

    const liquidation = {
      borrower: '0xBorrower',
      hpbIndex: 77,
      collateral: ethers.utils.parseEther('1'),
      auctionPrice: ethers.utils.parseEther('1'),
      isTakeable: false,
      isArbTakeable: true,
    };

    const firstResult = await arbTakeLiquidation({
      pool: pool as any,
      signer: {} as any,
      liquidation,
      config: { dryRun: false },
    });

    const secondResult = await arbTakeLiquidation({
      pool: pool as any,
      signer: {} as any,
      liquidation,
      config: {
        dryRun: false,
        takeWriteTransport: { submitTransaction: sinon.stub(), signer: {} } as any,
      },
      actionLabel: 'Factory ArbTake',
      logPrefix: 'Factory: ',
    });

    expect(firstResult).to.equal(true);
    expect(secondResult).to.equal(true);

    expect(liquidationArbTakeStub.callCount).to.equal(2);
    expect(liquidationArbTakeStub.firstCall.args).to.deep.equal([
      liquidationSdk,
      {},
      77,
      undefined,
    ]);
    const forwardedTransport = liquidationArbTakeStub.secondCall.args[3];
    expect(liquidationArbTakeStub.secondCall.args[0]).to.equal(liquidationSdk);
    expect(liquidationArbTakeStub.secondCall.args[1]).to.deep.equal({});
    expect(liquidationArbTakeStub.secondCall.args[2]).to.equal(77);
    expect(forwardedTransport).to.not.equal(undefined);
    expect((forwardedTransport as any).signer).to.deep.equal({});
    expect(typeof (forwardedTransport as any).submitTransaction).to.equal(
      'function'
    );
  });

  it('forwards takeWriteTransport through processTakeCandidates into arbTake execution', async () => {
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: { getAddress: sinon.stub().resolves('0xwriter') },
      submitTransaction: sinon.stub(),
    };
    const arbTakeLiquidationStub = sinon
      .stub(require('../take/arb'), 'arbTakeLiquidation')
      .resolves(true);
    sinon.stub(require('../take/arb'), 'checkIfArbTakeable').resolves({
      isArbTakeable: true,
      hpbIndex: 77,
      maxArbTakePrice: 2,
    });

    const pool = {
      name: 'Execution Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('1'),
        }),
      }),
      getPrices: sinon.stub().resolves({
        hpb: ethers.utils.parseEther('1'),
      }),
    };

    await processTakeCandidates({
      pool: pool as any,
      signer: {} as any,
      poolConfig: {
        name: 'Execution Pool',
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.99,
        },
      } as any,
      candidates: [{ borrower: '0xBorrower' }],
      subgraph: {} as any,
      externalTakeAdapter: createNoExternalTakeAdapter() as any,
      externalExecutionConfig: {} as any,
      dryRun: false,
      delayBetweenActions: 0,
      takeWriteTransport: takeWriteTransport as any,
    });

    expect(arbTakeLiquidationStub.calledOnce).to.equal(true);
    expect(arbTakeLiquidationStub.firstCall.args[0].config.takeWriteTransport).to.equal(
      takeWriteTransport
    );
  });


  it('skips arb take after a successful external take changes the auction state', async () => {
    const executeExternalTakeStub = sinon.stub().resolves(true);
    const arbTakeLiquidationStub = sinon
      .stub(require('../take/arb'), 'arbTakeLiquidation')
      .resolves(true);
    sinon.stub(require('../take/arb'), 'checkIfArbTakeable').resolves({
      isArbTakeable: true,
      hpbIndex: 77,
      maxArbTakePrice: 2,
    });
    const onExecuted = sinon.stub();

    const getStatusStub = sinon.stub();
    getStatusStub
      .onCall(0)
      .resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('1'),
      })
      .onCall(1)
      .resolves({
        collateral: BigNumber.from(0),
        price: ethers.utils.parseEther('1'),
      });

    const pool = {
      name: 'Execution Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
      getPrices: sinon.stub().resolves({
        hpb: ethers.utils.parseEther('1'),
      }),
    };

    await processTakeCandidates({
      pool: pool as any,
      signer: {} as any,
      poolConfig: {
        name: 'Execution Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
          minCollateral: 0.1,
          hpbPriceFactor: 0.99,
        },
      } as any,
      candidates: [{ borrower: '0xBorrower' }],
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'legacy',
        evaluateExternalTake: sinon.stub().resolves({
          isTakeable: true,
          takeablePrice: 1,
        }),
        executeExternalTake: executeExternalTakeStub,
      } as any,
      externalExecutionConfig: {} as any,
      dryRun: false,
      delayBetweenActions: 0,
      approveArbTake: sinon.stub().resolves({ approved: true }),
      onExecuted,
    });

    expect(executeExternalTakeStub.calledOnce).to.equal(true);
    expect(arbTakeLiquidationStub.called).to.equal(false);
    expect(onExecuted.calledOnce).to.equal(true);
    expect(onExecuted.firstCall.args[0].executedTake).to.equal(true);
    expect(onExecuted.firstCall.args[0].executedArbTake).to.equal(false);
  });

  it('continues processing later candidates when an earlier candidate throws', async () => {
    const executeExternalTakeStub = sinon.stub().callsFake(async ({ liquidation }: any) => {
      if (liquidation.borrower === '0xBorrowerA') {
        throw new Error('quote provider failed');
      }
      return true;
    });
    const onSkip = sinon.stub();
    const onFound = sinon.stub();
    const onExecuted = sinon.stub();

    const pool = {
      name: 'Execution Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().callsFake((borrower: string) => ({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: borrower === '0xBorrowerA'
            ? ethers.utils.parseEther('1')
            : ethers.utils.parseEther('0.5'),
        }),
      })),
    };

    await processTakeCandidates({
      pool: pool as any,
      signer: {} as any,
      poolConfig: {
        name: 'Execution Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: [
        { borrower: '0xBorrowerA' },
        { borrower: '0xBorrowerB' },
      ],
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'legacy',
        evaluateExternalTake: sinon.stub().resolves({
          isTakeable: true,
          takeablePrice: 1,
        }),
        executeExternalTake: executeExternalTakeStub,
      } as any,
      externalExecutionConfig: {} as any,
      dryRun: false,
      delayBetweenActions: 0,
      onSkip,
      onFound,
      onExecuted,
    });

    expect(onSkip.calledOnce).to.equal(true);
    expect(onSkip.firstCall.args[0].candidate.borrower).to.equal('0xBorrowerA');
    expect(onSkip.firstCall.args[0].stage).to.equal('execution');
    expect(onSkip.firstCall.args[0].reason).to.include('quote provider failed');
    expect(onFound.callCount).to.equal(2);
    expect(onExecuted.calledOnce).to.equal(true);
    expect(onExecuted.firstCall.args[0].decision.borrower).to.equal('0xBorrowerB');
  });

  it('returns false when arb take execution fails', async () => {
    sinon.stub(transactions, 'liquidationArbTake').rejects(new Error('boom'));

    const result = await arbTakeLiquidation({
      pool: {
        name: 'Execution Pool',
        poolAddress: '0x3333333333333333333333333333333333333333',
        getLiquidation: sinon.stub().returns({}),
      } as any,
      signer: {} as any,
      liquidation: {
        borrower: '0xBorrower',
        hpbIndex: 77,
      },
      config: { dryRun: false },
    });

    expect(result).to.equal(false);
  });
});
