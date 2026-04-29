import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { logger } from '../logging';
import { SubgraphReader } from '../read-transports';
import {
  delay,
  getErrorMessage,
  mapWithConcurrencyPreservingOrder,
  weiToDecimaled,
} from '../utils';
import { ArbTakeStrategy } from './arb-strategy';
import { TakeWriteTransport } from './write-transport';
import {
  ArbTakeEvaluation,
  ExternalTakeQuoteEvaluation,
  ExternalTakeStrategyKind,
  TakeActionConfig,
  TakeBorrowerCandidate,
  TakeDecision,
  TakeExecutionResult,
  TakeLiquidationPlan,
} from './types';
import {
  TakeAuctionStatus,
  TakeAuctionStatusReader,
  defaultTakeAuctionStatusReader,
  normalizeBorrowerKey,
} from './liquidation-status';

export const TAKE_SKIP_REASONS = {
  auctionInactive: 'auction no longer has collateral onchain',
  auctionStateChanged: 'onchain revalidation changed the auction state',
  quoteCollateralMismatch:
    'approved external take quote no longer matches collateral',
  quoteAuctionPriceStale:
    'approved external take quote is stale after auction price increased',
} as const;

export interface ExternalTakeAdapter<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
> {
  kind: ExternalTakeStrategyKind;
  evaluateExternalTake?: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
  }) => Promise<ExternalTakeQuoteEvaluation>;
  executeExternalTake?: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    liquidation: TakeLiquidationPlan;
    config: TExecutionConfig;
  }) => Promise<boolean | void>;
}

/**
 * Shared candidate loop for independently configured take strategies.
 *
 * ExternalTakeAdapter represents routes that swap collateral through external
 * liquidity. ArbTakeStrategy represents Ajna-native arbTake execution. The
 * engine may approve both for one auction, but always attempts the external
 * route first because it usually becomes profitable earlier and repays debt
 * against external market liquidity before falling back to arbTake.
 */

interface TakeApprovalResult {
  approved: boolean;
  reason?: string;
  quoteEvaluation?: ExternalTakeQuoteEvaluation;
}

interface EvaluateTakeDecisionParams<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
> {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TPoolConfig;
  candidate: TakeBorrowerCandidate;
  subgraph: SubgraphReader;
  externalTakeAdapter: ExternalTakeAdapter<TPoolConfig, TExecutionConfig>;
  arbTakeStrategy: ArbTakeStrategy<TPoolConfig>;
  takeAuctionStatusReader?: TakeAuctionStatusReader;
  auctionStatus?: TakeAuctionStatus;
  approveExternalTake?: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    candidate: TakeBorrowerCandidate;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
    quoteEvaluation: ExternalTakeQuoteEvaluation;
  }) => Promise<TakeApprovalResult>;
  approveArbTake?: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    candidate: TakeBorrowerCandidate;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
    arbEvaluation: ArbTakeEvaluation;
  }) => Promise<TakeApprovalResult>;
}

interface ExecuteTakeDecisionParams<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
> {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TPoolConfig;
  decision: TakeDecision;
  externalTakeAdapter: ExternalTakeAdapter<TPoolConfig, TExecutionConfig>;
  externalExecutionConfig: TExecutionConfig;
  subgraph: SubgraphReader;
  dryRun: boolean;
  delayBetweenActions: number;
  arbTakeStrategy: ArbTakeStrategy<TPoolConfig>;
  takeAuctionStatusReader?: TakeAuctionStatusReader;
  revalidateBeforeExecution?: boolean;
  reapproveExternalTakeBeforeExecution?: EvaluateTakeDecisionParams<
    TPoolConfig,
    TExecutionConfig
  >['approveExternalTake'];
  onSkip?: (params: {
    candidate: TakeBorrowerCandidate;
    stage: 'evaluation' | 'revalidation' | 'execution';
    reason: string;
    decision?: TakeDecision;
  }) => void;
  onExecuted?: (params: {
    decision: TakeDecision;
    executedTake: boolean;
    executedArbTake: boolean;
  }) => void;
  takeWriteTransport?: TakeWriteTransport;
}

