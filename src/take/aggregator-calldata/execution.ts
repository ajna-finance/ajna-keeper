import { BigNumber, ethers } from 'ethers';
import { TakerRouter__factory } from '../../../typechain-types/factories/contracts/factories';
import { CalldataAggregatorProviderId, LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { NonceTracker } from '../../nonce';
import { estimateGasWithBuffer } from '../../utils';
import { logTakeExecutionTelemetry } from '../execution-telemetry';
import {
  ApprovedCalldataAggregatorQuoteEvaluation,
  RouteProfitabilityBreakdown,
  TakeLiquidationPlan,
} from '../types';
import { TakeWriteTransport, submitTakeTransaction } from '../write-transport';
import { ApprovedCalldataAggregatorQuote } from './types';

/**
 * Provider-neutral calldata-aggregator execution core (Packet 2B). These
 * helpers consume ONLY normalized provider output
 * (ApprovedCalldataAggregatorQuote); they never see raw provider responses.
 * Provider wrappers own API requests, parsing, normalization, and
 * provider-labeled callbacks, then delegate execution mechanics here.
 */

export type AggregatorTakerFactory = ReturnType<
  typeof TakerRouter__factory.connect
>;

/**
 * Encodes the shared on-chain AggregatorSwapDetails tuple consumed by
 * BaseAggregatorCalldataTaker. The amountOutMinimum is the keeper's approved
 * execution floor, not the provider's route minimum.
 */
export function encodeAggregatorSwapDetails(params: {
  quote: Pick<
    ApprovedCalldataAggregatorQuote,
    | 'approvalSpender'
    | 'srcToken'
    | 'dstToken'
    | 'dstReceiver'
    | 'amountInTokenUnits'
    | 'callData'
  >;
  amountOutMinimum: BigNumber;
}): string {
  return ethers.utils.defaultAbiCoder.encode(
    [
      'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)',
    ],
    [
      {
        approvalSpender: params.quote.approvalSpender,
        srcToken: params.quote.srcToken,
        dstToken: params.quote.dstToken,
        dstReceiver: params.quote.dstReceiver,
        amountInTokenUnits: params.quote.amountInTokenUnits,
        amountOutMinimum: params.amountOutMinimum,
        callData: params.quote.callData,
      },
    ]
  );
}

/** Execution-quote freshness check against the provider's quote timestamp. */
export function getAggregatorQuoteAgeError(params: {
  quote: Pick<ApprovedCalldataAggregatorQuote, 'quotedAtMs'>;
  maxQuoteAgeMs: number;
  label: string;
}): string | undefined {
  if (Date.now() - params.quote.quotedAtMs > params.maxQuoteAgeMs) {
    return `${params.label} fresh quote exceeded maxQuoteAgeMs`;
  }
  return undefined;
}

/**
 * Revalidates the approved quote context against the current liquidation:
 * the quoted collateral and auction price must match what execution is about
 * to take, or the quote must be re-derived.
 */
export function getAggregatorQuoteContextMismatch(params: {
  quoteEvaluation: ApprovedCalldataAggregatorQuoteEvaluation;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice'>;
  executionCollateralWad: BigNumber;
  label: string;
}): string | undefined {
  if (
    params.quoteEvaluation.quotedCollateralWad !== undefined &&
    !params.quoteEvaluation.quotedCollateralWad.eq(
      params.executionCollateralWad
    )
  ) {
    return `${params.label} approved quote collateral does not match current liquidation collateral`;
  }
  if (
    params.quoteEvaluation.quotedAuctionPriceWad !== undefined &&
    !params.quoteEvaluation.quotedAuctionPriceWad.eq(
      params.liquidation.auctionPrice
    )
  ) {
    return `${params.label} approved quote auction price does not match current liquidation auction price`;
  }
  return undefined;
}

/**
 * Final min-out floor comparison for a freshly re-fetched execution quote:
 * both the expected output and the route minimum must clear the approved
 * execution floor (which already prices the ceil-rounded Ajna quote due).
 */
export function getAggregatorFreshQuoteFloorError(params: {
  freshQuote: Pick<
    ApprovedCalldataAggregatorQuote,
    'quoteAmountRaw' | 'routeMinOutRaw'
  >;
  approvedMinOutRaw: BigNumber;
  label: string;
}): string | undefined {
  if (params.freshQuote.quoteAmountRaw.lt(params.approvedMinOutRaw)) {
    return `${params.label} fresh quote expected output below execution floor`;
  }
  if (params.freshQuote.routeMinOutRaw.lt(params.approvedMinOutRaw)) {
    return `${params.label} fresh quote min output below execution floor`;
  }
  return undefined;
}

/**
 * Submits a calldata-aggregator take through the configured take write
 * transport: nonce queueing, buffered gas estimation, transaction
 * population, freshness re-assertion before every irreversible step, and
 * provider-id-aware execution telemetry.
 */
export async function submitCalldataAggregatorTake(params: {
  factory: AggregatorTakerFactory;
  takeWriteTransport: TakeWriteTransport;
  poolName: string;
  poolAddress: string;
  borrower: string;
  auctionPrice: BigNumber;
  executionCollateralWad: BigNumber;
  liquiditySource: LiquiditySource;
  providerId: CalldataAggregatorProviderId;
  label: string;
  transactionTarget: string;
  swapDetails: string;
  routeProfitability?: RouteProfitabilityBreakdown;
  approvedMinOutRaw: BigNumber;
  assertFreshQuoteStillCurrent: () => void;
  onQuoteConsumed?: () => void;
  onSubmissionAccepted: () => void;
}): Promise<void> {
  await NonceTracker.queueTransaction(
    params.takeWriteTransport.signer,
    async (nonce: number) => {
      params.assertFreshQuoteStillCurrent();
      const txArgs = [
        params.poolAddress,
        params.borrower,
        params.auctionPrice,
        params.executionCollateralWad,
        Number(params.liquiditySource),
        params.transactionTarget,
        params.swapDetails,
      ] as const;
      const gasLimit = await estimateGasWithBuffer(
        () => params.factory.estimateGas.takeWithAtomicSwap(...txArgs),
        `${params.label} Take ${params.poolName}/${params.borrower}`,
        13000
      );
      params.assertFreshQuoteStillCurrent();
      const txRequest =
        await params.factory.populateTransaction.takeWithAtomicSwap(...txArgs, {
          gasLimit,
          nonce: nonce.toString(),
        });
      params.assertFreshQuoteStillCurrent();
      params.onQuoteConsumed?.();
      const receipt = await submitTakeTransaction(
        params.takeWriteTransport,
        txRequest,
        params.onSubmissionAccepted
      );
      logTakeExecutionTelemetry({
        path: 'calldata_aggregator',
        providerId: params.providerId,
        source: params.liquiditySource,
        poolName: params.poolName,
        poolAddress: params.poolAddress,
        borrower: params.borrower,
        receipt,
        routeProfitability: params.routeProfitability,
        approvedMinOutRaw: params.approvedMinOutRaw,
        takeWriteTransport: params.takeWriteTransport,
      });
      logger.info(
        `${params.label} Take successful - pool: ${params.poolName}, borrower: ${params.borrower} | tx: ${receipt.transactionHash}`
      );
      return receipt;
    }
  );
}
