import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { logger } from '../logging';
import { SubgraphReader } from '../read-transports';
import {
  getErrorMessage,
  mapWithConcurrencyPreservingOrder,
  weiToDecimaled,
} from '../utils';
import { ArbTakeStrategy } from './arb-strategy';
import { TakeWriteTransport } from './write-transport';
import {
  AuctionTakeFacts,
  BoundExternalTakeRouteEvaluation,
  ArbTakeEvaluation,
  ExternalTakeEvaluationResult,
  ExternalTakeExecutionPlan,
  ExternalTakeQuoteEvaluation,
  ExternalTakeStrategyKind,
  TakeActionConfig,
  TakeBorrowerCandidate,
  TakeDecision,
  TakeExecutionResult,
  TakeLiquidationPlan,
} from './types';
import { replaceExternalTakeExecutionPlanPrimary } from './external-take/execution-plan';
import {
  TakeAuctionStatus,
  TakeAuctionStatusReader,
  defaultTakeAuctionStatusReader,
  normalizeBorrowerKey,
  readCandidateStatusWindow,
} from './liquidation-status';
import {
  getRevalidatedQuoteContextIssue,
  revalidateTakeDecision,
} from './take-decision-revalidation';

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
  TApprovalContext = unknown,
> {
  kind: ExternalTakeStrategyKind;
  evaluateExternalTake?: (
    params: AuctionTakeFacts & {
      pool: FungiblePool;
      signer: Signer;
      poolConfig: TPoolConfig;
      candidate: TakeBorrowerCandidate;
      price: number;
    }
  ) => Promise<ExternalTakeEvaluationResult<TApprovalContext>>;
  executeExternalTake?: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    liquidation: TakeLiquidationPlan<TApprovalContext>;
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

type TakeExternalApprovalResult =
  | { approved: true; quoteEvaluation: BoundExternalTakeRouteEvaluation }
  | { approved: false; reason?: string };

type TakeArbApprovalResult =
  | { approved: true }
  | { approved: false; reason?: string };

type ExternalTakeExecutionState<TApprovalContext> =
  | {
      approvedTake: true;
      executionPlan: ExternalTakeExecutionPlan<TApprovalContext>;
    }
  | { approvedTake: false; executionPlan?: undefined };

function createExecutionDecisionSnapshot<TApprovalContext>(
  params: AuctionTakeFacts & {
    decision: TakeDecision<TApprovalContext>;
    externalTakeState: ExternalTakeExecutionState<TApprovalContext>;
    approvedArbTake: boolean;
    hpbIndex: number;
    maxArbTakePrice?: number;
  }
): TakeDecision<TApprovalContext> {
  const decisionBase = {
    approvedArbTake: params.approvedArbTake,
    borrower: params.decision.borrower,
    hpbIndex: params.hpbIndex,
    collateral: params.collateral,
    auctionPrice: params.auctionPrice,
    ...(params.debtToCover === undefined
      ? {}
      : { debtToCover: params.debtToCover }),
    ...(params.maxArbTakePrice === undefined
      ? {}
      : { maxArbTakePrice: params.maxArbTakePrice }),
    ...(params.decision.reason === undefined
      ? {}
      : { reason: params.decision.reason }),
  };

  if (!params.externalTakeState.approvedTake) {
    return {
      ...decisionBase,
      approvedTake: false,
    };
  }

  const takeablePrice =
    params.externalTakeState.executionPlan.primary.evaluation.takeablePrice;
  return {
    ...decisionBase,
    approvedTake: true,
    ...(takeablePrice === undefined ? {} : { takeablePrice }),
    externalTakeExecutionPlan: params.externalTakeState.executionPlan,
  };
}

interface EvaluateTakeDecisionParams<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
  TApprovalContext = unknown,
> {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TPoolConfig;
  candidate: TakeBorrowerCandidate;
  subgraph: SubgraphReader;
  externalTakeAdapter: ExternalTakeAdapter<
    TPoolConfig,
    TExecutionConfig,
    TApprovalContext
  >;
  arbTakeStrategy: ArbTakeStrategy<TPoolConfig>;
  takeAuctionStatusReader?: TakeAuctionStatusReader;
  auctionStatus?: TakeAuctionStatus;
  approveExternalTake?: (
    params: AuctionTakeFacts & {
      pool: FungiblePool;
      signer: Signer;
      poolConfig: TPoolConfig;
      candidate: TakeBorrowerCandidate;
      price: number;
      quoteEvaluation: ExternalTakeQuoteEvaluation;
      externalTakeApprovalContext?: TApprovalContext;
    }
  ) => Promise<TakeExternalApprovalResult>;
  approveArbTake?: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    candidate: TakeBorrowerCandidate;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
    arbEvaluation: ArbTakeEvaluation;
  }) => Promise<TakeArbApprovalResult>;
}

