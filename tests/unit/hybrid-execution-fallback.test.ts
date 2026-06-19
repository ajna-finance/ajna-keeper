import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { executeHybridExternalTakeForDiscovery } from '../../src/discovery/external-take/hybrid';
import {
  createExternalTakeExecutionCandidate,
  createExternalTakeExecutionPlan,
} from '../../src/take/external-take/execution-plan';
import { buildTakeableOneInchQuote } from './helpers/external-take-quotes';

// P0-3 decision-matrix execution-fallback (money-safety / liveness): when the
// PRIMARY ranked candidate fails BEFORE broadcast, the keeper must fall back to
// the next approved candidate so the auction is still taken — not abandon the
// take. The fallback is re-approved against fresh auction state before executing.
describe('executeHybridExternalTakeForDiscovery — execution fallback', () => {
  afterEach(() => sinon.restore());

  it('falls back to the next approved candidate when the primary fails pre-broadcast', async () => {
    const primaryEval = buildTakeableOneInchQuote({
      quoteAmountRaw: BigNumber.from(100),
    });
    const fallbackEval = buildTakeableOneInchQuote({
      quoteAmountRaw: BigNumber.from(90),
    });
    const executionPlan = createExternalTakeExecutionPlan({
      primaryEvaluation: primaryEval as any,
      primaryApprovalContext: { source: 'primary' } as any,
      fallbacks: [
        createExternalTakeExecutionCandidate({
          evaluation: fallbackEval as any,
          approvalContext: { source: 'fallback' } as any,
        }),
      ],
    });

    const liquidation = {
      borrower: '0xBorrower',
      collateral: ethers.utils.parseEther('1'),
      auctionPrice: ethers.utils.parseEther('1'),
      hpbIndex: 0,
      isTakeable: true,
      isArbTakeable: false,
      externalTakeExecutionPlan: executionPlan,
    };

    // Primary execute fails pre-broadcast; the fallback execute succeeds.
    const execute = sinon.stub();
    execute
      .onFirstCall()
      .resolves({ succeeded: false, preBroadcastFailed: true });
    execute.onSecondCall().resolves({ succeeded: true });
    const provider = {
      execute,
      providerId: 'oneinch',
      path: 'calldata_aggregator',
    };

    const stats: any = {
      externalTakeByPath: {},
      externalTakeByProvider: {},
      executedExternalTakes: 0,
      dryRunExternalTakes: 0,
      hybridFallbackAttempts: 0,
      hybridFallbackSuccesses: 0,
      hybridGasQuoteFallbackAttempts: 0,
      hybridGasQuoteFallbackSuccesses: 0,
    };

    const result = await executeHybridExternalTakeForDiscovery({
      pool: { name: 'Fallback Pool' } as any,
      signer: {} as any,
      poolConfig: { name: 'Fallback Pool', take: {} } as any,
      liquidation: liquidation as any,
      config: { dryRun: false } as any,
      externalTakePaths: ['calldata_aggregator'],
      calldataAggregatorProviders: ['oneinch'],
      providerRegistry: {
        selectExternalTakeProviderForRoute: () => provider,
      } as any,
      // The fallback re-approval just re-runs the approver against fresh state.
      approveExternalTake: (async (p: any) => ({
        approved: true,
        quoteEvaluation: p.quoteEvaluation,
      })) as any,
      takeAuctionStatusReader: {
        read: async () => ({
          borrower: '0xBorrower',
          collateral: ethers.utils.parseEther('1'),
          auctionPrice: ethers.utils.parseEther('1'),
        }),
      } as any,
      stats,
    });

    expect(result).to.equal(true); // the fallback carried the take to success
    expect(execute.callCount).to.equal(2); // primary attempt + fallback attempt
    expect(stats.hybridFallbackAttempts).to.equal(1);
    expect(stats.hybridFallbackSuccesses).to.equal(1);
  });
});
