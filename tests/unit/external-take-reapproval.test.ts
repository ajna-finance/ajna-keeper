import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { createArbTakeStrategy } from '../../src/take/arb-strategy';
import { processTakeCandidates } from '../../src/take/engine';
import { BoundExternalTakeRouteEvaluation } from '../../src/take/types';
import { singleExternalTakeExecutionPlan } from '../helpers/external-take-plan';

describe('external take reapproval', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('reports the reapproved external take plan to execution callbacks', async () => {
    const initialEvaluation: BoundExternalTakeRouteEvaluation = {
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      takeablePrice: 1.2,
      quoteAmountRaw: BigNumber.from(100),
      routeExecutionFloorRaw: BigNumber.from(90),
    };
    const reapprovedEvaluation: BoundExternalTakeRouteEvaluation = {
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      takeablePrice: 1.3,
      quoteAmountRaw: BigNumber.from(120),
      routeExecutionFloorRaw: BigNumber.from(110),
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
});
