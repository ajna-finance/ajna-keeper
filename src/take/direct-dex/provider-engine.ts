import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { NonceTracker } from '../../nonce';
import {
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import { estimateGasWithBuffer, weiToDecimaled } from '../../utils';
import { TakerRouter__factory } from '../../../typechain-types';
import { DirectDexRouteEvaluationContext } from './route-types';
import {
  buildDirectDexQuoteEvaluation,
  getSlippageFloorQuoteRaw,
} from './route-amounts';
import {
  formatDirectDexPriceCheckLog,
  formatDirectDexTakeSubmissionLog,
} from './logs';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';
import { logTakeExecutionTelemetry } from '../execution-telemetry';

type TakerRouter = ReturnType<typeof TakerRouter__factory.connect>;

/**
 * Shared EVALUATE tail. Runs after each provider has fetched its quote and
 * produced a raw quote amount (BigNumber) + collateralAmount. Captures the
 * byte-identical block: quoteAmount/auctionPrice computation, the
 * invalid-amounts guard, the marketPriceFactor guard, the
 * buildDirectDexQuoteEvaluation call, and the formatDirectDexPriceCheckLog
 * debug. Returns the bare ExternalTakeQuoteEvaluation; the Curve caller adds
 * `curvePool` by spreading the result at its own call site.
 */
export async function finalizeDirectDexQuoteEvaluation(params: {
  pool: FungiblePool;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  poolConfig: TakeActionConfig;
  marketPriceFactor: number | undefined;
  context: DirectDexRouteEvaluationContext;
  quoteAmountRaw: BigNumber;
  collateralAmount: number;
  source: LiquiditySource;
  slippageSource: number | undefined;
  invalidAmountsReason: string;
  failureReason: string;
  selectedFeeTier?: number;
}): Promise<ExternalTakeQuoteEvaluation> {
  const {
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    context,
    quoteAmountRaw,
    collateralAmount,
    source,
    slippageSource,
    invalidAmountsReason,
    failureReason,
    selectedFeeTier,
  } = params;

  const quoteAmount = Number(
    ethers.utils.formatUnits(quoteAmountRaw, context.quoteTokenDecimals)
  );
  const auctionPrice = Number(weiToDecimaled(auctionPriceWad));

  if (collateralAmount <= 0 || quoteAmount <= 0) {
    logger.debug(
      `Direct DEX: Invalid amounts - collateral: ${collateralAmount}, quote: ${quoteAmount} for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: invalidAmountsReason,
    };
  }

  const marketPriceFactor = params.marketPriceFactor;
  if (!marketPriceFactor) {
    logger.debug(
      `Direct DEX: No marketPriceFactor configured for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'marketPriceFactor is not configured',
    };
  }

  const evaluation = await buildDirectDexQuoteEvaluation({
    pool,
    auctionPriceWad,
    collateral,
    marketPriceFactor,
    quoteAmountRaw,
    quoteAmount,
    collateralAmount,
    selectedLiquiditySource: source,
    selectedFeeTier,
    existingSlippageFloorQuoteRaw: getSlippageFloorQuoteRaw(
      quoteAmountRaw,
      slippageSource
    ),
    allowSubsidy: poolConfig.take.allowSubsidy === true,
    routeContext: context,
    failureReason,
  });

  logger.debug(
    formatDirectDexPriceCheckLog({
      source,
      poolName: pool.name,
      auctionPrice,
      marketPrice: evaluation.marketPrice,
      takeablePrice: evaluation.takeablePrice,
      feeTier: selectedFeeTier,
      profitable: evaluation.isTakeable,
    })
  );

  return evaluation;
}

/**
 * Shared EXECUTE submission mechanics. Runs after each provider has resolved
 * its config, computed amountOutMinimum + deadline, resolved its swap target,
 * and ABI-encoded its swapDetails. Captures the byte-identical block:
 * formatDirectDexTakeSubmissionLog, the optional Curve execution delay, the
 * entire NonceTracker.queueTransaction body (txArgs, estimateGasWithBuffer,
 * populateTransaction.takeWithAtomicSwap, submitTakeTransaction),
 * logTakeExecutionTelemetry, and the success logger.info.
 *
 * The try/catch that reports onDirectDexExecutionFailure stays in each provider
 * (it must also cover the per-source head), so this helper is catch-free and
 * signals the pre/post-broadcast boundary through `onAttempted`, invoked the
 * moment the transaction is actually submitted.
 */
export async function submitDirectDexTake(params: {
  pool: FungiblePool;
  signer: Signer;
  liquidation: TakeLiquidationPlan;
  router: TakerRouter;
  takeWriteTransport: ReturnType<typeof resolveTakeWriteTransport>;
  source: LiquiditySource;
  swapTarget: string;
  encodedSwapDetails: string;
  estimateGasLabel: string;
  telemetryExtra: { selectedFeeTier?: number; curvePoolAddress?: string };
  routeProfitability: ExternalTakeQuoteEvaluation['routeProfitability'];
  approvedMinOutRaw: BigNumber;
  successVerb: string;
  onAttempted: () => void;
  executionDelayMs?: number;
}): Promise<void> {
  const {
    pool,
    liquidation,
    router,
    takeWriteTransport,
    source,
    swapTarget,
    encodedSwapDetails,
    estimateGasLabel,
    telemetryExtra,
    routeProfitability,
    approvedMinOutRaw,
    successVerb,
    onAttempted,
    executionDelayMs,
  } = params;

  logger.debug(
    formatDirectDexTakeSubmissionLog({
      source,
      poolAddress: pool.poolAddress,
      borrower: liquidation.borrower,
    })
  );

  if (executionDelayMs !== undefined && executionDelayMs > 0) {
    logger.debug(
      `Adding ${executionDelayMs}ms Curve execution delay before direct DEX take`
    );
    await new Promise((resolve) => setTimeout(resolve, executionDelayMs));
  }

  const receipt = await NonceTracker.queueTransaction(
    takeWriteTransport.signer,
    async (nonce: number) => {
      const txArgs = [
        pool.poolAddress,
        liquidation.borrower,
        liquidation.auctionPrice,
        liquidation.collateral,
        Number(source),
        swapTarget,
        encodedSwapDetails,
      ] as const;
      const gasLimit = await estimateGasWithBuffer(
        () => router.estimateGas.takeWithAtomicSwap(...txArgs),
        estimateGasLabel,
        13000
      );
      const txRequest = await router.populateTransaction.takeWithAtomicSwap(
        ...txArgs,
        {
          gasLimit,
          nonce: nonce.toString(),
        }
      );
      return await submitTakeTransaction(takeWriteTransport, txRequest, () => {
        onAttempted();
      });
    }
  );
  logTakeExecutionTelemetry({
    path: 'direct_dex',
    source,
    poolName: pool.name,
    poolAddress: pool.poolAddress,
    borrower: liquidation.borrower,
    receipt,
    routeProfitability,
    approvedMinOutRaw,
    ...telemetryExtra,
    takeWriteTransport,
  });

  logger.info(
    `Direct DEX ${successVerb} Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
  );
}
