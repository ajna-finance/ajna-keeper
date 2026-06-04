import { Signer, FungiblePool } from '@ajna-finance/sdk';
import { RequireFields, weiToDecimaled } from '../utils';
import { PoolConfig } from '../config';
import { logger } from '../logging';
import {
  resolveSubgraphConfig,
  SubgraphConfigInput,
  WithSubgraph,
} from '../read-transports';
import { TakeWriteTransportConfig } from './write-transport';
import {
  TakeActionConfig,
  TakeBorrowerCandidate,
  TakeLiquidationPlan,
} from './types';
import {
  evaluateTakeDecision,
  formatTakeStrategyLog,
  getTakeBorrowerCandidates,
  logSkippedTakeCandidate,
  processTakeCandidates,
} from './engine';
import {
  formatManualExternalTakeDeployment,
  formatManualTakeDeploymentFallback,
  formatManualTakeDeploymentResolutionLog,
  formatManualTakeContextStart,
  ManualTakeContext,
  ManualTakeRuntimeConfig,
  ResolvedManualTakeContext,
  resolveManualTakeContext,
} from './manual-context';
import { createArbTakeStrategy } from './arb-strategy';

export type {
  OneInchExecutionConfig,
  OneInchQuoteConfig,
} from './one-inch-types';
export {
  getOneInchPathQuoteEvaluation,
  getOneInchTakeQuoteEvaluation,
  takeLiquidation,
} from './one-inch-execution';
export {
  createNoExternalTakeAdapter,
  createOneInchTakeAdapter,
} from './one-inch-adapter';
export { createLifiTakeAdapter } from './lifi-adapter';
export type {
  TakeAuctionStatus,
  TakeAuctionStatusReader,
} from './liquidation-status';
export {
  createTakeAuctionStatusReader,
  defaultTakeAuctionStatusReader,
} from './liquidation-status';

type HandleTakeConfig = WithSubgraph<ManualTakeRuntimeConfig>;
type HandleTakeConfigInput = SubgraphConfigInput<ManualTakeRuntimeConfig>;

interface HandleTakeParams {
  signer: Signer;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
  pool: FungiblePool;
  poolConfig: RequireFields<PoolConfig, 'take'>;
  config: HandleTakeConfigInput;
}

interface ResolvedHandleTakeParams extends Omit<HandleTakeParams, 'config'> {
  config: HandleTakeConfig;
  context: ResolvedManualTakeContext;
}

export async function handleTakes({
  signer,
  takeWriteTransport,
  pool,
  poolConfig,
  config,
}: HandleTakeParams) {
  const resolvedConfig: HandleTakeConfig = resolveSubgraphConfig(config);
  const resolvedManualTakeContext = resolveManualTakeContext({
    poolConfig,
    config: resolvedConfig,
    takeWriteTransport,
  });
  const deploymentResolution = resolvedManualTakeContext.deploymentResolution;
  const deploymentType = deploymentResolution.deploymentType;
  const deploymentLog = formatManualTakeDeploymentResolutionLog({
    resolution: deploymentResolution,
    poolName: pool.name,
  });

  if (deploymentLog.level === 'warn') {
    logger.warn(deploymentLog.message);
  } else {
    logger.debug(deploymentLog.message);
  }

  logger.debug(
    `Detection Results - Pool: ${pool.name}, Requested Source: ${deploymentResolution.requestedLiquiditySourceLabel}, Type: ${deploymentType}`
  );

  if (deploymentType === 'none') {
    logger.warn(
      formatManualTakeDeploymentFallback({
        resolution: deploymentResolution,
        poolName: pool.name,
      })
    );
  } else {
    logger.debug(
      formatManualExternalTakeDeployment({
        deploymentType,
        poolName: pool.name,
      })
    );
  }

  await runResolvedManualTakeCandidates({
    signer,
    takeWriteTransport,
    pool,
    poolConfig: resolvedManualTakeContext.effectivePoolConfig,
    config: resolvedConfig,
    context: resolvedManualTakeContext.context,
  });
}

export async function processManualTakeCandidates(
  params: HandleTakeParams
): Promise<void> {
  const resolvedConfig = resolveSubgraphConfig(params.config);
  const resolvedManualTakeContext = resolveManualTakeContext({
    poolConfig: params.poolConfig,
    config: resolvedConfig,
    takeWriteTransport: params.takeWriteTransport,
  });
  await runResolvedManualTakeCandidates({
    ...params,
    poolConfig: resolvedManualTakeContext.effectivePoolConfig,
    config: resolvedConfig,
    context: resolvedManualTakeContext.context,
  });
}