interface ProcessTakeCandidatesParams<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
> extends Omit<
      EvaluateTakeDecisionParams<TPoolConfig, TExecutionConfig>,
      | 'candidate'
      | 'approveExternalTake'
      | 'approveArbTake'
      | 'externalTakeAdapter'
      | 'arbTakeStrategy'
    >,
    Pick<
      ExecuteTakeDecisionParams<TPoolConfig, TExecutionConfig>,
      | 'externalExecutionConfig'
      | 'dryRun'
      | 'delayBetweenActions'
      | 'revalidateBeforeExecution'
      | 'onSkip'
      | 'onExecuted'
      | 'takeWriteTransport'
    > {
  candidates: TakeBorrowerCandidate[];
  candidateStatuses?: Map<string, TakeAuctionStatus>;
  stopAfterExecution?: boolean;
  maxConcurrentCandidateEvaluations?: number;
  resetExternalTakeAttemptSubmission?: () => void;
  didExternalTakeAttemptSubmission?: () => boolean;
  externalTakeAdapter: ExternalTakeAdapter<TPoolConfig, TExecutionConfig>;
  arbTakeStrategy: ArbTakeStrategy<TPoolConfig>;
  approveExternalTake?: EvaluateTakeDecisionParams<
    TPoolConfig,
    TExecutionConfig
  >['approveExternalTake'];
  approveArbTake?: EvaluateTakeDecisionParams<
    TPoolConfig,
    TExecutionConfig
  >['approveArbTake'];
  reapproveExternalTakeBeforeExecution?: ExecuteTakeDecisionParams<
    TPoolConfig,
    TExecutionConfig
  >['reapproveExternalTakeBeforeExecution'];
  onFound?: (decision: TakeDecision) => void;
}

export async function getTakeBorrowerCandidates(params: {
  subgraph: SubgraphReader;
  poolAddress: string;
  minCollateral: number;
}): Promise<TakeBorrowerCandidate[]> {
  const {
    pool: { liquidationAuctions },
  } = await params.subgraph.getLiquidations(
    params.poolAddress,
    params.minCollateral
  );

  return liquidationAuctions.map(({ borrower }) => ({ borrower }));
}

export async function revalidateTakeDecision<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
>(params: {
  pool: FungiblePool;
  signer: Signer;
  borrower: string;
  subgraph: SubgraphReader;
  poolConfig: TPoolConfig;
  arbTakeStrategy: ArbTakeStrategy<TPoolConfig>;
  takeAuctionStatusReader?: TakeAuctionStatusReader;
  takeablePrice?: number;
  hpbIndex?: number;
  maxArbTakePrice?: number;
}): Promise<{
  approvedTake: boolean;
  approvedArbTake: boolean;
  collateral: BigNumber;
  auctionPrice: BigNumber;
  hpbIndex: number;
  maxArbTakePrice?: number;
}> {
  const statusReader =
    params.takeAuctionStatusReader ?? defaultTakeAuctionStatusReader;
  const liquidationStatus = await statusReader.read({
    pool: params.pool,
    borrower: params.borrower,
  });
  const currentPrice = Number(weiToDecimaled(liquidationStatus.auctionPrice));
  const collateral = liquidationStatus.collateral;
  if (!collateral.gt(0)) {
    return {
      approvedTake: false,
      approvedArbTake: false,
      collateral,
      auctionPrice: liquidationStatus.auctionPrice,
      hpbIndex: 0,
    };
  }

  let approvedArbTake = false;
  let hpbIndex = params.hpbIndex ?? 0;
  let maxArbTakePrice = params.maxArbTakePrice;

  if (
    params.maxArbTakePrice !== undefined &&
    params.arbTakeStrategy.isEnabled(params.poolConfig)
  ) {
    const arbEvaluation = await params.arbTakeStrategy.evaluateArbTake({
      pool: params.pool,
      signer: params.signer,
      poolConfig: params.poolConfig,
      subgraph: params.subgraph,
      price: currentPrice,
      auctionPrice: liquidationStatus.auctionPrice,
      collateral,
    });

    approvedArbTake = arbEvaluation.isArbTakeable;
    hpbIndex = arbEvaluation.hpbIndex;
    maxArbTakePrice = arbEvaluation.maxArbTakePrice;
  }

  return {
    approvedTake:
      params.takeablePrice !== undefined &&
      currentPrice <= params.takeablePrice,
    approvedArbTake,
    collateral,
    auctionPrice: liquidationStatus.auctionPrice,
    hpbIndex,
    maxArbTakePrice,
  };
}

