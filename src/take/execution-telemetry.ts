import { BigNumber, providers } from 'ethers';
import { LiquiditySource } from '../config';
import { logger } from '../logging';
import { RouteProfitabilityBreakdown } from './types';
import { TakeWriteTransport } from './write-transport';

const BASIS_POINTS_DENOMINATOR = BigNumber.from(10_000);
const OBSERVED_GAS_DIVERGENCE_WARNING_BPS = 2_000;

function formatLiquiditySource(source: LiquiditySource | undefined): string {
  return source !== undefined
    ? (LiquiditySource[source] ?? String(source))
    : 'n/a';
}

function computeDivergenceBasisPoints(params: {
  expected: BigNumber;
  observed: BigNumber;
}): number | undefined {
  if (params.expected.isZero()) {
    return undefined;
  }
  const delta = params.expected.gt(params.observed)
    ? params.expected.sub(params.observed)
    : params.observed.sub(params.expected);
  return delta.mul(BASIS_POINTS_DENOMINATOR).div(params.expected).toNumber();
}

export function logTakeExecutionTelemetry(params: {
  path: 'oneinch' | 'factory';
  source?: LiquiditySource;
  poolName: string;
  poolAddress: string;
  borrower: string;
  receipt: providers.TransactionReceipt;
  routeProfitability?: RouteProfitabilityBreakdown;
  approvedMinOutRaw?: BigNumber;
  selectedFeeTier?: number;
  curvePoolAddress?: string;
  takeWriteTransport?: TakeWriteTransport;
}): void {
  const observedGasUsed = params.receipt.gasUsed;
  const routeGasLimit = params.routeProfitability?.routeGasLimit;
  const divergenceBps =
    routeGasLimit !== undefined && observedGasUsed !== undefined
      ? computeDivergenceBasisPoints({
          expected: routeGasLimit,
          observed: observedGasUsed,
        })
      : undefined;
  const message =
    `Take execution telemetry: path=${params.path}` +
    ` source=${formatLiquiditySource(params.source)}` +
    ` pool=${params.poolAddress}` +
    ` poolName="${params.poolName}"` +
    ` borrower=${params.borrower}` +
    ` tx=${params.receipt.transactionHash}` +
    ` gasUsed=${observedGasUsed?.toString() ?? 'n/a'}` +
    ` routeGasEstimate=${routeGasLimit?.toString() ?? 'n/a'}` +
    ` gasDivergenceBps=${divergenceBps ?? 'n/a'}` +
    ` writeTransport=${params.takeWriteTransport?.mode ?? 'public_rpc'}` +
    ` feeTier=${params.selectedFeeTier ?? 'n/a'}` +
    ` curvePool=${params.curvePoolAddress ?? 'n/a'}` +
    ` approvedMinOutRaw=${params.approvedMinOutRaw?.toString() ?? 'n/a'}` +
    ` expectedNetProfitRaw=${params.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'}`;

  if (
    divergenceBps !== undefined &&
    divergenceBps > OBSERVED_GAS_DIVERGENCE_WARNING_BPS
  ) {
    logger.warn(message);
    return;
  }

  logger.debug(message);
}
