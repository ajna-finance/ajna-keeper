import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../../src/config';
import { ExternalTakeQuoteEvaluation } from '../../../src/take/types';

export function buildTakeableOneInchQuote(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  const quoteAmountRaw = overrides.quoteAmountRaw ?? BigNumber.from(10);
  const approvedMinOutRaw =
    overrides.approvedMinOutRaw ??
    overrides.routeMinOutRaw ??
    BigNumber.from(10);
  const routeMinOutRaw = overrides.routeMinOutRaw ?? approvedMinOutRaw;
  const routeExecutionFloorRaw =
    overrides.routeExecutionFloorRaw ?? routeMinOutRaw;
  const calldataQuote = {
    providerId: 'oneinch' as const,
    quotedAtMs: Date.now(),
    chainId: 1,
    srcToken: '0x3333333333333333333333333333333333333333',
    dstToken: '0x2222222222222222222222222222222222222222',
    dstReceiver: '0x4444444444444444444444444444444444444444',
    amountInTokenUnits: BigNumber.from(1),
    quoteAmountRaw,
    routeMinOutRaw,
    transactionTarget: '0x5555555555555555555555555555555555555555',
    approvalSpender: '0x6666666666666666666666666666666666666666',
    callData: '0x12345678',
    selector: '0x12345678',
    txValue: '0',
    routeSummary: {
      providerId: 'oneinch' as const,
      tool: '1inch',
      feeCosts: [],
    },
    ...(overrides.calldataQuote ?? {}),
  };
  return {
    isTakeable: true,
    externalTakePath: 'calldata_aggregator',
    providerId: 'oneinch',
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    quoteAmount: 10,
    quoteAmountRaw,
    routeMinOutRaw,
    routeExecutionFloorRaw,
    approvedMinOutRaw,
    collateralAmount: 1,
    marketPrice: 10,
    takeablePrice: 12,
    ...overrides,
    calldataQuote,
  };
}