async function runResolvedManualTakeCandidates({
  signer,
  takeWriteTransport,
  pool,
  poolConfig,
  config,
  context,
}: ResolvedHandleTakeParams): Promise<void> {
  const candidates = await getTakeBorrowerCandidates({
    subgraph: config.subgraph,
    poolAddress: pool.poolAddress,
    minCollateral: poolConfig.take.minCollateral ?? 0,
  });

  logger.debug(
    formatManualTakeContextStart({ poolConfig, poolName: pool.name })
  );
  await runManualTakeCandidateEngine({
    pool,
    signer,
    poolConfig,
    candidates,
    subgraph: config.subgraph,
    dryRun: config.dryRun ?? false,
    takeWriteTransport,
    context,
  });
}

async function runManualTakeCandidateEngine<TExecutionConfig>(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  candidates: TakeBorrowerCandidate[];
  subgraph: HandleTakeConfig['subgraph'];
  dryRun: boolean;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
  context: ManualTakeContext<TExecutionConfig>;
}): Promise<void> {
  await processTakeCandidates({
    pool: params.pool,
    signer: params.signer,
    poolConfig: params.poolConfig,
    candidates: params.candidates,
    subgraph: params.subgraph,
    externalTakeAdapter: params.context.externalTakeAdapter,
    arbTakeStrategy: params.context.arbTakeStrategy,
    externalExecutionConfig: params.context.externalExecutionConfig,
    dryRun: params.dryRun,
    takeWriteTransport: params.takeWriteTransport,
    onFound: (decision) => {
      const message = `Found liquidation to ${formatTakeStrategyLog(
        params.context.externalTakeAdapter.kind,
        decision.approvedTake,
        decision.approvedArbTake
      )} - pool: ${params.pool.name}, borrower: ${decision.borrower}, auctionPrice: ${Number(
        weiToDecimaled(decision.auctionPrice)
      ).toFixed(6)}, collateral: ${weiToDecimaled(decision.collateral)}`;
      if (params.context.foundLogLevel === 'debug') {
        logger.debug(message);
        return;
      }
      logger.info(message);
    },
    onSkip: ({ candidate, reason }) => {
      logSkippedTakeCandidate({
        pool: params.pool,
        borrower: candidate.borrower,
        reason,
        prefix: params.context.logPrefix,
      });
    },
  });
}

interface GetLiquidationsToTakeParams
  extends Pick<HandleTakeParams, 'pool' | 'poolConfig' | 'signer'> {
  config: SubgraphConfigInput<ManualTakeRuntimeConfig>;
}

export async function* getLiquidationsToTake({
  pool,
  poolConfig,
  signer,
  config,
}: GetLiquidationsToTakeParams): AsyncGenerator<TakeLiquidationPlan> {
  const resolvedConfig = resolveSubgraphConfig(config);
  const resolvedManualTakeContext = resolveManualTakeContext({
    poolConfig,
    config: resolvedConfig,
  });
  const effectivePoolConfig = resolvedManualTakeContext.effectivePoolConfig;
  const candidates = await getTakeBorrowerCandidates({
    subgraph: resolvedConfig.subgraph,
    poolAddress: pool.poolAddress,
    minCollateral: effectivePoolConfig.take.minCollateral ?? 0,
  });
  const externalTakeAdapter =
    resolvedManualTakeContext.context.externalTakeAdapter;
  const arbTakeStrategy = createArbTakeStrategy();

  for (const candidate of candidates) {
    const decision = await evaluateTakeDecision({
      pool,
      signer,
      poolConfig: effectivePoolConfig,
      candidate,
      subgraph: resolvedConfig.subgraph,
      externalTakeAdapter,
      arbTakeStrategy,
    });

    if (decision.approvedTake || decision.approvedArbTake) {
      logger.info(
        `Found liquidation to ${formatTakeStrategyLog(
          externalTakeAdapter.kind,
          decision.approvedTake,
          decision.approvedArbTake
        )} - pool: ${pool.name}, borrower: ${decision.borrower}, auctionPrice: ${Number(
          weiToDecimaled(decision.auctionPrice)
        ).toFixed(6)}, collateral: ${weiToDecimaled(decision.collateral)}`
      );

      yield {
        borrower: decision.borrower,
        hpbIndex: decision.hpbIndex,
        collateral: decision.collateral,
        auctionPrice: decision.auctionPrice,
        isTakeable: decision.approvedTake,
        isArbTakeable: decision.approvedArbTake,
        externalTakeExecutionPlan: decision.externalTakeExecutionPlan,
      };
      continue;
    }

    logger.debug(
      `Not taking liquidation - pool: ${pool.name}, borrower: ${decision.borrower}, auctionPrice: ${Number(
        weiToDecimaled(decision.auctionPrice)
      ).toFixed(6)}, reason: ${decision.reason}`
    );
  }
}