export async function evaluateTakeDecision<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
>({
  pool,
  signer,
  poolConfig,
  candidate,
  subgraph,
  externalTakeAdapter,
  arbTakeStrategy,
  takeAuctionStatusReader,
  auctionStatus,
  approveExternalTake,
  approveArbTake,
}: EvaluateTakeDecisionParams<
  TPoolConfig,
  TExecutionConfig
>): Promise<TakeDecision> {
  const statusReader = takeAuctionStatusReader ?? defaultTakeAuctionStatusReader;
  const liquidationStatus =
    auctionStatus ??
    (await statusReader.read({
      pool,
      borrower: candidate.borrower,
    }));
  const collateral = liquidationStatus.collateral;
  const auctionPrice = liquidationStatus.auctionPrice;
  const price = Number(weiToDecimaled(auctionPrice));

  if (!collateral.gt(0)) {
    return {
      approvedTake: false,
      approvedArbTake: false,
      borrower: candidate.borrower,
      hpbIndex: 0,
      collateral,
      auctionPrice,
      reason: TAKE_SKIP_REASONS.auctionInactive,
    };
  }

  let approvedTake = false;
  let approvedArbTake = false;
  let reason: string | undefined;
  let hpbIndex = 0;
  let takeablePrice: number | undefined;
  let maxArbTakePrice: number | undefined;
  let selectedQuoteEvaluation: ExternalTakeQuoteEvaluation | undefined;
  const evaluateExternalTake = externalTakeAdapter.evaluateExternalTake;
  const externalTakeConfigured =
    poolConfig.take.marketPriceFactor !== undefined &&
    evaluateExternalTake !== undefined;
  const arbTakeConfigured = arbTakeStrategy.isEnabled(poolConfig);

  if (externalTakeConfigured) {
    const quoteEvaluation = await evaluateExternalTake({
      pool,
      signer,
      poolConfig,
      price,
      auctionPrice,
      collateral,
    });

    if (!quoteEvaluation.isTakeable) {
      reason = quoteEvaluation.reason;
    } else {
      const approval = approveExternalTake
        ? await approveExternalTake({
            pool,
            signer,
            poolConfig,
            candidate,
            price,
            auctionPrice,
            collateral,
            quoteEvaluation,
          })
        : { approved: true };

      if (approval.approved) {
        approvedTake = true;
        selectedQuoteEvaluation = approval.quoteEvaluation ?? quoteEvaluation;
        takeablePrice = selectedQuoteEvaluation.takeablePrice;
      } else {
        reason = approval.reason ?? reason;
      }
    }
  }

  if (arbTakeConfigured) {
    const arbEvaluation = await arbTakeStrategy.evaluateArbTake({
      pool,
      signer,
      poolConfig,
      subgraph,
      price,
      auctionPrice,
      collateral,
    });

    if (!arbEvaluation.isArbTakeable) {
      if (!approvedTake) {
        reason = arbEvaluation.reason ?? reason;
      }
    } else {
      const approval = approveArbTake
        ? await approveArbTake({
            pool,
            signer,
            poolConfig,
            candidate,
            price,
            auctionPrice,
            collateral,
            arbEvaluation,
          })
        : { approved: true };

      if (approval.approved) {
        approvedArbTake = true;
        hpbIndex = arbEvaluation.hpbIndex;
        maxArbTakePrice = arbEvaluation.maxArbTakePrice;
      } else if (!approvedTake) {
        reason = approval.reason ?? reason;
      }
    }
  }
  if (!approvedTake && !approvedArbTake && reason === undefined) {
    reason =
      externalTakeConfigured || arbTakeConfigured
        ? `auction price ${price} did not satisfy configured take policies`
        : 'no external take or arbTake strategy is configured';
  }

  return {
    approvedTake,
    approvedArbTake,
    borrower: candidate.borrower,
    hpbIndex,
    collateral,
    auctionPrice,
    takeablePrice,
    maxArbTakePrice,
    quoteEvaluation: selectedQuoteEvaluation,
    reason,
  };
}

