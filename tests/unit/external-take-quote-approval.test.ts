import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import {
  approveDirectDexQuoteForExecution,
  bindExternalTakeRouteForDiscovery,
} from '../../src/take/external-take/quote-approval-rules';
import { approveCalldataAggregatorQuoteForExecution } from '../../src/take/aggregator-calldata/quote-approval';
import { ApprovedCalldataAggregatorQuote } from '../../src/take/aggregator-calldata/types';
import { bindExternalTakeQuoteToExecutionResult } from '../../src/take/external-take/execution-plan';
import { ExternalTakeQuoteEvaluation } from '../../src/take/types';

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

const curvePool = {
  address: '0x' + '66'.repeat(20),
  poolType: CurvePoolType.STABLE,
  tokenInIndex: 0,
  tokenOutIndex: 1,
};

function calldataQuote(
  overrides: Partial<ApprovedCalldataAggregatorQuote> = {}
): ApprovedCalldataAggregatorQuote {
  return {
    ...oneInchCalldataQuote,
    ...overrides,
  };
}

function calldataAggregatorEvaluation(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  return {
    isTakeable: true,
    externalTakePath: 'calldata_aggregator',
    quoteAmountRaw: BigNumber.from(200),
    routeMinOutRaw: BigNumber.from(150),
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    calldataQuote: calldataQuote(),
    ...overrides,
  };
}

