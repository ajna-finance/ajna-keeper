import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { createArbTakeStrategy } from '../../src/take/arb-strategy';
import type { ApprovedCalldataAggregatorQuote } from '../../src/take/aggregator-calldata/types';
import { processTakeCandidates } from '../../src/take/engine';
import { BoundExternalTakeRouteEvaluation } from '../../src/take/types';
import { singleExternalTakeExecutionPlan } from '../helpers/external-take-plan';

function buildOneInchCalldataQuote(
  quoteAmountRaw: BigNumber
): ApprovedCalldataAggregatorQuote {
  return {
    providerId: 'oneinch',
    quotedAtMs: Date.now(),
    chainId: 1,
    srcToken: '0x1111111111111111111111111111111111111111',
    dstToken: '0x2222222222222222222222222222222222222222',
    dstReceiver: '0x3333333333333333333333333333333333333333',
    amountInTokenUnits: BigNumber.from(1),
    quoteAmountRaw,
    routeMinOutRaw: quoteAmountRaw,
    transactionTarget: '0x4444444444444444444444444444444444444444',
    approvalSpender: '0x5555555555555555555555555555555555555555',
    callData: '0x12345678',
    selector: '0x12345678',
    txValue: '0',
    routeSummary: {
      providerId: 'oneinch',
      tool: '1inch',
      feeCosts: [],
    },
  };
}

describe('external take reapproval', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('reports the reapproved external take plan to execution callbacks', async () => {
    const initialEvaluation: BoundExternalTakeRouteEvaluation = {
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      providerId: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      takeablePrice: 1.2,
      quoteAmountRaw: BigNumber.from(100),
      routeExecutionFloorRaw: BigNumber.from(90),
      calldataQuote: buildOneInchCalldataQuote(BigNumber.from(100)),
    };
    const reapprovedEvaluation: BoundExternalTakeRouteEvaluation = {
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      providerId: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      takeablePrice: 1.3,
      quoteAmountRaw: BigNumber.from(120),
      routeExecutionFloorRaw: BigNumber.from(110),
      calldataQuote: buildOneInchCalldataQuote(BigNumber.from(120)),
    };
    const approvalContext = { source: 'initial approval' };
    const executeExternalTake = sinon.stub().resolves(true);
    const reapproveExternalTakeBeforeExecution = sinon.stub().resolves({
      approved: true,
      quoteEvaluation: reapprovedEvaluation,
    });
    const onExecuted = sinon.stub();
    const auctionPrice = ethers.utils.parseEther('1');
    const collateral = ethers.utils.parseEther('1');
    const takeAuctionStatusReader = {
      read: sinon.stub().resolves({
        borrower: '0xBorrower',
        collateral,
        auctionPrice,
      }),
    };

    await processTakeCandidates({
      pool: {
        name: 'Reapproved External Pool',
        poolAddress: '0x3333333333333333333333333333333333333333',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Reapproved External Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      candidates: [{ borrower: '0xBorrower' }],
      subgraph: { cacheKey: 'test-subgraph' } as any,
      externalTakeAdapter: {
        kind: 'oneinch',
        evaluateExternalTake: sinon.stub().resolves({
          takeable: true,
          executionPlan: singleExternalTakeExecutionPlan(
            initialEvaluation,
            approvalContext
          ),
        }),
        executeExternalTake,
      } as any,
      arbTakeStrategy: createArbTakeStrategy(),
      externalExecutionConfig: {} as any,
      dryRun: false,
      revalidateBeforeExecution: true,
      reapproveExternalTakeBeforeExecution,
      takeAuctionStatusReader: takeAuctionStatusReader as any,
      onExecuted,
    });

    expect(reapproveExternalTakeBeforeExecution.calledOnce).to.equal(true);
    expect(
      reapproveExternalTakeBeforeExecution.firstCall.args[0]
        .externalTakeApprovalContext
    ).to.equal(approvalContext);
    expect(executeExternalTake.calledOnce).to.equal(true);
    expect(
      executeExternalTake.firstCall.args[0].liquidation
        .externalTakeExecutionPlan.primary.evaluation
    ).to.equal(reapprovedEvaluation);
    expect(onExecuted.calledOnce).to.equal(true);
    expect(
      onExecuted.firstCall.args[0].decision.externalTakeExecutionPlan.primary
        .evaluation
    ).to.equal(reapprovedEvaluation);
    expect(
      onExecuted.firstCall.args[0].decision.externalTakeExecutionPlan.primary
        .approvalContext
    ).to.equal(approvalContext);
  });

  // P2-1 multi-auction: a single discovered target can hold several auctions
  // (candidates). The executor must take more than one per cycle, bounded by
  // maxExecutions (the rest carry to a later cycle).
  it('processes multiple discovered candidates in one cycle and respects the maxExecutions cap', async () => {
    const evaluation: BoundExternalTakeRouteEvaluation = {
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      providerId: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      takeablePrice: 1.2,
      quoteAmountRaw: BigNumber.from(100),
      routeExecutionFloorRaw: BigNumber.from(90),
      calldataQuote: buildOneInchCalldataQuote(BigNumber.from(100)),
    };
    const auctionPrice = ethers.utils.parseEther('1');
    const collateral = ethers.utils.parseEther('1');

    const runWithCap = async (maxExecutions: number) => {
      const executeExternalTake = sinon.stub().resolves(true);
      await processTakeCandidates({
        pool: {
          name: 'Multi-Auction Pool',
          poolAddress: '0x3333333333333333333333333333333333333333',
        } as any,
        signer: {} as any,
        poolConfig: {
          name: 'Multi-Auction Pool',
          take: {
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.99,
          },
        } as any,
        candidates: [{ borrower: '0xBorrowerA' }, { borrower: '0xBorrowerB' }],
        subgraph: { cacheKey: 'test-subgraph' } as any,
        externalTakeAdapter: {
          kind: 'oneinch',
          evaluateExternalTake: sinon.stub().resolves({
            takeable: true,
            executionPlan: singleExternalTakeExecutionPlan(evaluation, {
              source: 'ctx',
            }),
          }),
          executeExternalTake,
        } as any,
        arbTakeStrategy: createArbTakeStrategy(),
        externalExecutionConfig: {} as any,
        dryRun: false,
        maxExecutions,
        takeAuctionStatusReader: {
          read: sinon.stub().resolves({ collateral, auctionPrice }),
        } as any,
      });
      return executeExternalTake;
    };

    // maxExecutions=2: BOTH auctions are taken in the one cycle.
    const both = await runWithCap(2);
    expect(both.callCount).to.equal(2);

    // maxExecutions=1: the cap stops after the first; the second is left for a
    // later cycle (not double-processed, not dropped).
    const capped = await runWithCap(1);
    expect(capped.callCount).to.equal(1);
  });
});