export async function executeTakeDecision<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
>({
  pool,
  signer,
  poolConfig,
  decision,
  externalTakeAdapter,
  externalExecutionConfig,
  subgraph,
  dryRun,
  delayBetweenActions,
  arbTakeStrategy,
  revalidateBeforeExecution,
  reapproveExternalTakeBeforeExecution,
  onSkip,
  onExecuted,
  takeWriteTransport,
  takeAuctionStatusReader,
}: ExecuteTakeDecisionParams<
  TPoolConfig,
  TExecutionConfig
>): Promise<TakeExecutionResult> {
  let approvedTake = decision.approvedTake;
  let approvedArbTake = decision.approvedArbTake;
  let collateral = decision.collateral;
  let auctionPrice = decision.auctionPrice;
  let hpbIndex = decision.hpbIndex;
  let maxArbTakePrice = decision.maxArbTakePrice;
  let executedTake = false;
  let executedArbTake = false;
  let submittedTransaction = false;
  let poolStateMayHaveChanged = false;
  const getExecutionResult = (): TakeExecutionResult => ({
    executedTake,
    executedArbTake,
    submittedTransaction,
    poolStateMayHaveChanged,
  });

  if (revalidateBeforeExecution) {
    const revalidated = await revalidateTakeDecision({
      pool,
      signer,
      borrower: decision.borrower,
      subgraph,
      poolConfig,
      arbTakeStrategy,
      takeAuctionStatusReader,
      takeablePrice: decision.takeablePrice,
      hpbIndex,
      maxArbTakePrice,
    });

    approvedTake = approvedTake && revalidated.approvedTake;
    approvedArbTake = approvedArbTake && revalidated.approvedArbTake;
    collateral = revalidated.collateral;
    auctionPrice = revalidated.auctionPrice;
    hpbIndex = revalidated.hpbIndex;
    maxArbTakePrice = revalidated.maxArbTakePrice;

    if (!approvedTake && !approvedArbTake) {
      onSkip?.({
        candidate: { borrower: decision.borrower },
        stage: 'revalidation',
        reason: !collateral.gt(0)
          ? TAKE_SKIP_REASONS.auctionInactive
          : TAKE_SKIP_REASONS.auctionStateChanged,
        decision,
      });
      return getExecutionResult();
    }

    const quoteEvaluation = decision.quoteEvaluation;
    if (approvedTake && quoteEvaluation?.quotedCollateralWad) {
      if (!collateral.eq(quoteEvaluation.quotedCollateralWad)) {
        onSkip?.({
          candidate: { borrower: decision.borrower },
          stage: 'revalidation',
          reason: TAKE_SKIP_REASONS.quoteCollateralMismatch,
          decision,
        });
        return getExecutionResult();
      }
    }
    if (approvedTake && quoteEvaluation?.quotedAuctionPriceWad) {
      if (auctionPrice.gt(quoteEvaluation.quotedAuctionPriceWad)) {
        onSkip?.({
          candidate: { borrower: decision.borrower },
          stage: 'revalidation',
          reason: TAKE_SKIP_REASONS.quoteAuctionPriceStale,
          decision,
        });
        return getExecutionResult();
      }
    }

    if (
      approvedTake &&
      quoteEvaluation &&
      reapproveExternalTakeBeforeExecution
    ) {
      const approval = await reapproveExternalTakeBeforeExecution({
        pool,
        signer,
        poolConfig,
        candidate: { borrower: decision.borrower },
        price: Number(weiToDecimaled(auctionPrice)),
        auctionPrice,
        collateral,
        quoteEvaluation,
      });
      if (!approval.approved) {
        onSkip?.({
          candidate: { borrower: decision.borrower },
          stage: 'revalidation',
          reason:
            approval.reason ??
            'approved external take failed final pre-submission policy check',
          decision,
        });
        return getExecutionResult();
      }
      if (approval.quoteEvaluation) {
        decision.quoteEvaluation = approval.quoteEvaluation;
      }
    }
  }

  if (approvedTake && externalTakeAdapter.executeExternalTake) {
    const externalTakeSucceeded = await externalTakeAdapter.executeExternalTake(
      {
        pool,
        signer,
        poolConfig,
        liquidation: {
          borrower: decision.borrower,
          hpbIndex,
          collateral,
          auctionPrice,
          isTakeable: true,
          isArbTakeable: approvedArbTake,
          externalTakeQuoteEvaluation: decision.quoteEvaluation,
        },
        config: externalExecutionConfig,
      }
    );
    if (externalTakeSucceeded === false) {
      throw new Error(
        `External take execution failed for ${pool.name}/${decision.borrower}`
      );
    }
    executedTake = true;
    submittedTransaction = !dryRun;
    poolStateMayHaveChanged = !dryRun;

    if (approvedArbTake) {
      await delay(delayBetweenActions);

      try {
        const postTakeRevalidated = await revalidateTakeDecision({
          pool,
          signer,
          borrower: decision.borrower,
          subgraph,
          poolConfig,
          arbTakeStrategy,
          takeAuctionStatusReader,
          hpbIndex,
          maxArbTakePrice,
        });
        const arbActionLabel = arbTakeStrategy.actionLabel ?? 'ArbTake';
        approvedArbTake = postTakeRevalidated.approvedArbTake;
        collateral = postTakeRevalidated.collateral;
        auctionPrice = postTakeRevalidated.auctionPrice;
        hpbIndex = postTakeRevalidated.hpbIndex;
        maxArbTakePrice = postTakeRevalidated.maxArbTakePrice;

        if (!approvedArbTake) {
          logger.debug(
            `Skipping ${arbActionLabel} after external take for ${pool.name}/${decision.borrower}: ${TAKE_SKIP_REASONS.auctionStateChanged}`
          );
        }
      } catch (error) {
        const arbActionLabel = arbTakeStrategy.actionLabel ?? 'ArbTake';
        approvedArbTake = false;
        logger.warn(
          `Skipping ${arbActionLabel} after external take for ${pool.name}/${decision.borrower}: failed to revalidate auction state`,
          error
        );
      }
    }
  }

  if (approvedArbTake) {
    executedArbTake = await arbTakeStrategy.executeArbTake({
      pool,
      signer,
      borrower: decision.borrower,
      hpbIndex,
      dryRun,
      takeWriteTransport,
    });
    if (executedArbTake && !dryRun) {
      submittedTransaction = true;
      poolStateMayHaveChanged = true;
    }
  }

  onExecuted?.({
    decision,
    executedTake,
    executedArbTake,
  });
  return getExecutionResult();
}

