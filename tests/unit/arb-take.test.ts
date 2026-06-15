import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import * as erc20 from '../../src/erc20';
import {
  LiquiditySource,
  resolveCalldataAggregatorProviderForSource,
} from '../../src/config';
import { arbTakeLiquidation, checkIfArbTakeable } from '../../src/take/arb';
import {
  createArbTakeStrategy,
  isArbTakeStrategyEnabled,
} from '../../src/take/arb-strategy';
import { processTakeCandidates } from '../../src/take/engine';
import { createNoExternalTakeAdapter } from '../../src/take';
import {
  ExternalTakeEvaluationResult,
  ExternalTakeQuoteEvaluation,
} from '../../src/take/types';
import * as transactions from '../../src/transactions';
import { ApprovedCalldataAggregatorQuote } from '../../src/take/aggregator-calldata/types';
import { bindExternalTakeQuoteToExecutionResult } from '../../src/take/external-take/execution-plan';

function createTestCalldataQuote(
  quoteEvaluation: ExternalTakeQuoteEvaluation,
  providerId: ApprovedCalldataAggregatorQuote['providerId']
): ApprovedCalldataAggregatorQuote {
  const quoteAmountRaw = quoteEvaluation.quoteAmountRaw ?? BigNumber.from(100);
  return {
    providerId,
    quotedAtMs: 1,
    chainId: 8453,
    srcToken: '0x' + '11'.repeat(20),
    dstToken: '0x' + '22'.repeat(20),
    dstReceiver: '0x' + '33'.repeat(20),
    amountInTokenUnits: BigNumber.from(1),
    quoteAmountRaw,
    routeMinOutRaw:
      quoteEvaluation.approvedMinOutRaw ??
      quoteEvaluation.routeExecutionFloorRaw ??
      quoteAmountRaw,
    transactionTarget: '0x' + '44'.repeat(20),
    approvalSpender: '0x' + '44'.repeat(20),
    callData: '0x12345678',
    selector: '0x12345678',
    txValue: '0',
    routeSummary: {
      providerId,
      tool: providerId,
      feeCosts: [],
    },
  };
}

function withTestCalldataAggregatorQuote(
  quoteEvaluation: ExternalTakeQuoteEvaluation
): ExternalTakeQuoteEvaluation {
  const providerId =
    quoteEvaluation.selectedLiquiditySource !== undefined
      ? resolveCalldataAggregatorProviderForSource(
          quoteEvaluation.selectedLiquiditySource
        )
      : undefined;
  if (
    providerId === undefined &&
    quoteEvaluation.externalTakePath !== 'calldata_aggregator'
  ) {
    return quoteEvaluation;
  }
  if (providerId === undefined) {
    return quoteEvaluation;
  }
  return {
    ...quoteEvaluation,
    externalTakePath: 'calldata_aggregator',
    providerId,
    calldataQuote:
      quoteEvaluation.calldataQuote ??
      createTestCalldataQuote(quoteEvaluation, providerId),
  };
}

function externalTakeEvaluation(
  quoteEvaluation: ExternalTakeQuoteEvaluation
): ExternalTakeEvaluationResult {
  const executionQuoteEvaluation =
    withTestCalldataAggregatorQuote(quoteEvaluation);
  return bindExternalTakeQuoteToExecutionResult({
    quoteEvaluation: executionQuoteEvaluation,
    poolName: 'Execution Pool',
    borrower: '0xBorrower',
  });
}