function directDexEvaluation(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  return {
    isTakeable: true,
    externalTakePath: 'direct_dex',
    quoteAmountRaw: BigNumber.from(200),
    routeMinOutRaw: BigNumber.from(150),
    selectedLiquiditySource: LiquiditySource.UNISWAPV3,
    selectedFeeTier: 3000,
    ...overrides,
  };
}

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

  describe('approveCalldataAggregatorQuoteForExecution', () => {
    function approve(quoteEvaluation: ExternalTakeQuoteEvaluation) {
      return approveCalldataAggregatorQuoteForExecution({
        quoteEvaluation,
        providerId: 'oneinch',
        poolName: 'Aggregator Execution Pool',
        borrower: '0xBorrower',
      });
    }

    it('approves a bounded calldata aggregator quote and derives the execution floor', () => {
      const approval = approve(
        calldataAggregatorEvaluation({
          routeExecutionFloorRaw: undefined,
          routeMinOutRaw: BigNumber.from(151),
        })
      );

      expect(approval.approved).to.equal(true);
      if (!approval.approved) {
        throw new Error(`expected approval: ${approval.reason}`);
      }
      expect(approval.quoteEvaluation.providerId).to.equal('oneinch');
      expect(approval.quoteEvaluation.selectedLiquiditySource).to.equal(
        LiquiditySource.ONEINCH
      );
      expect(approval.quoteEvaluation.approvedMinOutRaw.eq(151)).to.equal(
        true
      );
      expect(approval.quoteEvaluation.routeExecutionFloorRaw?.eq(151)).to.equal(
        true
      );
    });

    it('preserves an explicit route execution floor when approving', () => {
      const approval = approve(
        calldataAggregatorEvaluation({
          routeExecutionFloorRaw: BigNumber.from(175),
          routeMinOutRaw: BigNumber.from(150),
        })
      );

      expect(approval.approved).to.equal(true);
      if (!approval.approved) {
        throw new Error(`expected approval: ${approval.reason}`);
      }
      expect(approval.quoteEvaluation.approvedMinOutRaw.eq(175)).to.equal(
        true
      );
      expect(approval.quoteEvaluation.routeExecutionFloorRaw?.eq(175)).to.equal(
        true
      );
    });

    it('rejects non-takeable calldata aggregator quotes with and without explicit reasons', () => {
      for (const reason of [undefined, 'quote below floor']) {
        const approval = approve(
          calldataAggregatorEvaluation({
            isTakeable: false,
            reason,
          })
        );

        expect(approval).to.deep.equal({
          approved: false,
          reason: `1inch quote no longer satisfies execution policy for Aggregator Execution Pool/0xBorrower: ${reason ?? 'not takeable'}`,
        });
      }
    });

    it('rejects calldata aggregator quotes missing bounded execution inputs', () => {
      const cases: Array<{
        quoteEvaluation: ExternalTakeQuoteEvaluation;
        reason: string;
      }> = [
        {
          quoteEvaluation: calldataAggregatorEvaluation({
            quoteAmountRaw: undefined,
          }),
          reason:
            '1inch quote is missing raw quote amount for Aggregator Execution Pool/0xBorrower',
        },
        {
          quoteEvaluation: calldataAggregatorEvaluation({
            externalTakePath: 'direct_dex',
          }),
          reason:
            '1inch execution received a non-calldata-aggregator approved path for Aggregator Execution Pool/0xBorrower',
        },
        {
          quoteEvaluation: calldataAggregatorEvaluation({
            selectedLiquiditySource: LiquiditySource.LIFI,
          }),
          reason:
            '1inch execution received an unexpected approved source for Aggregator Execution Pool/0xBorrower',
        },
        {
          quoteEvaluation: calldataAggregatorEvaluation({
            calldataQuote: undefined,
          }),
          reason:
            '1inch execution is missing validated route details for Aggregator Execution Pool/0xBorrower',
        },
        {
          quoteEvaluation: calldataAggregatorEvaluation({
            calldataQuote: calldataQuote({ providerId: 'lifi' }),
          }),
          reason:
            '1inch execution received a quote from provider lifi for Aggregator Execution Pool/0xBorrower',
        },
        {
          quoteEvaluation: calldataAggregatorEvaluation({
            routeMinOutRaw: undefined,
            profitMinOutRaw: undefined,
            routeExecutionFloorRaw: undefined,
            approvedMinOutRaw: undefined,
          }),
          reason:
            '1inch execution is missing approved min-out floor for Aggregator Execution Pool/0xBorrower',
        },
      ];

      for (const { quoteEvaluation, reason } of cases) {
        expect(approve(quoteEvaluation)).to.deep.equal({
          approved: false,
          reason,
        });
      }
    });

    it('rejects calldata aggregator quotes with non-zero or unparseable native value', () => {
      for (const txValue of ['1', 'not-a-number']) {
        const approval = approve(
          calldataAggregatorEvaluation({
            calldataQuote: calldataQuote({ txValue }),
          })
        );

        expect(approval).to.deep.equal({
          approved: false,
          reason: `1inch execution requires a zero native value but got txValue=${txValue} for Aggregator Execution Pool/0xBorrower`,
        });
      }
    });

    it('accepts zero-equivalent calldata aggregator native values', () => {
      for (const txValue of [undefined, null, '', '0x0', '0x00']) {
        const approval = approve(
          calldataAggregatorEvaluation({
            calldataQuote: calldataQuote({
              txValue: txValue as ApprovedCalldataAggregatorQuote['txValue'],
            }),
          })
        );

        expect(approval.approved).to.equal(true);
      }
    });
  });

  describe('approveDirectDexQuoteForExecution', () => {
    function approve(quoteEvaluation: ExternalTakeQuoteEvaluation) {
      return approveDirectDexQuoteForExecution({
        quoteEvaluation,
        poolName: 'Direct DEX Execution Pool',
        borrower: '0xBorrower',
      });
    }

    it('approves bounded Uniswap and Curve direct DEX routes', () => {
      const uniswapApproval = approve(
        directDexEvaluation({
          routeExecutionFloorRaw: undefined,
          routeMinOutRaw: BigNumber.from(151),
        })
      );
      expect(uniswapApproval.approved).to.equal(true);
      if (!uniswapApproval.approved) {
        throw new Error(`expected Uniswap approval: ${uniswapApproval.reason}`);
      }
      expect(uniswapApproval.quoteEvaluation.selectedLiquiditySource).to.equal(
        LiquiditySource.UNISWAPV3
      );
      expect(uniswapApproval.quoteEvaluation.approvedMinOutRaw.eq(151)).to.equal(
        true
      );

      const curveApproval = approve(
        directDexEvaluation({
          selectedLiquiditySource: LiquiditySource.CURVE,
          selectedFeeTier: undefined,
          curvePool,
          routeExecutionFloorRaw: BigNumber.from(175),
          routeMinOutRaw: BigNumber.from(150),
        })
      );
      expect(curveApproval.approved).to.equal(true);
      if (!curveApproval.approved) {
        throw new Error(`expected Curve approval: ${curveApproval.reason}`);
      }
      expect(curveApproval.quoteEvaluation.selectedLiquiditySource).to.equal(
        LiquiditySource.CURVE
      );
      expect(curveApproval.quoteEvaluation.approvedMinOutRaw.eq(175)).to.equal(
        true
      );
    });

    it('rejects direct DEX execution routes that are no longer safe to execute', () => {
      const cases: Array<{
        quoteEvaluation: ExternalTakeQuoteEvaluation;
        reason: string;
      }> = [
        {
          quoteEvaluation: directDexEvaluation({
            isTakeable: false,
            reason: 'route stale',
          }),
          reason:
            'Direct DEX: Take quote no longer satisfies execution policy for Direct DEX Execution Pool/0xBorrower: route stale',
        },
        {
          quoteEvaluation: directDexEvaluation({
            isTakeable: false,
            reason: undefined,
          }),
          reason:
            'Direct DEX: Take quote no longer satisfies execution policy for Direct DEX Execution Pool/0xBorrower: not takeable',
        },
        {
          quoteEvaluation: directDexEvaluation({
            quoteAmountRaw: undefined,
          }),
          reason:
            'Direct DEX: Missing raw quote amount for Direct DEX Execution Pool/0xBorrower; refusing to send an unbounded swap',
        },
        {
          quoteEvaluation: calldataAggregatorEvaluation(),
          reason:
            'Direct DEX: Received non-direct_dex approved path for Direct DEX Execution Pool/0xBorrower; refusing to execute an unbound route',
        },
        {
          quoteEvaluation: directDexEvaluation({
            routeMinOutRaw: undefined,
            profitMinOutRaw: undefined,
            routeExecutionFloorRaw: undefined,
            approvedMinOutRaw: undefined,
          }),
          reason:
            'Direct DEX: Missing approved min-out floor for Direct DEX Execution Pool/0xBorrower; refusing to execute an unbound swap',
        },
        {
          quoteEvaluation: directDexEvaluation({
            selectedFeeTier: undefined,
          }),
          reason:
            'Direct DEX: Missing selected fee tier for Direct DEX Execution Pool/0xBorrower; refusing to execute an unbound route',
        },
        {
          quoteEvaluation: directDexEvaluation({
            selectedLiquiditySource: LiquiditySource.CURVE,
            selectedFeeTier: undefined,
            curvePool: undefined,
          }),
          reason:
            'Direct DEX: Missing selected Curve pool for Direct DEX Execution Pool/0xBorrower; refusing to execute an unbound route',
        },
      ];

      for (const { quoteEvaluation, reason } of cases) {
        expect(approve(quoteEvaluation)).to.deep.equal({
          approved: false,
          reason,
        });
      }
    });

    it('rejects direct DEX discovery binding without safe route metadata', () => {
      const cases: Array<{
        quoteEvaluation: ExternalTakeQuoteEvaluation;
        reason: string;
      }> = [
        {
          quoteEvaluation: directDexEvaluation({
            isTakeable: false,
            reason: 'route stale',
          }),
          reason:
            'external take quote no longer satisfies discovery policy for Direct DEX Discovery Pool/0xBorrower: route stale',
        },
        {
          quoteEvaluation: directDexEvaluation({
            isTakeable: false,
            reason: undefined,
          }),
          reason:
            'external take quote no longer satisfies discovery policy for Direct DEX Discovery Pool/0xBorrower: not takeable',
        },
        {
          quoteEvaluation: directDexEvaluation({
            quoteAmountRaw: undefined,
          }),
          reason:
            'external take quote is missing raw quote amount for Direct DEX Discovery Pool/0xBorrower',
        },
        {
          quoteEvaluation: directDexEvaluation({
            routeMinOutRaw: undefined,
            profitMinOutRaw: undefined,
            routeExecutionFloorRaw: undefined,
            approvedMinOutRaw: undefined,
          }),
          reason:
            'external take quote is missing route execution floor for Direct DEX Discovery Pool/0xBorrower',
        },
        {
          quoteEvaluation: directDexEvaluation({
            selectedFeeTier: undefined,
          }),
          reason:
            'Direct DEX: Missing selected fee tier for Direct DEX Discovery Pool/0xBorrower; refusing to bind an unbound route',
        },
        {
          quoteEvaluation: directDexEvaluation({
            selectedLiquiditySource: LiquiditySource.CURVE,
            selectedFeeTier: undefined,
            curvePool: undefined,
          }),
          reason:
            'Direct DEX: Missing selected Curve pool for Direct DEX Discovery Pool/0xBorrower; refusing to bind an unbound route',
        },
      ];

      for (const { quoteEvaluation, reason } of cases) {
        expect(
          bindExternalTakeRouteForDiscovery({
            quoteEvaluation,
            poolName: 'Direct DEX Discovery Pool',
            borrower: '0xBorrower',
          })
        ).to.deep.equal({
          bound: false,
          reason,
        });
      }
    });
  });
});