export async function processTakeCandidates<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
>({
  pool,
  signer,
  poolConfig,
  candidates,
  subgraph,
  externalTakeAdapter,
  arbTakeStrategy,
  externalExecutionConfig,
  dryRun,
  delayBetweenActions,
  approveExternalTake,
  approveArbTake,
  reapproveExternalTakeBeforeExecution,
  revalidateBeforeExecution,
  takeAuctionStatusReader,
  candidateStatuses,
  stopAfterExecution,
  maxConcurrentCandidateEvaluations,
  resetExternalTakeAttemptSubmission,
  didExternalTakeAttemptSubmission,
  onSkip,
  onExecuted,
  onFound,
  takeWriteTransport,
}: ProcessTakeCandidatesParams<TPoolConfig, TExecutionConfig>): Promise<void> {
  type CandidateEvaluationOutcome =
    | {
        kind: 'approved';
        candidate: TakeBorrowerCandidate;
        decision: TakeDecision;
      }
    | {
        kind: 'skipped';
        candidate: TakeBorrowerCandidate;
        decision?: TakeDecision;
        reason: string;
      };
  const requestedCandidateEvaluationConcurrency =
    maxConcurrentCandidateEvaluations ?? 1;
  const candidateEvaluationConcurrency =
    Number.isFinite(requestedCandidateEvaluationConcurrency) &&
    requestedCandidateEvaluationConcurrency >= 1
      ? Math.floor(requestedCandidateEvaluationConcurrency)
      : 1;
  let preloadedStatusesValid = true;
  const evaluateCandidate = async (
    candidate: TakeBorrowerCandidate
  ): Promise<CandidateEvaluationOutcome> => {
    try {
      const decision = await evaluateTakeDecision({
        pool,
        signer,
        poolConfig,
        candidate,
        subgraph,
        externalTakeAdapter,
        arbTakeStrategy,
        takeAuctionStatusReader,
        auctionStatus: preloadedStatusesValid
          ? candidateStatuses?.get(normalizeBorrowerKey(candidate.borrower))
          : undefined,
        approveExternalTake,
        approveArbTake,
      });

      if (!decision.approvedTake && !decision.approvedArbTake) {
        return {
          kind: 'skipped',
          candidate,
          reason:
            decision.reason ??
            `auction price ${Number(
              weiToDecimaled(decision.auctionPrice)
            ).toFixed(6)} did not satisfy configured take policies`,
          decision,
        };
      }

      return {
        kind: 'approved',
        candidate,
        decision,
      };
    } catch (error) {
      return {
        kind: 'skipped',
        candidate,
        reason: getErrorMessage(error),
      };
    }
  };

  for (
    let windowStart = 0;
    windowStart < candidates.length;
    windowStart += candidateEvaluationConcurrency
  ) {
    const candidateWindow = candidates.slice(
      windowStart,
      windowStart + candidateEvaluationConcurrency
    );
    const evaluationOutcomes = await mapWithConcurrencyPreservingOrder(
      candidateWindow,
      candidateEvaluationConcurrency,
      evaluateCandidate
    );

    for (const outcome of evaluationOutcomes) {
      if (outcome.kind === 'skipped') {
        onSkip?.({
          candidate: outcome.candidate,
          stage: 'evaluation',
          reason: outcome.reason,
          decision: outcome.decision,
        });
        continue;
      }

      const { candidate, decision } = outcome;
      onFound?.(decision);
      resetExternalTakeAttemptSubmission?.();
      try {
        const executionResult = await executeTakeDecision({
          pool,
          signer,
          poolConfig,
          decision,
          externalTakeAdapter,
          externalExecutionConfig,
          subgraph,
          dryRun,
          delayBetweenActions,
          arbTakeStrategy,
          takeAuctionStatusReader,
          revalidateBeforeExecution,
          reapproveExternalTakeBeforeExecution,
          onSkip,
          onExecuted,
          takeWriteTransport,
        });
        if (executionResult.poolStateMayHaveChanged) {
          preloadedStatusesValid = false;
          if (stopAfterExecution) {
            return;
          }
          break;
        }
      } catch (error) {
        onSkip?.({
          candidate,
          stage: 'execution',
          reason: getErrorMessage(error),
          decision,
        });
        if (!dryRun && didExternalTakeAttemptSubmission?.()) {
          preloadedStatusesValid = false;
          if (stopAfterExecution) {
            return;
          }
          break;
        }
      }
    }
  }
}

export function formatTakeStrategyLog(
  strategyKind: ExternalTakeStrategyKind,
  approvedTake: boolean,
  approvedArbTake: boolean
): string {
  if (approvedTake && approvedArbTake) {
    return strategyKind === 'factory'
      ? 'factory take and arbTake'
      : 'take and arbTake';
  }
  if (approvedTake) {
    return strategyKind === 'factory' ? 'factory take' : 'take';
  }
  if (approvedArbTake) {
    return 'arbTake';
  }
  return 'none';
}

export function logSkippedTakeCandidate(params: {
  pool: FungiblePool;
  borrower: string;
  price?: number;
  reason: string;
  prefix?: string;
}): void {
  if (params.price !== undefined) {
    logger.debug(
      `${params.prefix ?? ''}Not taking liquidation since price ${params.price} is too high - pool: ${params.pool.name}, borrower: ${params.borrower}`
    );
    return;
  }

  logger.debug(
    `${params.prefix ?? ''}Skipping liquidation for pool ${params.pool.name}, borrower: ${params.borrower}: ${params.reason}`
  );
}
