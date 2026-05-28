import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../src/config';
import type { ApprovedLifiQuote } from '../../src/dex/lifi';
import type { DiscoveredTakeTargetStats } from '../../src/discovery/take-executor';
import type {
  DiscoveryExecutionConfig,
  ExternalProviderCircuits,
} from '../../src/discovery/types';
import type {
  ApprovedExternalTakeQuoteEvaluation,
  ApprovedLifiQuoteEvaluation,
  ExternalTakeStrategyKind,
} from '../../src/take/types';

type Expect<T extends true> = T;
type IsAssignable<T, U> = T extends U ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type _LifiQuoteIsApprovedExternalTake = Expect<
  IsAssignable<ApprovedLifiQuoteEvaluation, ApprovedExternalTakeQuoteEvaluation>
>;
type _LifiDoesNotBecomeExecutionStrategy = Expect<
  IsAssignable<'lifi', ExternalTakeStrategyKind> extends false ? true : false
>;
type _HybridRemainsExecutionStrategy = Expect<
  IsAssignable<'hybrid', ExternalTakeStrategyKind>
>;
type _LifiCircuitPurposesStayTyped = Expect<
  IsEqual<
    keyof NonNullable<ExternalProviderCircuits['lifi']>,
    'route_quote' | 'execution_refresh'
  >
>;
type _OneInchCircuitPurposesStayTyped = Expect<
  IsEqual<
    keyof NonNullable<ExternalProviderCircuits['oneinch']>,
    'route_quote' | 'swap_data' | 'gas_conversion'
  >
>;
type _StatsAllowLifiProviderPath = Expect<
  IsAssignable<'lifi', keyof DiscoveredTakeTargetStats['externalTakeByPath']>
>;
type _StatsDoNotAddFlatLifiCounters = Expect<
  Extract<
    keyof DiscoveredTakeTargetStats,
    | `approvedLifi${string}`
    | `executedLifi${string}`
    | `dryRunLifi${string}`
    | `lifi${string}Failure${string}`
  > extends never
    ? true
    : false
>;

function makeApprovedLifiQuote(): ApprovedLifiQuote {
  return {
    raw: {} as any,
    quoteAmountRaw: BigNumber.from(125),
    routeMinOutRaw: BigNumber.from(123),
    amountInTokenUnits: BigNumber.from(1),
    srcToken: '0x1111111111111111111111111111111111111111',
    dstToken: '0x2222222222222222222222222222222222222222',
    dstReceiver: '0x3333333333333333333333333333333333333333',
    approvalSpender: '0x4444444444444444444444444444444444444444',
    transactionTarget: '0x5555555555555555555555555555555555555555',
    transactionRequest: {
      to: '0x5555555555555555555555555555555555555555',
      data: '0xabcdef12',
      value: '0',
      from: '0x3333333333333333333333333333333333333333',
      chainId: 8453,
    },
    tool: 'uniswap',
    topLevelTool: 'lifi',
    feeCosts: [],
    selector: '0xabcdef12',
    quotedAtMs: 1,
  };
}

describe('LI.FI type surface', () => {
  it('keeps LI.FI as an external take path without adding a strategy kind', () => {
    const approvedLifiQuote = {
      isTakeable: true,
      externalTakePath: 'lifi',
      quoteAmountRaw: BigNumber.from(125),
      selectedLiquiditySource: LiquiditySource.LIFI,
      approvedMinOutRaw: BigNumber.from(123),
      lifiQuote: makeApprovedLifiQuote(),
    } satisfies ApprovedLifiQuoteEvaluation;
    const approvedExternalQuote: ApprovedExternalTakeQuoteEvaluation =
      approvedLifiQuote;
    const executionConfig = {
      lifiTaker: '0x3333333333333333333333333333333333333333',
      lifi: {
        mode: 'production',
        allowExchanges: ['uniswap'],
        callTargetAllowlist: {
          8453: ['0x5555555555555555555555555555555555555555'],
        },
        approvalSpenderAllowlist: {
          8453: ['0x4444444444444444444444444444444444444444'],
        },
        selectorAllowlist: {
          8453: {
            '0x5555555555555555555555555555555555555555': ['0xabcdef12'],
          },
        },
      },
    } satisfies DiscoveryExecutionConfig;
    const providerCircuits = {
      oneinch: {
        route_quote: { failures: 0 },
        swap_data: { failures: 1 },
        gas_conversion: { failures: 0 },
      },
      lifi: {
        route_quote: { failures: 1 },
        execution_refresh: { failures: 0 },
      },
    } satisfies ExternalProviderCircuits;
    const providerStats = {
      externalTakeByPath: {
        lifi: {
          approved: 1,
          executed: 0,
          dryRun: 0,
          preBroadcastFailures: 1,
          postSubmissionFailures: 0,
        },
      },
    } satisfies Pick<DiscoveredTakeTargetStats, 'externalTakeByPath'>;

    expect(approvedExternalQuote.externalTakePath).to.equal('lifi');
    expect(executionConfig.lifiTaker).to.equal(
      '0x3333333333333333333333333333333333333333'
    );
    expect(providerCircuits.lifi.route_quote.failures).to.equal(1);
    expect(providerCircuits.oneinch.swap_data.failures).to.equal(1);
    expect(providerStats.externalTakeByPath.lifi.approved).to.equal(1);
  });
});