describe('shared arbTake helpers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('enables arbTake only when both manual arb settings are present', () => {
    expect(
      isArbTakeStrategyEnabled({
        name: 'arb disabled',
        take: {},
      } as any)
    ).to.equal(false);
    expect(
      isArbTakeStrategyEnabled({
        name: 'missing hpb factor',
        take: { minCollateral: 1 },
      } as any)
    ).to.equal(false);
    expect(
      isArbTakeStrategyEnabled({
        name: 'arb enabled',
        take: { minCollateral: 1, hpbPriceFactor: 0.99 },
      } as any)
    ).to.equal(true);
  });

  it('short-circuits arb strategy evaluation when arbTake is disabled', async () => {
    const strategy = createArbTakeStrategy();
    const pool = {
      getPrices: sinon.stub().throws(new Error('should not read prices')),
    };

    const result = await strategy.evaluateArbTake({
      pool: pool as any,
      signer: {} as any,
      poolConfig: {
        name: 'arb disabled',
        take: {},
      } as any,
      subgraph: {} as any,
      price: 1,
      auctionPrice: ethers.utils.parseEther('1'),
      collateral: ethers.utils.parseEther('1'),
    });

    expect(result).to.deep.include({
      isArbTakeable: false,
      hpbIndex: 0,
      reason: 'arbTake settings are not configured',
    });
    expect(pool.getPrices.called).to.equal(false);
  });

  it('returns the expected arbTake evaluation', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

    const pool = {
      name: 'Test Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      collateralAddress: '0x2222222222222222222222222222222222222222',
      getBucketByIndex: sinon
        .stub()
        .withArgs(321)
        .returns({
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
      getLiquidation: sinon
        .stub()
        .withArgs('0xBorrower')
        .returns(liquidationSdk),
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
        takeWriteTransport: {
          submitTransaction: sinon.stub(),
          signer: {},
        } as any,
      },
      actionLabel: 'Direct DEX ArbTake',
      logPrefix: 'Direct DEX: ',
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
      .stub(require('../../src/take/arb'), 'arbTakeLiquidation')
      .resolves(true);
    sinon.stub(require('../../src/take/arb'), 'checkIfArbTakeable').resolves({
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
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      takeWriteTransport: takeWriteTransport as any,
    });

    expect(arbTakeLiquidationStub.calledOnce).to.equal(true);
    expect(
      arbTakeLiquidationStub.firstCall.args[0].config.takeWriteTransport
    ).to.equal(takeWriteTransport);
  });

  it('recomputes arb take eligibility during revalidation before execution', async () => {
    const arbTakeLiquidationStub = sinon
      .stub(require('../../src/take/arb'), 'arbTakeLiquidation')
      .resolves(true);
    sinon
      .stub(require('../../src/take/arb'), 'checkIfArbTakeable')
      .onFirstCall()
      .resolves({
        isArbTakeable: true,
        hpbIndex: 77,
        maxArbTakePrice: 2,
      })
      .onSecondCall()
      .resolves({
        isArbTakeable: false,
        hpbIndex: 88,
        maxArbTakePrice: 0.9,
        reason: 'auction price above arbTake threshold',
      });
    const onSkip = sinon.stub();

    const getStatusStub = sinon.stub().resolves({
      collateral: ethers.utils.parseEther('1'),
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
          minCollateral: 0.1,
          hpbPriceFactor: 0.99,
        },
      } as any,
      candidates: [{ borrower: '0xBorrower' }],
      subgraph: { cacheKey: 'test-subgraph' } as any,
      externalTakeAdapter: createNoExternalTakeAdapter() as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      revalidateBeforeExecution: true,
      onSkip,
    });

    expect(arbTakeLiquidationStub.called).to.equal(false);
    expect(onSkip.calledOnce).to.equal(true);
    expect(onSkip.firstCall.args[0].stage).to.equal('revalidation');
  });

  it('skips external take execution when approved quote collateral is stale', async () => {
    const executeExternalTakeStub = sinon.stub().resolves(true);
    const quotedCollateral = ethers.utils.parseEther('1');
    const getStatusStub = sinon.stub();
    getStatusStub
      .onCall(0)
      .resolves({
        collateral: quotedCollateral,
        price: ethers.utils.parseEther('1'),
      })
      .onCall(1)
      .resolves({
        collateral: ethers.utils.parseEther('2'),
        price: ethers.utils.parseEther('0.9'),
      });
    const pool = {
      name: 'Execution Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };
    const onSkip = sinon.stub();

    await processTakeCandidates({
      pool: pool as any,
      signer: {} as any,
      poolConfig: {
        name: 'Execution Pool',
        take: {
          marketPriceFactor: 0.99,
          liquiditySource: LiquiditySource.ONEINCH,
        },
      } as any,
      candidates: [{ borrower: '0xBorrower' }],
      subgraph: { cacheKey: 'test-subgraph' } as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            externalTakePath: 'calldata_aggregator',
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            takeablePrice: 2,
            quoteAmountRaw: BigNumber.from(100),
            quotedCollateralWad: quotedCollateral,
            quotedAuctionPriceWad: ethers.utils.parseEther('1'),
          })
        ),
        executeExternalTake: executeExternalTakeStub,
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      revalidateBeforeExecution: true,
      onSkip,
    });

    expect(executeExternalTakeStub.called).to.equal(false);
    expect(onSkip.calledOnce).to.equal(true);
    expect(onSkip.firstCall.args[0].reason).to.equal(
      'approved external take quote no longer matches collateral'
    );
  });

  it('skips external take execution when approved quote price is stale', async () => {
    const executeExternalTakeStub = sinon.stub().resolves(true);
    const quotedCollateral = ethers.utils.parseEther('1');
    const quotedAuctionPrice = ethers.utils.parseEther('1');
    const getStatusStub = sinon.stub();
    getStatusStub
      .onCall(0)
      .resolves({
        collateral: quotedCollateral,
        price: quotedAuctionPrice,
      })
      .onCall(1)
      .resolves({
        collateral: quotedCollateral,
        price: ethers.utils.parseEther('1.1'),
      });
    const pool = {
      name: 'Execution Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };
    const onSkip = sinon.stub();

    await processTakeCandidates({
      pool: pool as any,
      signer: {} as any,
      poolConfig: {
        name: 'Execution Pool',
        take: {
          marketPriceFactor: 0.99,
          liquiditySource: LiquiditySource.ONEINCH,
        },
      } as any,
      candidates: [{ borrower: '0xBorrower' }],
      subgraph: { cacheKey: 'test-subgraph' } as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            externalTakePath: 'calldata_aggregator',
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            takeablePrice: 2,
            quoteAmountRaw: BigNumber.from(100),
            quotedCollateralWad: quotedCollateral,
            quotedAuctionPriceWad: quotedAuctionPrice,
          })
        ),
        executeExternalTake: executeExternalTakeStub,
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      revalidateBeforeExecution: true,
      onSkip,
    });

    expect(executeExternalTakeStub.called).to.equal(false);
    expect(onSkip.calledOnce).to.equal(true);
    expect(onSkip.firstCall.args[0].reason).to.equal(
      'approved external take quote is stale after auction price increased'
    );
  });

  it('skips arb take after a successful external take changes the auction state', async () => {
    const executeExternalTakeStub = sinon.stub().resolves(true);
    const arbTakeLiquidationStub = sinon
      .stub(require('../../src/take/arb'), 'arbTakeLiquidation')
      .resolves(true);
    sinon.stub(require('../../src/take/arb'), 'checkIfArbTakeable').resolves({
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
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            externalTakePath: 'calldata_aggregator',
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            takeablePrice: 1,
            quoteAmountRaw: BigNumber.from(100),
            approvedMinOutRaw: BigNumber.from(90),
          })
        ),
        executeExternalTake: executeExternalTakeStub,
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
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
    const executeExternalTakeStub = sinon
      .stub()
      .callsFake(async ({ liquidation }: any) => {
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
          price:
            borrower === '0xBorrowerA'
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
      candidates: [{ borrower: '0xBorrowerA' }, { borrower: '0xBorrowerB' }],
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            externalTakePath: 'calldata_aggregator',
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            takeablePrice: 1,
            quoteAmountRaw: BigNumber.from(100),
            approvedMinOutRaw: BigNumber.from(90),
          })
        ),
        executeExternalTake: executeExternalTakeStub,
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
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
    expect(onExecuted.firstCall.args[0].decision.borrower).to.equal(
      '0xBorrowerB'
    );
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

  it('handles parallel candidate evaluation in deterministic order while serializing execution', async () => {
    const borrowers = ['0xBorrowerA', '0xBorrowerB'];
    const evaluationCompletionOrder: string[] = [];
    const executionOrder: string[] = [];
    let executionInFlight = 0;
    let maxExecutionInFlight = 0;
    const statusReader = {
      read: sinon.stub().callsFake(async ({ borrower }) => {
        await new Promise((resolve) =>
          setTimeout(resolve, borrower === borrowers[0] ? 20 : 1)
        );
        evaluationCompletionOrder.push(borrower);
        return {
          borrower,
          collateral: ethers.utils.parseEther('1'),
          auctionPrice: ethers.utils.parseEther('1'),
        };
      }),
    };
    const onFound = sinon.stub();

    await processTakeCandidates({
      pool: {
        name: 'Parallel Candidate Pool',
        poolAddress: '0x3333333333333333333333333333333333333333',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Parallel Candidate Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: borrowers.map((borrower) => ({ borrower })),
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            quoteAmountRaw: BigNumber.from(100),
            takeablePrice: 1,
          })
        ),
        executeExternalTake: sinon.stub().callsFake(async ({ liquidation }) => {
          executionOrder.push(liquidation.borrower);
          executionInFlight += 1;
          maxExecutionInFlight = Math.max(
            maxExecutionInFlight,
            executionInFlight
          );
          await new Promise((resolve) => setTimeout(resolve, 5));
          executionInFlight -= 1;
          return true;
        }),
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: true,
      takeAuctionStatusReader: statusReader as any,
      maxConcurrentCandidateEvaluations: 2,
      onFound,
    });

    expect(evaluationCompletionOrder).to.deep.equal([
      borrowers[1],
      borrowers[0],
    ]);
    expect(
      onFound.getCalls().map((call) => call.args[0].borrower)
    ).to.deep.equal(borrowers);
    expect(executionOrder).to.deep.equal(borrowers);
    expect(maxExecutionInFlight).to.equal(1);
  });

  it('discards already evaluated window decisions after state-changing execution', async () => {
    const borrowers = ['0xBorrowerA', '0xBorrowerB', '0xBorrowerC'];
    const evaluatedBorrowers: string[] = [];
    const executionOrder: string[] = [];
    const statusReader = {
      read: sinon.stub().callsFake(async ({ borrower }) => {
        evaluatedBorrowers.push(borrower);
        return {
          borrower,
          collateral: ethers.utils.parseEther('1'),
          auctionPrice: ethers.utils.parseEther('1'),
        };
      }),
    };

    await processTakeCandidates({
      pool: {
        name: 'State Change Pool',
        poolAddress: '0x3333333333333333333333333333333333333333',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'State Change Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: borrowers.map((borrower) => ({ borrower })),
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            quoteAmountRaw: BigNumber.from(100),
            takeablePrice: 1,
          })
        ),
        executeExternalTake: sinon.stub().callsFake(async ({ liquidation }) => {
          executionOrder.push(liquidation.borrower);
          return true;
        }),
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      takeAuctionStatusReader: statusReader as any,
      maxConcurrentCandidateEvaluations: 2,
    });

    expect(evaluatedBorrowers).to.deep.equal(borrowers);
    expect(executionOrder).to.deep.equal([borrowers[0], borrowers[2]]);
  });

  it('preloads only the active candidate window before stopping after execution', async () => {
    const borrowers = [
      '0xBorrowerA',
      '0xBorrowerB',
      '0xBorrowerC',
      '0xBorrowerD',
    ];
    const readMany = sinon.stub().callsFake(async ({ borrowers }) => {
      return new Map(
        borrowers.map((borrower: string) => [
          borrower.toLowerCase(),
          {
            borrower,
            collateral: ethers.utils.parseEther('1'),
            auctionPrice: ethers.utils.parseEther('1'),
          },
        ])
      );
    });
    const read = sinon
      .stub()
      .rejects(new Error('single status reads should not be needed'));
    const executeExternalTake = sinon.stub().resolves(true);

    await processTakeCandidates({
      pool: {
        name: 'Window Preload Pool',
        poolAddress: '0x3333333333333333333333333333333333333333',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Window Preload Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: borrowers.map((borrower) => ({ borrower })),
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            quoteAmountRaw: BigNumber.from(100),
            takeablePrice: 1,
          })
        ),
        executeExternalTake,
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      takeAuctionStatusReader: { read, readMany } as any,
      maxConcurrentCandidateEvaluations: 2,
      stopAfterExecution: true,
    });

    expect(readMany.calledOnce).to.equal(true);
    expect(readMany.firstCall.args[0].borrowers).to.deep.equal(
      borrowers.slice(0, 2)
    );
    expect(read.notCalled).to.equal(true);
    expect(executeExternalTake.calledOnce).to.equal(true);
    expect(executeExternalTake.firstCall.args[0].liquidation.borrower).to.equal(
      borrowers[0]
    );
  });

  it('does not reuse preloaded evaluation statuses after a state-changing execution when continuing', async () => {
    const borrowers = ['0xBorrowerA', '0xBorrowerB', '0xBorrowerC'];
    const statusReader = {
      read: sinon.stub().callsFake(async ({ borrower }) => ({
        borrower,
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
      })),
    };
    const candidateStatuses = new Map(
      borrowers.map((borrower) => [
        borrower.toLowerCase(),
        {
          borrower,
          collateral: ethers.utils.parseEther('1'),
          auctionPrice: ethers.utils.parseEther('1'),
        },
      ])
    );
    const executionOrder: string[] = [];

    await processTakeCandidates({
      pool: {
        name: 'Preloaded Status Invalidation Pool',
        poolAddress: '0x3333333333333333333333333333333333333333',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Preloaded Status Invalidation Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: borrowers.map((borrower) => ({ borrower })),
      candidateStatuses,
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            quoteAmountRaw: BigNumber.from(100),
            takeablePrice: 1,
          })
        ),
        executeExternalTake: sinon.stub().callsFake(async ({ liquidation }) => {
          executionOrder.push(liquidation.borrower);
          return true;
        }),
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      takeAuctionStatusReader: statusReader as any,
      maxConcurrentCandidateEvaluations: 2,
    });

    expect(executionOrder).to.deep.equal([borrowers[0], borrowers[2]]);
    expect(statusReader.read.calledOnce).to.equal(true);
    expect(statusReader.read.firstCall.args[0].borrower).to.equal(borrowers[2]);
  });

  it('continues same-pool execution until maxExecutions is reached', async () => {
    const borrowers = ['0xBorrowerA', '0xBorrowerB', '0xBorrowerC'];
    const statusReader = {
      read: sinon.stub().callsFake(async ({ borrower }) => ({
        borrower,
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
      })),
    };
    const executionOrder: string[] = [];

    await processTakeCandidates({
      pool: {
        name: 'Same Pool Cascade',
        poolAddress: '0x3333333333333333333333333333333333333333',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Same Pool Cascade',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: borrowers.map((borrower) => ({ borrower })),
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            quoteAmountRaw: BigNumber.from(100),
            takeablePrice: 1,
          })
        ),
        executeExternalTake: sinon.stub().callsFake(async ({ liquidation }) => {
          executionOrder.push(liquidation.borrower);
          return true;
        }),
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      takeAuctionStatusReader: statusReader as any,
      maxConcurrentCandidateEvaluations: 1,
      stopAfterExecution: false,
      maxExecutions: 2,
    });

    expect(executionOrder).to.deep.equal(borrowers.slice(0, 2));
    expect(
      statusReader.read.getCalls().map((call) => call.args[0].borrower)
    ).to.deep.equal(borrowers.slice(0, 2));
  });

  it('stops after an ambiguous attempted submission even when multi-execution is enabled', async () => {
    const borrowers = ['0xBorrowerA', '0xBorrowerB'];
    let attemptedSubmission = false;
    const statusReader = {
      read: sinon.stub().callsFake(async ({ borrower }) => ({
        borrower,
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
      })),
    };
    const executeExternalTake = sinon.stub().callsFake(async () => {
      attemptedSubmission = true;
      throw new Error('post-submit receipt failed');
    });
    const onSkip = sinon.stub();

    await processTakeCandidates({
      pool: {
        name: 'Ambiguous Multi Pool',
        poolAddress: '0x3333333333333333333333333333333333333333',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Ambiguous Multi Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: borrowers.map((borrower) => ({ borrower })),
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            quoteAmountRaw: BigNumber.from(100),
            takeablePrice: 1,
          })
        ),
        executeExternalTake,
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      takeAuctionStatusReader: statusReader as any,
      maxConcurrentCandidateEvaluations: 1,
      stopAfterExecution: false,
      stopAfterAttemptedSubmissionFailure: true,
      maxExecutions: 2,
      resetExternalTakeAttemptSubmission: () => {
        attemptedSubmission = false;
      },
      didExternalTakeAttemptSubmission: () => attemptedSubmission,
      onSkip,
    });

    expect(executeExternalTake.calledOnce).to.equal(true);
    expect(statusReader.read.calledOnce).to.equal(true);
    expect(onSkip.calledOnce).to.equal(true);
    expect(onSkip.firstCall.args[0].candidate.borrower).to.equal(borrowers[0]);
  });

  it('stops after an ambiguous post-submission external take failure', async () => {
    const borrowers = ['0xBorrowerA', '0xBorrowerB'];
    let attemptedSubmission = false;
    const candidateStatuses = new Map(
      borrowers.map((borrower) => [
        borrower.toLowerCase(),
        {
          borrower,
          collateral: ethers.utils.parseEther('1'),
          auctionPrice: ethers.utils.parseEther('1'),
        },
      ])
    );
    const executeExternalTake = sinon.stub().callsFake(async () => {
      attemptedSubmission = true;
      return false;
    });
    const onFound = sinon.stub();
    const onSkip = sinon.stub();

    await processTakeCandidates({
      pool: {
        name: 'Ambiguous Failure Pool',
        poolAddress: '0x3333333333333333333333333333333333333333',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Ambiguous Failure Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: borrowers.map((borrower) => ({ borrower })),
      candidateStatuses,
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves(
          externalTakeEvaluation({
            isTakeable: true,
            selectedLiquiditySource: LiquiditySource.ONEINCH,
            quoteAmountRaw: BigNumber.from(100),
            takeablePrice: 1,
          })
        ),
        executeExternalTake,
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      maxConcurrentCandidateEvaluations: 2,
      stopAfterExecution: true,
      resetExternalTakeAttemptSubmission: () => {
        attemptedSubmission = false;
      },
      didExternalTakeAttemptSubmission: () => attemptedSubmission,
      onFound,
      onSkip,
    });

    expect(executeExternalTake.calledOnce).to.equal(true);
    expect(executeExternalTake.firstCall.args[0].liquidation.borrower).to.equal(
      borrowers[0]
    );
    expect(onFound.calledOnce).to.equal(true);
    expect(onFound.firstCall.args[0].borrower).to.equal(borrowers[0]);
    expect(onSkip.calledOnce).to.equal(true);
    expect(onSkip.firstCall.args[0].candidate.borrower).to.equal(borrowers[0]);
    expect(onSkip.firstCall.args[0].stage).to.equal('execution');
  });
});