interface ExecuteTakeDecisionParams<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
  TApprovalContext = unknown,
> {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TPoolConfig;
  decision: TakeDecision<TApprovalContext>;
  externalTakeAdapter: ExternalTakeAdapter<
    TPoolConfig,
    TExecutionConfig,
    TApprovalContext
  >;
  externalExecutionConfig: TExecutionConfig;
  subgraph: SubgraphReader;
  dryRun: boolean;
  arbTakeStrategy: ArbTakeStrategy<TPoolConfig>;
  takeAuctionStatusReader?: TakeAuctionStatusReader;
  revalidateBeforeExecution?: boolean;
  reapproveExternalTakeBeforeExecution?: EvaluateTakeDecisionParams<
    TPoolConfig,
    TExecutionConfig,
    TApprovalContext
  >['approveExternalTake'];
  onSkip?: (params: {
    candidate: TakeBorrowerCandidate;
    stage: 'evaluation' | 'revalidation' | 'execution';
    reason: string;
    decision?: TakeDecision<TApprovalContext>;
  }) => void;
  onExecuted?: (params: {
    decision: TakeDecision<TApprovalContext>;
    executedTake: boolean;
    executedArbTake: boolean;
  }) => void;
  takeWriteTransport?: TakeWriteTransport;
}

interface ProcessTakeCandidatesParams<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
  TApprovalContext = unknown,
