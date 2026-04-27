import { BigNumber, providers, utils } from 'ethers';
import { LiquiditySource, formatLiquiditySource } from '../config';
import { logger } from '../logging';
import { RouteProfitabilityBreakdown } from './types';
import { TakeWriteTransport } from './write-transport';
import { BASIS_POINTS_DENOMINATOR_BN } from '../constants';

export const TAKE_EXECUTION_TELEMETRY_VERSION = 1;
// Warn when observed execution gas diverges materially from route policy input.
const OBSERVED_GAS_DIVERGENCE_WARNING_BPS = 2_000;

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
  return delta.mul(BASIS_POINTS_DENOMINATOR_BN).div(params.expected).toNumber();
}

function formatBorrowerTelemetryId(borrower: string): string {
  const normalized = utils.isAddress(borrower)
    ? utils.getAddress(borrower).toLowerCase()
    : borrower.toLowerCase();
  const hash = utils.keccak256(utils.toUtf8Bytes(normalized));
  return hash.slice(0, 18);
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
    `Take execution telemetry: version=${TAKE_EXECUTION_TELEMETRY_VERSION}` +
    ` path=${params.path}` +
    ` source=${formatLiquiditySource(params.source)}` +
    ` pool=${params.poolAddress}` +
    ` poolName="${params.poolName}"` +
    ` borrowerHash=${formatBorrowerTelemetryId(params.borrower)}` +
    ` tx=${params.receipt.transactionHash}` +
    ` gasUsed=${observedGasUsed?.toString() ?? 'n/a'}` +
    ` routeGasEstimate=${routeGasLimit?.toString() ?? 'n/a'}` +
    ` gasDivergenceBps=${divergenceBps ?? 'n/a'}` +
    ` writeTransport=${params.takeWriteTransport?.mode ?? 'public_rpc'}` +
    ` feeTier=${params.selectedFeeTier ?? 'n/a'}` +
    ` curvePool=${params.curvePoolAddress ?? 'n/a'}` +
    ` approvedMinOutRaw=${params.approvedMinOutRaw?.toString() ?? 'n/a'}` +
    ` expectedNetProfitRaw=${params.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'}` +
    ` expectedShortfallRaw=${params.routeProfitability?.expectedShortfallQuoteRaw?.toString() ?? 'n/a'}`;

  if (
    divergenceBps !== undefined &&
    divergenceBps > OBSERVED_GAS_DIVERGENCE_WARNING_BPS
  ) {
    logger.warn(message);
    return;
  }

  logger.debug(message);
}
