import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { evaluateTakeDecision, TAKE_SKIP_REASONS } from '../../src/take/engine';
import { BoundExternalTakeRouteEvaluation } from '../../src/take/types';
import { singleExternalTakeExecutionPlan } from '../helpers/external-take-plan';

function directDexEvaluation(
  overrides: Partial<BoundExternalTakeRouteEvaluation> = {}
): BoundExternalTakeRouteEvaluation {
  return {
    isTakeable: true,
    externalTakePath: 'direct_dex',
    selectedLiquiditySource: LiquiditySource.UNISWAPV3,
    selectedFeeTier: 3000,
    quoteAmountRaw: BigNumber.from(100),
    routeExecutionFloorRaw: BigNumber.from(90),
    ...overrides,
  } as BoundExternalTakeRouteEvaluation;
}

describe('take decision engine branch coverage', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('short-circuits strategy evaluation when the auction has no collateral', async () => {
    const evaluateExternalTake = sinon.stub().throws(new Error('no external'));
    const evaluateArbTake = sinon.stub().throws(new Error('no arb'));

    const decision = await evaluateTakeDecision({
      pool: { name: 'Inactive Pool' } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Inactive Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
          minCollateral: 1,
          hpbPriceFactor: 0.98,
        },
      } as any,
      candidate: { borrower: '0xBorrower' },
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'direct_dex',
        evaluateExternalTake,
      } as any,
      arbTakeStrategy: {
        isEnabled: sinon.stub().returns(true),
        evaluateArbTake,
      } as any,
      auctionStatus: {
        borrower: '0xBorrower',
        collateral: BigNumber.from(0),
        auctionPrice: ethers.utils.parseEther('1'),
      },
    });

    expect(decision.approvedTake).to.equal(false);
    expect(decision.approvedArbTake).to.equal(false);
    expect(decision.reason).to.equal(TAKE_SKIP_REASONS.auctionInactive);
    expect(evaluateExternalTake.called).to.equal(false);
    expect(evaluateArbTake.called).to.equal(false);
  });

  it('keeps an approved arbTake path when external-take approval rejects', async () => {
    const evaluation = directDexEvaluation();

    const decision = await evaluateTakeDecision({
      pool: { name: 'Fallback Arb Pool' } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Fallback Arb Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
          minCollateral: 1,
          hpbPriceFactor: 0.98,
        },
      } as any,
      candidate: { borrower: '0xBorrower' },
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'direct_dex',
        evaluateExternalTake: sinon.stub().resolves({
          takeable: true,
          executionPlan: singleExternalTakeExecutionPlan(evaluation),
        }),
      } as any,
      arbTakeStrategy: {
        isEnabled: sinon.stub().returns(true),
        evaluateArbTake: sinon.stub().resolves({
          isArbTakeable: true,
          hpbIndex: 42,
          maxArbTakePrice: 0.9,
        }),
      } as any,
      approveExternalTake: sinon.stub().resolves({
        approved: false,
        reason: 'external policy rejected',
      }),
      auctionStatus: {
        borrower: '0xBorrower',
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
      },
    });

    expect(decision.approvedTake).to.equal(false);
    expect(decision.approvedArbTake).to.equal(true);
    expect(decision.hpbIndex).to.equal(42);
    expect(decision.maxArbTakePrice).to.equal(0.9);
    expect(decision.reason).to.equal('external policy rejected');
  });

  it('uses the configured-policy skip reason when all configured take paths reject without reasons', async () => {
    const decision = await evaluateTakeDecision({
      pool: { name: 'Rejected Pool' } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Rejected Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
          minCollateral: 1,
          hpbPriceFactor: 0.98,
        },
      } as any,
      candidate: { borrower: '0xBorrower' },
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'direct_dex',
        evaluateExternalTake: sinon.stub().resolves({
          takeable: false,
          quoteEvaluation: { isTakeable: false },
        }),
      } as any,
      arbTakeStrategy: {
        isEnabled: sinon.stub().returns(true),
        evaluateArbTake: sinon.stub().resolves({
          isArbTakeable: false,
          hpbIndex: 0,
        }),
      } as any,
      auctionStatus: {
        borrower: '0xBorrower',
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
      },
    });

    expect(decision.approvedTake).to.equal(false);
    expect(decision.approvedArbTake).to.equal(false);
    expect(decision.reason).to.equal(
      'auction price 1 did not satisfy configured take policies'
    );
  });

  it('reports an explicit no-strategy skip when neither external take nor arbTake is configured', async () => {
    const decision = await evaluateTakeDecision({
      pool: { name: 'Unconfigured Pool' } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Unconfigured Pool',
        take: {},
      } as any,
      candidate: { borrower: '0xBorrower' },
      subgraph: {} as any,
      externalTakeAdapter: {
        kind: 'none',
      } as any,
      arbTakeStrategy: {
        isEnabled: sinon.stub().returns(false),
        evaluateArbTake: sinon.stub().throws(new Error('no arb')),
      } as any,
      auctionStatus: {
        borrower: '0xBorrower',
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
      },
    });

    expect(decision.approvedTake).to.equal(false);
    expect(decision.approvedArbTake).to.equal(false);
    expect(decision.reason).to.equal(
      'no external take or arbTake strategy is configured'
    );
  });
});
