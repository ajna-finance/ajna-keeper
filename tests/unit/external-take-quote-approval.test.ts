import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { bindExternalTakeRouteForDiscovery } from '../../src/take/external-take/quote-approval-rules';
import { ApprovedCalldataAggregatorQuote } from '../../src/take/aggregator-calldata/types';
import { bindExternalTakeQuoteToExecutionResult } from '../../src/take/external-take/execution-plan';

const oneInchCalldataQuote: ApprovedCalldataAggregatorQuote = {
  providerId: 'oneinch',
  quotedAtMs: 1,
  chainId: 8453,
  srcToken: '0x' + '11'.repeat(20),
  dstToken: '0x' + '22'.repeat(20),
  dstReceiver: '0x' + '33'.repeat(20),
  amountInTokenUnits: BigNumber.from(100),
  quoteAmountRaw: BigNumber.from(200),
  routeMinOutRaw: BigNumber.from(150),
  transactionTarget: '0x' + '44'.repeat(20),
  approvalSpender: '0x' + '44'.repeat(20),
  callData: '0x12345678',
  selector: '0x12345678',
  txValue: '0',
  routeSummary: {
    providerId: 'oneinch',
    tool: '1inch',
    feeCosts: [],
  },
};

describe('external take quote approval', () => {
  it('rejects LI.FI discovery routes without a validated quote payload', () => {
    const binding = bindExternalTakeRouteForDiscovery({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        quoteAmountRaw: BigNumber.from(125),
        selectedLiquiditySource: LiquiditySource.LIFI,
      },
      selectedLiquiditySource: LiquiditySource.LIFI,
      poolName: 'Missing LI.FI Quote Pool',
      borrower: '0xBorrower',
    });

    expect(binding).to.deep.equal({
      bound: false,
      reason:
        'calldata-aggregator route is missing validated route details for Missing LI.FI Quote Pool/0xBorrower',
    });
  });

  it('binds migrated 1inch routes as calldata aggregator provider oneinch', () => {
    const binding = bindExternalTakeRouteForDiscovery({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        quoteAmountRaw: BigNumber.from(200),
        routeMinOutRaw: oneInchCalldataQuote.routeMinOutRaw,
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        calldataQuote: oneInchCalldataQuote,
      },
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      poolName: 'Migrated 1inch Pool',
      borrower: '0xBorrower',
    });

    expect(binding.bound).to.equal(true);
    if (!binding.bound) {
      return;
    }
    const boundQuote = binding.quoteEvaluation;
    expect(boundQuote.externalTakePath).to.equal('calldata_aggregator');
    if (boundQuote.externalTakePath !== 'calldata_aggregator') {
      throw new Error('expected calldata aggregator binding');
    }
    expect(boundQuote.providerId).to.equal('oneinch');
    expect(boundQuote.selectedLiquiditySource).to.equal(
      LiquiditySource.ONEINCH
    );
  });

  it('rejects discovery route binding without an explicit execution floor', () => {
    const binding = bindExternalTakeRouteForDiscovery({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        quoteAmountRaw: BigNumber.from(200),
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        calldataQuote: oneInchCalldataQuote,
      },
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      poolName: 'Missing Floor Pool',
      borrower: '0xBorrower',
    });

    expect(binding).to.deep.equal({
      bound: false,
      reason:
        'external take quote is missing route execution floor for Missing Floor Pool/0xBorrower',
    });
  });

  it('rejects conflicting calldata aggregator provider identities', () => {
    const binding = bindExternalTakeRouteForDiscovery({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        providerId: 'lifi',
        quoteAmountRaw: BigNumber.from(200),
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        calldataQuote: oneInchCalldataQuote,
      },
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      poolName: 'Provider Identity Pool',
      borrower: '0xBorrower',
    });

    expect(binding).to.deep.equal({
      bound: false,
      reason:
        'external take route has inconsistent calldata provider identity for Provider Identity Pool/0xBorrower',
    });
  });

  it('rejects calldata aggregator routes missing an explicit source', () => {
    const binding = bindExternalTakeRouteForDiscovery({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        quoteAmountRaw: BigNumber.from(200),
        calldataQuote: oneInchCalldataQuote,
      },
      poolName: 'Provider Identity Pool',
      borrower: '0xBorrower',
    });

    expect(binding).to.deep.equal({
      bound: false,
      reason:
        'external take route path=calldata_aggregator is missing selected liquidity source for Provider Identity Pool/0xBorrower',
    });
  });

  it('rejects execution-result routes missing an explicit source', () => {
    const result = bindExternalTakeQuoteToExecutionResult({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        quoteAmountRaw: BigNumber.from(200),
        calldataQuote: oneInchCalldataQuote,
      },
      poolName: 'Execution Identity Pool',
      borrower: '0xBorrower',
    });

    expect(result.takeable).to.equal(false);
    if (result.takeable) {
      throw new Error('expected route binding to reject the quote');
    }
    expect(result.reason).to.equal(
      'external take route path=calldata_aggregator is missing selected liquidity source for Execution Identity Pool/0xBorrower'
    );
  });

  it('rejects retired standalone 1inch path bindings after migration', () => {
    const binding = bindExternalTakeRouteForDiscovery({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'oneinch' as never,
        quoteAmountRaw: BigNumber.from(200),
        selectedLiquiditySource: LiquiditySource.ONEINCH,
      },
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      poolName: 'Retired 1inch Pool',
      borrower: '0xBorrower',
    });

    expect(binding).to.deep.equal({
      bound: false,
      reason: 'selected inconsistent path=oneinch source=ONEINCH',
    });
  });
});
