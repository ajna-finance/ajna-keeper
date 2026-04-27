import { Signer, FungiblePool } from '@ajna-finance/sdk';
import { RequireFields, weiToDecimaled } from '../utils';
import { KeeperConfig, LiquiditySource, PoolConfig } from '../config';
import { logger } from '../logging';
import { SmartDexManager } from '../dex/manager';
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
  createManualFactoryTakeContext,
  createManualOneInchTakeContext,
  isFactoryExternalTakeSource,
  ManualTakeContext,
  stripExternalTakeSettings,
} from './manual-context';
import {
  createNoExternalTakeAdapter,
  createOneInchTakeAdapter,
} from './one-inch-adapter';
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

type HandleTakeConfigBase = Pick<
  KeeperConfig,
  | 'dryRun'
  | 'delayBetweenActions'
  | 'connectorTokens'
  | 'oneInchRouters'
  | 'oneInchAggregationExecutorAllowlist'
  | 'keeperTaker'
  | 'keeperTakerFactory'
  | 'takerContracts'
  | 'universalRouterOverrides'
  | 'sushiswapRouterOverrides'
  | 'curveRouterOverrides'
  | 'tokenAddresses'
>;

type HandleTakeConfig = WithSubgraph<HandleTakeConfigBase>;
type HandleTakeConfigInput = SubgraphConfigInput<HandleTakeConfigBase>;

interface HandleTakeParams {
  signer: Signer;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
  pool: FungiblePool;
  poolConfig: RequireFields<PoolConfig, 'take'>;
  config: HandleTakeConfigInput;
}

interface ResolvedHandleTakeParams extends Omit<HandleTakeParams, 'config'> {
  config: HandleTakeConfig;
}

export async function handleTakes({
  signer,
  takeWriteTransport,
  pool,
  poolConfig,
  config,
}: HandleTakeParams) {
  const resolvedConfig: HandleTakeConfig = resolveSubgraphConfig(config);
  const dexManager = new SmartDexManager(signer, resolvedConfig);
  const requestedLiquiditySource = poolConfig.take.liquiditySource;
  const deploymentType =
    await dexManager.detectDeploymentTypeForPool(poolConfig);
  const validation = await dexManager.validateDeploymentForPool(poolConfig);

  logger.debug(
    `Detection Results - Pool: ${pool.name}, Requested Source: ${requestedLiquiditySource ?? 'arb-only'}, Type: ${deploymentType}, Valid: ${validation.valid}`
  );
  if (!validation.valid) {
    logger.error(`Configuration errors: ${validation.errors.join(', ')}`);
  }

  let effectivePoolConfig = poolConfig;
  switch (deploymentType) {
    case 'oneinch':
      logger.debug(
        `Using manual 1inch external take strategy for pool: ${pool.name}`
      );
      break;

    case 'factory':
      logger.debug(
        `Using factory external take strategy for pool: ${pool.name}`
      );
      break;

    case 'none':
      logger.warn(
        `External liquidity source ${requestedLiquiditySource ?? 'none'} unavailable for pool ${pool.name} - checking arbTake only`
      );
      effectivePoolConfig = stripExternalTakeSettings(poolConfig);
      break;
  }

  await runResolvedManualTakeCandidates({
    signer,
    takeWriteTransport,
    pool,
    poolConfig: effectivePoolConfig,
    config: resolvedConfig,
  });
}

export async function processManualTakeCandidates(
  params: HandleTakeParams
): Promise<void> {
  // Lower-level entrypoint for tests and direct callers; SmartDex deployment
  // detection is intentionally handled by handleTakes().
  await runResolvedManualTakeCandidates({
    ...params,
    config: resolveSubgraphConfig(params.config),
  });
}

async function runResolvedManualTakeCandidates({
  signer,
  takeWriteTransport,
  pool,
  poolConfig,
  config,
}: ResolvedHandleTakeParams): Promise<void> {
  const candidates = await getTakeBorrowerCandidates({
    subgraph: config.subgraph,
    poolAddress: pool.poolAddress,
    minCollateral: poolConfig.take.minCollateral ?? 0,
  });

  if (isFactoryExternalTakeSource(poolConfig.take.liquiditySource)) {
    logger.debug(
      `Manual factory external take context starting for pool: ${pool.name}`
    );
    const context = createManualFactoryTakeContext({
      config,
      takeWriteTransport,
    });
    await runManualTakeCandidateEngine({
      pool,
      signer,
      poolConfig,
      candidates,
      subgraph: config.subgraph,
      delayBetweenActions: config.delayBetweenActions ?? 0,
      dryRun: config.dryRun ?? false,
      takeWriteTransport,
      context,
    });
    return;
  }

  logger.debug(
    `${poolConfig.take.liquiditySource === LiquiditySource.ONEINCH ? 'Manual 1inch take context' : 'Manual arbTake context'} starting for pool: ${pool.name}`
  );
  const context = createManualOneInchTakeContext({
    poolConfig,
    config,
    takeWriteTransport,
  });
  await runManualTakeCandidateEngine({
    pool,
    signer,
    poolConfig,
    candidates,
    subgraph: config.subgraph,
    delayBetweenActions: config.delayBetweenActions ?? 0,
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
  delayBetweenActions: number;
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
    delayBetweenActions: params.delayBetweenActions,
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
  config: SubgraphConfigInput<
    Pick<
      KeeperConfig,
      'oneInchRouters' | 'oneInchDefaultSlippage' | 'connectorTokens'
    > &
      Partial<Pick<KeeperConfig, 'delayBetweenActions'>>
  >;
}

export async function* getLiquidationsToTake({
  pool,
  poolConfig,
  signer,
  config,
}: GetLiquidationsToTakeParams): AsyncGenerator<TakeLiquidationPlan> {
  const resolvedConfig = resolveSubgraphConfig(config);
  const candidates = await getTakeBorrowerCandidates({
    subgraph: resolvedConfig.subgraph,
    poolAddress: pool.poolAddress,
    minCollateral: poolConfig.take.minCollateral ?? 0,
  });
  const externalTakeAdapter =
    poolConfig.take.liquiditySource === LiquiditySource.ONEINCH
      ? createOneInchTakeAdapter({
          delayBetweenActions: resolvedConfig.delayBetweenActions ?? 0,
          oneInchDefaultSlippage: resolvedConfig.oneInchDefaultSlippage,
          oneInchRouters: resolvedConfig.oneInchRouters,
          connectorTokens: resolvedConfig.connectorTokens,
        })
      : createNoExternalTakeAdapter();
  const arbTakeStrategy = createArbTakeStrategy();

  for (const candidate of candidates) {
    const decision = await evaluateTakeDecision({
      pool,
      signer,
      poolConfig,
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
        externalTakeQuoteEvaluation: decision.quoteEvaluation,
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
