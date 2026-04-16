import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { logger } from '../logging';
import { SubgraphReader } from '../read-transports';
import { delay, weiToDecimaled } from '../utils';
import { arbTakeLiquidation, checkIfArbTakeable } from './arb';
import { TakeWriteTransport } from './write-transport';
import {
  ArbTakeEvaluation,
  ExternalTakeQuoteEvaluation,
  ExternalTakeStrategyKind,
  TakeActionConfig,
  TakeBorrowerCandidate,
  TakeDecision,
  TakeLiquidationPlan,
} from './types';

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

interface TakeApprovalResult {
  approved: boolean;
  reason?: string;
}

interface EvaluateTakeDecisionParams<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
> {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TPoolConfig;
  candidate: TakeBorrowerCandidate;
  subgraph: SubgraphReader;
  externalTakeAdapter: ExternalTakeAdapter<TPoolConfig, unknown>;
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
  revalidateBeforeExecution?: boolean;
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
  arbTakeActionLabel?: string;
  arbTakeLogPrefix?: string;
  takeWriteTransport?: TakeWriteTransport;
}

interface ProcessTakeCandidatesParams<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
  TExecutionConfig = unknown,
> extends Omit<
    EvaluateTakeDecisionParams<TPoolConfig>,
    'candidate' | 'approveExternalTake' | 'approveArbTake'
  >,
    Pick<
      ExecuteTakeDecisionParams<TPoolConfig, TExecutionConfig>,
      | 'externalExecutionConfig'
      | 'dryRun'
      | 'delayBetweenActions'
      | 'revalidateBeforeExecution'
      | 'onSkip'
      | 'onExecuted'
      | 'arbTakeActionLabel'
      | 'arbTakeLogPrefix'
      | 'takeWriteTransport'
    > {
  candidates: TakeBorrowerCandidate[];
  approveExternalTake?: EvaluateTakeDecisionParams<TPoolConfig>['approveExternalTake'];
  approveArbTake?: EvaluateTakeDecisionParams<TPoolConfig>['approveArbTake'];
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

export async function revalidateTakeDecision(params: {
  pool: FungiblePool;
  signer: Signer;
  borrower: string;
  subgraph: SubgraphReader;
  poolConfig: TakeActionConfig;
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
  const liquidationStatus = await params.pool
    .getLiquidation(params.borrower)
    .getStatus();
  const currentPrice = Number(weiToDecimaled(liquidationStatus.price));
  const collateral = liquidationStatus.collateral;
  if (!collateral.gt(0)) {
    return {
      approvedTake: false,
      approvedArbTake: false,
      collateral,
      auctionPrice: liquidationStatus.price,
      hpbIndex: 0,
    };
  }

  let approvedArbTake = false;
  let hpbIndex = params.hpbIndex ?? 0;
  let maxArbTakePrice = params.maxArbTakePrice;

  if (params.maxArbTakePrice !== undefined) {
    const prices = await params.pool.getPrices();
    const hpb = Number(weiToDecimaled(prices.hpb));
    const minDeposit = params.poolConfig.take.minCollateral
      ? params.poolConfig.take.minCollateral / hpb
      : 0;
    const arbEvaluation = await checkIfArbTakeable(
      params.pool,
      currentPrice,
      collateral,
      params.poolConfig,
      params.subgraph,
      minDeposit.toString(),
      params.signer
    );

    approvedArbTake = arbEvaluation.isArbTakeable;
    hpbIndex = arbEvaluation.hpbIndex;
    maxArbTakePrice = arbEvaluation.maxArbTakePrice;
  }

  return {
    approvedTake:
      params.takeablePrice !== undefined && currentPrice <= params.takeablePrice,
    approvedArbTake,
    collateral,
    auctionPrice: liquidationStatus.price,
    hpbIndex,
    maxArbTakePrice,
  };
}

export async function evaluateTakeDecision<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
>({
  pool,
  signer,
  poolConfig,
  candidate,
  subgraph,
  externalTakeAdapter,
  approveExternalTake,
  approveArbTake,
}: EvaluateTakeDecisionParams<TPoolConfig>): Promise<TakeDecision> {
  const liquidationStatus = await pool
    .getLiquidation(candidate.borrower)
    .getStatus();
  const collateral = liquidationStatus.collateral;
  const auctionPrice = liquidationStatus.price;
  const price = Number(weiToDecimaled(auctionPrice));

  if (!collateral.gt(0)) {
    return {
      approvedTake: false,
      approvedArbTake: false,
      borrower: candidate.borrower,
      hpbIndex: 0,
      collateral,
      auctionPrice,
      reason: 'auction no longer has collateral onchain',
    };
  }

  let approvedTake = false;
  let approvedArbTake = false;
  let reason: string | undefined;
  let hpbIndex = 0;
  let takeablePrice: number | undefined;
  let maxArbTakePrice: number | undefined;
  let selectedQuoteEvaluation: ExternalTakeQuoteEvaluation | undefined;

  if (
    poolConfig.take.marketPriceFactor !== undefined &&
    poolConfig.take.liquiditySource !== undefined &&
    externalTakeAdapter.evaluateExternalTake
  ) {
    const quoteEvaluation = await externalTakeAdapter.evaluateExternalTake({
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
        takeablePrice = quoteEvaluation.takeablePrice;
        selectedQuoteEvaluation = quoteEvaluation;
      } else {
        reason = approval.reason ?? reason;
      }
    }
  }

  if (
    poolConfig.take.minCollateral !== undefined &&
    poolConfig.take.hpbPriceFactor !== undefined
  ) {
    const prices = await pool.getPrices();
    const hpb = Number(weiToDecimaled(prices.hpb));
    const minDeposit = poolConfig.take.minCollateral / hpb;
    const arbEvaluation = await checkIfArbTakeable(
      pool,
      price,
      collateral,
      poolConfig,
      subgraph,
      minDeposit.toString(),
      signer
    );

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
  revalidateBeforeExecution,
  onSkip,
  onExecuted,
  arbTakeActionLabel,
  arbTakeLogPrefix,
  takeWriteTransport,
}: ExecuteTakeDecisionParams<TPoolConfig, TExecutionConfig>): Promise<void> {
  let approvedTake = decision.approvedTake;
  let approvedArbTake = decision.approvedArbTake;
  let collateral = decision.collateral;
  let auctionPrice = decision.auctionPrice;
  let hpbIndex = decision.hpbIndex;
  let maxArbTakePrice = decision.maxArbTakePrice;
  let executedTake = false;
  let executedArbTake = false;

  if (revalidateBeforeExecution) {
    const revalidated = await revalidateTakeDecision({
      pool,
      signer,
      borrower: decision.borrower,
      subgraph,
      poolConfig,
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
        reason: 'onchain revalidation changed the auction state',
        decision,
      });
      return;
    }
  }

  if (approvedTake && externalTakeAdapter.executeExternalTake) {
    const externalTakeSucceeded = await externalTakeAdapter.executeExternalTake({
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
    });
    if (externalTakeSucceeded === false) {
      throw new Error(
        `External take execution failed for ${pool.name}/${decision.borrower}`
      );
    }
    executedTake = true;

    if (approvedArbTake) {
      await delay(delayBetweenActions);

      try {
        const postTakeRevalidated = await revalidateTakeDecision({
          pool,
          signer,
          borrower: decision.borrower,
          subgraph,
          poolConfig,
          hpbIndex,
          maxArbTakePrice,
        });
        const arbActionLabel = arbTakeActionLabel ?? 'ArbTake';
        approvedArbTake = postTakeRevalidated.approvedArbTake;
        collateral = postTakeRevalidated.collateral;
        auctionPrice = postTakeRevalidated.auctionPrice;
        hpbIndex = postTakeRevalidated.hpbIndex;
        maxArbTakePrice = postTakeRevalidated.maxArbTakePrice;

        if (!approvedArbTake) {
          logger.debug(
            `Skipping ${arbActionLabel} after external take for ${pool.name}/${decision.borrower}: onchain revalidation changed the auction state`
          );
        }
      } catch (error) {
        const arbActionLabel = arbTakeActionLabel ?? 'ArbTake';
        approvedArbTake = false;
        logger.warn(
          `Skipping ${arbActionLabel} after external take for ${pool.name}/${decision.borrower}: failed to revalidate auction state`,
          error
        );
      }
    }
  }

  if (approvedArbTake) {
    executedArbTake = await arbTakeLiquidation({
      pool,
      signer,
      liquidation: {
        borrower: decision.borrower,
        hpbIndex,
      },
      config: {
        dryRun,
        takeWriteTransport,
      },
      actionLabel: arbTakeActionLabel,
      logPrefix: arbTakeLogPrefix,
    });
  }

  onExecuted?.({
    decision,
    executedTake,
    executedArbTake,
  });
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
  externalExecutionConfig,
  dryRun,
  delayBetweenActions,
  approveExternalTake,
  approveArbTake,
  revalidateBeforeExecution,
  onSkip,
  onExecuted,
  onFound,
  arbTakeActionLabel,
  arbTakeLogPrefix,
  takeWriteTransport,
}: ProcessTakeCandidatesParams<TPoolConfig, TExecutionConfig>): Promise<void> {
  for (const candidate of candidates) {
    let decision: TakeDecision | undefined;
    let stage: 'evaluation' | 'execution' = 'evaluation';

    try {
      decision = await evaluateTakeDecision({
        pool,
        signer,
        poolConfig,
        candidate,
        subgraph,
        externalTakeAdapter,
        approveExternalTake,
        approveArbTake,
      });

      if (!decision.approvedTake && !decision.approvedArbTake) {
        onSkip?.({
          candidate,
          stage: 'evaluation',
          reason: decision.reason ?? 'policy rejected candidate',
          decision,
        });
        continue;
      }

      onFound?.(decision);
      stage = 'execution';

      await executeTakeDecision({
        pool,
        signer,
        poolConfig,
        decision,
        externalTakeAdapter,
        externalExecutionConfig,
        subgraph,
        dryRun,
        delayBetweenActions,
        revalidateBeforeExecution,
        onSkip,
        onExecuted,
        arbTakeActionLabel,
        arbTakeLogPrefix,
        takeWriteTransport,
      });
    } catch (error) {
      onSkip?.({
        candidate,
        stage,
        reason: error instanceof Error ? error.message : String(error),
        decision,
      });
    }
  }
}

export function formatTakeStrategyLog(
  strategyKind: ExternalTakeStrategyKind,
  approvedTake: boolean,
  approvedArbTake: boolean
): string {
  if (approvedTake && approvedArbTake) {
    return strategyKind === 'factory' ? 'factory take and arbTake' : 'take and arbTake';
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