> extends Omit<
      EvaluateTakeDecisionParams<
        TPoolConfig,
        TExecutionConfig,
        TApprovalContext
      >,
      | 'candidate'
      | 'approveExternalTake'
      | 'approveArbTake'
      | 'externalTakeAdapter'
      | 'arbTakeStrategy'
    >,
    Pick<
      ExecuteTakeDecisionParams<
        TPoolConfig,
        TExecutionConfig,
        TApprovalContext
      >,
      | 'externalExecutionConfig'
      | 'dryRun'
      | 'revalidateBeforeExecution'
      | 'onSkip'
      | 'onExecuted'
      | 'takeWriteTransport'
    > {
  candidates: TakeBorrowerCandidate[];
  candidateStatuses?: Map<string, TakeAuctionStatus>;
  stopAfterExecution?: boolean;
  maxExecutions?: number;
  stopAfterAttemptedSubmissionFailure?: boolean;
  maxConcurrentCandidateEvaluations?: number;
  resetExternalTakeAttemptSubmission?: () => void;
  didExternalTakeAttemptSubmission?: () => boolean;
  externalTakeAdapter: ExternalTakeAdapter<
    TPoolConfig,
    TExecutionConfig,
    TApprovalContext
  >;
  arbTakeStrategy: ArbTakeStrategy<TPoolConfig>;
  approveExternalTake?: EvaluateTakeDecisionParams<
    TPoolConfig,
    TExecutionConfig,
    TApprovalContext
  >['approveExternalTake'];
  approveArbTake?: EvaluateTakeDecisionParams<
    TPoolConfig,
    TExecutionConfig,
    TApprovalContext
  >['approveArbTake'];
  reapproveExternalTakeBeforeExecution?: ExecuteTakeDecisionParams<
    TPoolConfig,
    TExecutionConfig,
    TApprovalContext
  >['reapproveExternalTakeBeforeExecution'];
  onFound?: (decision: TakeDecision<TApprovalContext>) => void;
  onExecutionAttempt?: (decision: TakeDecision<TApprovalContext>) => void;
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

export async function evaluateTakeDecision<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
  TApprovalContext = unknown,
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
  TExecutionConfig,
  TApprovalContext
>): Promise<TakeDecision<TApprovalContext>> {
  const statusReader =
    takeAuctionStatusReader ?? defaultTakeAuctionStatusReader;
  const liquidationStatus =
    auctionStatus ??
    (await statusReader.read({
      pool,
      borrower: candidate.borrower,
    }));
  const collateral = liquidationStatus.collateral;
  const auctionPrice = liquidationStatus.auctionPrice;
  const debtToCover = liquidationStatus.debtToCover;
  const price = Number(weiToDecimaled(auctionPrice));

  if (!collateral.gt(0)) {
    return {
      approvedTake: false,
      approvedArbTake: false,
      borrower: candidate.borrower,
      hpbIndex: 0,
      collateral,
      auctionPrice,
      debtToCover,
      reason: TAKE_SKIP_REASONS.auctionInactive,
    };
  }

  let approvedTake = false;
  let approvedArbTake = false;
  let reason: string | undefined;
  let hpbIndex = 0;
  let takeablePrice: number | undefined;
  let maxArbTakePrice: number | undefined;
  let selectedExternalTakeExecutionPlan:
    | ExternalTakeExecutionPlan<TApprovalContext>
    | undefined;
  const evaluateExternalTake = externalTakeAdapter.evaluateExternalTake;
  const externalTakeConfigured =
    poolConfig.take.marketPriceFactor !== undefined &&
    evaluateExternalTake !== undefined;
  const arbTakeConfigured = arbTakeStrategy.isEnabled(poolConfig);

  if (externalTakeConfigured) {
    const externalTakeEvaluation = await evaluateExternalTake({
      pool,
      signer,
      poolConfig,
      candidate,
      price,
      auctionPrice,
      collateral,
      debtToCover,
    });

    if (!externalTakeEvaluation.takeable) {
      reason =
        externalTakeEvaluation.reason ??
        externalTakeEvaluation.quoteEvaluation.reason;
    } else {
      const externalTakeExecutionPlan = externalTakeEvaluation.executionPlan;
      const quoteEvaluation = externalTakeExecutionPlan.primary.evaluation;
      const primaryApprovalContext =
        externalTakeExecutionPlan.primary.approvalContext;
      const approval: TakeExternalApprovalResult = approveExternalTake
        ? await approveExternalTake({
            pool,
            signer,
            poolConfig,
            candidate,
            price,
            auctionPrice,
            collateral,
            debtToCover,
            quoteEvaluation,
            externalTakeApprovalContext: primaryApprovalContext,
          })
        : {
            approved: true,
            quoteEvaluation,
          };

      if (approval.approved) {
        approvedTake = true;
        selectedExternalTakeExecutionPlan =
          replaceExternalTakeExecutionPlanPrimary({
            plan: externalTakeExecutionPlan,
            primaryEvaluation: approval.quoteEvaluation,
            primaryApprovalContext,
          });
        takeablePrice = approval.quoteEvaluation.takeablePrice;
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
      const approval: TakeArbApprovalResult = approveArbTake
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

  const decisionBase = {
    approvedArbTake,
    borrower: candidate.borrower,
    hpbIndex,
    collateral,
    auctionPrice,
    debtToCover,
    maxArbTakePrice,
    reason,
  };
  if (approvedTake) {
    if (!selectedExternalTakeExecutionPlan) {
      throw new Error('approved external take is missing an execution plan');
    }
    return {
      ...decisionBase,
      approvedTake: true,
      takeablePrice,
      externalTakeExecutionPlan: selectedExternalTakeExecutionPlan,
    };
  }
  return {
    ...decisionBase,
    approvedTake: false,
  };
}

export async function executeTakeDecision<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
  TApprovalContext = unknown,
>({
  pool,
  signer,
  poolConfig,
  decision,
  externalTakeAdapter,
  externalExecutionConfig,
  subgraph,
  dryRun,
  arbTakeStrategy,
  revalidateBeforeExecution,
  reapproveExternalTakeBeforeExecution,
  onSkip,
  onExecuted,
  takeWriteTransport,
  takeAuctionStatusReader,
}: ExecuteTakeDecisionParams<
  TPoolConfig,
  TExecutionConfig,
  TApprovalContext
>): Promise<TakeExecutionResult> {
  let externalTakeState: ExternalTakeExecutionState<TApprovalContext> =
    decision.approvedTake
      ? {
          approvedTake: true,
          executionPlan: decision.externalTakeExecutionPlan,
        }
      : { approvedTake: false };
  let approvedArbTake = decision.approvedArbTake;
  let collateral = decision.collateral;
  let auctionPrice = decision.auctionPrice;
  let debtToCover = decision.debtToCover;
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
  const getCurrentDecision = (): TakeDecision<TApprovalContext> =>
    createExecutionDecisionSnapshot({
      decision,
      externalTakeState,
      approvedArbTake,
      hpbIndex,
      collateral,
      auctionPrice,
      debtToCover,
      maxArbTakePrice,
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

    externalTakeState =
      externalTakeState.approvedTake && revalidated.approvedTake
        ? externalTakeState
        : { approvedTake: false };
    approvedArbTake = approvedArbTake && revalidated.approvedArbTake;
    collateral = revalidated.collateral;
    auctionPrice = revalidated.auctionPrice;
    debtToCover = revalidated.debtToCover;
    hpbIndex = revalidated.hpbIndex;
    maxArbTakePrice = revalidated.maxArbTakePrice;

    if (!externalTakeState.approvedTake && !approvedArbTake) {
      onSkip?.({
        candidate: { borrower: decision.borrower },
        stage: 'revalidation',
        reason: !collateral.gt(0)
          ? TAKE_SKIP_REASONS.auctionInactive
          : TAKE_SKIP_REASONS.auctionStateChanged,
        decision: getCurrentDecision(),
      });
      return getExecutionResult();
    }

    if (externalTakeState.approvedTake) {
      const quoteEvaluation =
        externalTakeState.executionPlan.primary.evaluation;
      const quoteContextIssue = getRevalidatedQuoteContextIssue({
        quoteEvaluation,
        collateral,
        auctionPrice,
        debtToCover,
      });
      if (quoteContextIssue) {
        onSkip?.({
          candidate: { borrower: decision.borrower },
          stage: 'revalidation',
          reason:
            quoteContextIssue === 'collateral_mismatch'
              ? TAKE_SKIP_REASONS.quoteCollateralMismatch
              : TAKE_SKIP_REASONS.quoteAuctionPriceStale,
          decision: getCurrentDecision(),
        });
        return getExecutionResult();
      }

      if (reapproveExternalTakeBeforeExecution) {
        const approval = await reapproveExternalTakeBeforeExecution({
          pool,
          signer,
          poolConfig,
          candidate: { borrower: decision.borrower },
          price: Number(weiToDecimaled(auctionPrice)),
          auctionPrice,
          collateral,
          debtToCover,
          quoteEvaluation,
          externalTakeApprovalContext:
            externalTakeState.executionPlan.primary.approvalContext,
        });
        if (!approval.approved) {
          onSkip?.({
            candidate: { borrower: decision.borrower },
            stage: 'revalidation',
            reason:
              approval.reason ??
              'approved external take failed final pre-submission policy check',
            decision: getCurrentDecision(),
          });
          return getExecutionResult();
        }
        const primaryApprovalContext =
          externalTakeState.executionPlan.primary.approvalContext;
        externalTakeState = {
          approvedTake: true,
          executionPlan: replaceExternalTakeExecutionPlanPrimary({
            plan: externalTakeState.executionPlan,
            primaryEvaluation: approval.quoteEvaluation,
            primaryApprovalContext,
          }),
        };
      }
    }
  }

  if (
    externalTakeState.approvedTake &&
    externalTakeAdapter.executeExternalTake
  ) {
    const externalTakeExecutionPlan = externalTakeState.executionPlan;
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
          debtToCover,
          isTakeable: true,
          isArbTakeable: approvedArbTake,
          externalTakeExecutionPlan,
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
    decision: getCurrentDecision(),
    executedTake,
    executedArbTake,
  });
  return getExecutionResult();
}

export async function processTakeCandidates<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
  TApprovalContext = unknown,
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
  approveExternalTake,
  approveArbTake,
  reapproveExternalTakeBeforeExecution,
  revalidateBeforeExecution,
  takeAuctionStatusReader,
  candidateStatuses,
  stopAfterExecution,
  maxExecutions,
  stopAfterAttemptedSubmissionFailure,
  maxConcurrentCandidateEvaluations,
  resetExternalTakeAttemptSubmission,
  didExternalTakeAttemptSubmission,
  onSkip,
  onExecuted,
  onFound,
  onExecutionAttempt,
  takeWriteTransport,
}: ProcessTakeCandidatesParams<
  TPoolConfig,
  TExecutionConfig,
  TApprovalContext
>): Promise<void> {
  type CandidateEvaluationOutcome =
    | {
        kind: 'approved';
        candidate: TakeBorrowerCandidate;
        decision: TakeDecision<TApprovalContext>;
      }
    | {
        kind: 'skipped';
        candidate: TakeBorrowerCandidate;
        decision?: TakeDecision<TApprovalContext>;
        reason: string;
      };
  const requestedCandidateEvaluationConcurrency =
    maxConcurrentCandidateEvaluations ?? 1;
  const candidateEvaluationConcurrency =
    Number.isFinite(requestedCandidateEvaluationConcurrency) &&
    requestedCandidateEvaluationConcurrency >= 1
      ? Math.floor(requestedCandidateEvaluationConcurrency)
      : 1;
  const maxSuccessfulExecutions =
    maxExecutions !== undefined && Number.isFinite(maxExecutions)
      ? Math.max(1, Math.floor(maxExecutions))
      : undefined;
  let successfulExecutionCount = 0;
  let preloadedStatusesValid = true;
  const readCandidateWindowStatuses = async (
    candidateWindow: TakeBorrowerCandidate[]
  ): Promise<Map<string, TakeAuctionStatus> | undefined> =>
    preloadedStatusesValid
      ? await readCandidateStatusWindow({
          pool,
          borrowers: candidateWindow.map((candidate) => candidate.borrower),
          preloadedStatuses: candidateStatuses,
          reader: takeAuctionStatusReader,
        })
      : undefined;
  const evaluateCandidate = async (
    candidate: TakeBorrowerCandidate,
    windowCandidateStatuses?: Map<string, TakeAuctionStatus>
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
          ? windowCandidateStatuses?.get(
              normalizeBorrowerKey(candidate.borrower)
            )
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
    const windowCandidateStatuses =
      await readCandidateWindowStatuses(candidateWindow);
    const evaluationOutcomes = await mapWithConcurrencyPreservingOrder(
      candidateWindow,
      candidateEvaluationConcurrency,
      async (candidate) =>
        await evaluateCandidate(candidate, windowCandidateStatuses)
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
      onExecutionAttempt?.(decision);
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
          arbTakeStrategy,
          takeAuctionStatusReader,
          revalidateBeforeExecution,
          reapproveExternalTakeBeforeExecution,
          onSkip,
          onExecuted,
          takeWriteTransport,
        });
        if (executionResult.executedTake || executionResult.executedArbTake) {
          successfulExecutionCount += 1;
          if (
            maxSuccessfulExecutions !== undefined &&
            successfulExecutionCount >= maxSuccessfulExecutions
          ) {
            return;
          }
        }
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
          if (stopAfterExecution || stopAfterAttemptedSubmissionFailure) {
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
  const takeLabel =
    strategyKind === 'direct_dex'
      ? 'direct DEX take'
      : strategyKind === 'calldata_aggregator'
        ? 'aggregator take'
        : 'take';
  if (approvedTake && approvedArbTake) {
    return `${takeLabel} and arbTake`;
  }
  if (approvedTake) {
    return takeLabel;
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
