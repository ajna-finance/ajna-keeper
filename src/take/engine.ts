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
import { bindExternalTakeExecutionPlanPrimary } from './external-take-execution-plan';
import { bindExternalTakeRouteForCandidate } from './external-take-quote-approval';
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
  TApprovalContext = unknown,
> {
  kind: ExternalTakeStrategyKind;
  evaluateExternalTake?: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
  }) => Promise<ExternalTakeEvaluationResult<TApprovalContext>>;
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
  approveExternalTake?: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    candidate: TakeBorrowerCandidate;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
    quoteEvaluation: ExternalTakeQuoteEvaluation;
    externalTakeApprovalContext?: TApprovalContext;
  }) => Promise<TakeExternalApprovalResult>;
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
      EvaluateTakeDecisionParams<TPoolConfig, TExecutionConfig, TApprovalContext>,
      | 'candidate'
      | 'approveExternalTake'
      | 'approveArbTake'
      | 'externalTakeAdapter'
      | 'arbTakeStrategy'
    >,
    Pick<
      ExecuteTakeDecisionParams<TPoolConfig, TExecutionConfig, TApprovalContext>,
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
  let selectedQuoteEvaluation: BoundExternalTakeRouteEvaluation | undefined;
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
      price,
      auctionPrice,
      collateral,
    });
    const quoteEvaluation = externalTakeEvaluation.quoteEvaluation;

    if (!quoteEvaluation.isTakeable) {
      reason = quoteEvaluation.reason;
    } else {
      const approval: TakeExternalApprovalResult = approveExternalTake
        ? await approveExternalTake({
            pool,
            signer,
            poolConfig,
            candidate,
            price,
            auctionPrice,
            collateral,
            quoteEvaluation,
            externalTakeApprovalContext:
              externalTakeEvaluation.executionPlan?.primary.approvalContext,
          })
        : (() => {
            const binding = bindExternalTakeRouteForCandidate({
              quoteEvaluation,
              selectedLiquiditySource: quoteEvaluation.selectedLiquiditySource,
              configuredLiquiditySource: poolConfig.take.liquiditySource,
              poolName: pool.name,
              borrower: candidate.borrower,
            });
            return binding.bound
              ? {
                  approved: true,
                  quoteEvaluation: binding.quoteEvaluation,
                }
              : {
                  approved: false,
                  reason: binding.reason,
                };
          })();

      if (approval.approved) {
        approvedTake = true;
        selectedQuoteEvaluation = approval.quoteEvaluation;
        selectedExternalTakeExecutionPlan = externalTakeEvaluation.executionPlan
          ? bindExternalTakeExecutionPlanPrimary({
              plan: externalTakeEvaluation.executionPlan,
              primaryEvaluation: approval.quoteEvaluation,
            })
          : undefined;
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
    externalTakeExecutionPlan: selectedExternalTakeExecutionPlan,
    reason,
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
        externalTakeApprovalContext:
          decision.externalTakeExecutionPlan?.primary.approvalContext,
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
      decision.quoteEvaluation = approval.quoteEvaluation;
      if (decision.externalTakeExecutionPlan) {
        decision.externalTakeExecutionPlan =
          bindExternalTakeExecutionPlanPrimary({
            plan: decision.externalTakeExecutionPlan,
            primaryEvaluation: approval.quoteEvaluation,
          });
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
          externalTakeExecutionPlan: decision.externalTakeExecutionPlan,
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
    decision,
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
  ): Promise<Map<string, TakeAuctionStatus> | undefined> => {
    if (!preloadedStatusesValid) {
      return undefined;
    }

    const statuses = new Map<string, TakeAuctionStatus>();
    const missingBorrowers: string[] = [];
    for (const candidate of candidateWindow) {
      const borrowerKey = normalizeBorrowerKey(candidate.borrower);
      const preloadedStatus = candidateStatuses?.get(borrowerKey);
      if (preloadedStatus) {
        statuses.set(borrowerKey, preloadedStatus);
      } else {
        missingBorrowers.push(candidate.borrower);
      }
    }

    if (
      missingBorrowers.length > 1 &&
      takeAuctionStatusReader?.readMany !== undefined
    ) {
      try {
        const windowStatuses = await takeAuctionStatusReader.readMany({
          pool,
          borrowers: missingBorrowers,
        });
        for (const [borrower, status] of Array.from(windowStatuses)) {
          statuses.set(normalizeBorrowerKey(borrower), status);
        }
      } catch (error) {
        logger.warn(
          `Take candidate status window preload failed for ${pool.name}; falling back to per-candidate reads: ${getErrorMessage(error)}`
        );
      }
    }

    return statuses.size > 0 ? statuses : undefined;
  };
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
    strategyKind === 'factory'
      ? 'factory take'
      : strategyKind === 'lifi'
        ? 'LI.FI take'
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
