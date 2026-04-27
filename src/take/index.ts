import { Signer, FungiblePool } from '@ajna-finance/sdk';
import {
  delay,
  estimateGasWithBuffer,
  RequireFields,
  weiToDecimaled,
} from '../utils';
import { KeeperConfig, LiquiditySource, PoolConfig } from '../config';
import { logger } from '../logging';
import { DexRouter } from '../dex/router';
import { BigNumber, ethers } from 'ethers';
import {
  convertSwapApiResponseToDetails,
  encodeOneInchSwapDetailsBytes,
  validateOneInchSwapDetailsForAtomicTake,
} from '../dex/one-inch';
import { AjnaKeeperTaker__factory } from '../../typechain-types';
import { convertWadToTokenDecimals, getDecimalsErc20 } from '../erc20';
import { NonceTracker } from '../nonce';
import { SmartDexManager } from '../dex/manager';
import {
  resolveSubgraphConfig,
  SubgraphConfigInput,
  WithSubgraph,
} from '../read-transports';
import * as factoryShared from './factory/shared';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
  TakeWriteTransportConfig,
} from './write-transport';
import {
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeBorrowerCandidate,
  TakeLiquidationPlan,
} from './types';
import {
  ExternalTakeAdapter,
  evaluateTakeDecision,
  formatTakeStrategyLog,
  getTakeBorrowerCandidates,
  logSkippedTakeCandidate,
  processTakeCandidates,
} from './engine';
import { logTakeExecutionTelemetry } from './execution-telemetry';
import {
  createManualFactoryTakeContext,
  createManualSingleContractTakeContext,
  isFactoryExternalTakeSource,
  ManualTakeContext,
  stripExternalTakeSettings,
} from './manual-context';
import { OneInchExecutionConfig, OneInchQuoteConfig } from './one-inch-types';
import { createArbTakeStrategy } from './arb-strategy';

export type {
  OneInchExecutionConfig,
  OneInchQuoteConfig,
} from './one-inch-types';

const MAX_ONEINCH_TOKEN_DECIMAL_CACHE_ENTRIES = 512;
interface VerifiedOneInchChainCheck {
  provider?: object;
  pending: Promise<void>;
}
const verifiedOneInchChainIds = new WeakMap<
  object,
  Map<number, VerifiedOneInchChainCheck>
>();

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

async function getOneInchTokenDecimals(params: {
  signer: Signer;
  tokenAddress: string;
  chainId?: number;
  cache?: Map<string, number>;
}): Promise<number> {
  const cacheKey = `${params.chainId ?? 'unknown'}:${params.tokenAddress.toLowerCase()}`;
  const cached = params.cache?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const decimals = await getDecimalsErc20(
    params.signer,
    params.tokenAddress,
    params.chainId
  );
  if (params.cache) {
    params.cache.set(cacheKey, decimals);
    while (params.cache.size > MAX_ONEINCH_TOKEN_DECIMAL_CACHE_ENTRIES) {
      const oldestKey = params.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      params.cache.delete(oldestKey);
    }
  }
  return decimals;
}

async function assertConfiguredChainIdMatchesSigner(
  signer: Signer,
  configuredChainId: number
): Promise<void> {
  if (typeof signer !== 'object' || signer === null) {
    return;
  }
  const provider = (signer as { provider?: object }).provider;
  let signerChecks = verifiedOneInchChainIds.get(signer);
  if (!signerChecks) {
    signerChecks = new Map();
    verifiedOneInchChainIds.set(signer, signerChecks);
  }
  const cached = signerChecks.get(configuredChainId);
  if (cached !== undefined && cached.provider === provider) {
    await cached.pending;
    return;
  }

  const check: VerifiedOneInchChainCheck = {
    provider,
    pending: (async () => {
      const signerChainId = await signer.getChainId();
      if (signerChainId !== configuredChainId) {
        throw new Error(
          `configured 1inch chainId ${configuredChainId} does not match signer chainId ${signerChainId}`
        );
      }
    })(),
  };
  signerChecks.set(configuredChainId, check);
  try {
    await check.pending;
  } finally {
    if (signerChecks.get(configuredChainId) === check) {
      signerChecks.delete(configuredChainId);
    }
  }
}

async function resolveOneInchChainId(
  config: Partial<Pick<OneInchQuoteConfig, 'chainId'>>,
  signer: Signer
): Promise<number> {
  if (config.chainId === undefined) {
    return await signer.getChainId();
  }
  await assertConfiguredChainIdMatchesSigner(signer, config.chainId);
  return config.chainId;
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
    case 'single':
      logger.debug(
        `Using single-contract external take strategy for pool: ${pool.name}`
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

  await processResolvedManualTakeCandidates({
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
  await processResolvedManualTakeCandidates({
    ...params,
    config: resolveSubgraphConfig(params.config),
  });
}

async function processResolvedManualTakeCandidates({
  signer,
  takeWriteTransport,
  pool,
  poolConfig,
  config,
}: ResolvedHandleTakeParams): Promise<void> {
  const resolvedConfig = config;
  const candidates = await getTakeBorrowerCandidates({
    subgraph: resolvedConfig.subgraph,
    poolAddress: pool.poolAddress,
    minCollateral: poolConfig.take.minCollateral ?? 0,
  });

  if (isFactoryExternalTakeSource(poolConfig.take.liquiditySource)) {
    logger.debug(
      `Manual factory external take context starting for pool: ${pool.name}`
    );
    const context = createManualFactoryTakeContext({
      config: resolvedConfig,
      takeWriteTransport,
    });
    await runManualTakeCandidateEngine({
      pool,
      signer,
      poolConfig,
      candidates,
      subgraph: resolvedConfig.subgraph,
      delayBetweenActions: resolvedConfig.delayBetweenActions ?? 0,
      dryRun: resolvedConfig.dryRun ?? false,
      takeWriteTransport,
      context,
    });
    return;
  }

  logger.debug(
    `Manual single-contract take context starting for pool: ${pool.name}`
  );
  const context = createManualSingleContractTakeContext({
    poolConfig,
    config: resolvedConfig,
    takeWriteTransport,
    adapters: {
      createOneInchTakeAdapter,
      createNoExternalTakeAdapter,
    },
  });
  await runManualTakeCandidateEngine({
    pool,
    signer,
    poolConfig,
    candidates,
    subgraph: resolvedConfig.subgraph,
    delayBetweenActions: resolvedConfig.delayBetweenActions ?? 0,
    dryRun: resolvedConfig.dryRun ?? false,
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

export function createNoExternalTakeAdapter(): ExternalTakeAdapter<
  TakeActionConfig,
  OneInchExecutionConfig
> {
  return {
    kind: 'none',
  };
}

export function createOneInchTakeAdapter(
  quoteConfig: OneInchQuoteConfig
): ExternalTakeAdapter<TakeActionConfig, OneInchExecutionConfig> {
  return {
    kind: 'oneinch',
    evaluateExternalTake: async ({
      pool,
      signer,
      poolConfig,
      price,
      collateral,
    }) =>
      getOneInchTakeQuoteEvaluation(
        pool,
        price,
        collateral,
        poolConfig,
        {
          delayBetweenActions: quoteConfig.delayBetweenActions,
          oneInchRequestTimeoutMs: quoteConfig.oneInchRequestTimeoutMs,
          skipOneInchRateLimitDelay: quoteConfig.skipOneInchRateLimitDelay,
        },
        signer,
        quoteConfig.oneInchRouters,
        quoteConfig.connectorTokens
      ),
    executeExternalTake: async ({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    }) =>
      takeLiquidation({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }),
  };
}

interface GetLiquidationsToTakeParams
  extends Pick<HandleTakeParams, 'pool' | 'poolConfig' | 'signer'> {
  config: SubgraphConfigInput<
    Pick<KeeperConfig, 'oneInchRouters' | 'connectorTokens'> &
      Partial<Pick<KeeperConfig, 'delayBetweenActions'>>
  >;
}

export async function getOneInchTakeQuoteEvaluation(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<OneInchQuoteConfig>,
  signer: Signer,
  oneInchRouters: { [chainId: number]: string } | undefined,
  connectorTokens: string[] | undefined
): Promise<ExternalTakeQuoteEvaluation> {
  if (
    poolConfig.take.liquiditySource !== LiquiditySource.ONEINCH ||
    !poolConfig.take.marketPriceFactor
  ) {
    return {
      isTakeable: false,
      reason: '1inch take settings are not configured',
    };
  }

  return getOneInchPathQuoteEvaluation(
    pool,
    price,
    collateral,
    poolConfig,
    config,
    signer,
    oneInchRouters,
    connectorTokens
  );
}

export async function getOneInchPathQuoteEvaluation(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<OneInchQuoteConfig>,
  signer: Signer,
  oneInchRouters: { [chainId: number]: string } | undefined,
  connectorTokens: string[] | undefined
): Promise<ExternalTakeQuoteEvaluation> {
  if (!poolConfig.take.marketPriceFactor) {
    return {
      isTakeable: false,
      reason: '1inch marketPriceFactor is not configured',
    };
  }

  if (!collateral.gt(0)) {
    logger.debug(
      `Invalid collateral amount: ${collateral.toString()} for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'collateral must be greater than zero',
    };
  }

  try {
    const chainId = await resolveOneInchChainId(config, signer);
    if (!oneInchRouters || !oneInchRouters[chainId]) {
      logger.debug(
        `No 1inch router configured for chainId ${chainId} in pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: `missing 1inch router for chain ${chainId}`,
      };
    }

    if (!config.skipOneInchRateLimitDelay) {
      // Manual/single-contract 1inch mode still honors operator pacing.
      await delay(config.delayBetweenActions ?? 0);
    }

    const dexRouter = new DexRouter(signer, {
      oneInchRouters: oneInchRouters ?? {},
      connectorTokens: connectorTokens ?? [],
    });

    // 1inch expects collateral amounts in token-native decimals, not WAD.
    const collateralDecimals = await getOneInchTokenDecimals({
      signer,
      tokenAddress: pool.collateralAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    const collateralInTokenDecimals = convertWadToTokenDecimals(
      collateral,
      collateralDecimals
    );

    const quoteResult = await dexRouter.getQuoteFromOneInch(
      chainId,
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      { timeoutMs: config.oneInchRequestTimeoutMs }
    );

    if (!quoteResult.success) {
      logger.debug(
        `No valid quote data for collateral ${ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)} in pool ${pool.name}: ${quoteResult.error}`
      );
      return {
        isTakeable: false,
        reason: quoteResult.error ?? '1inch quote failed',
        quoteFailureRetryable: quoteResult.retryable,
        quoteFailureCode: quoteResult.errorCode,
      };
    }

    const amountOut = ethers.BigNumber.from(quoteResult.dstAmount);
    if (amountOut.isZero()) {
      logger.debug(
        `Zero amountOut for collateral ${ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)} in pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: '1inch returned zero amountOut',
      };
    }

    const quoteDecimals = await getOneInchTokenDecimals({
      signer,
      tokenAddress: pool.quoteAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });

    //collateralAmount is the human readable amount
    const collateralAmount = Number(
      ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals) // ← Use converted amount
    );

    //quoteAmount is supposed to be the human readable amount
    const quoteAmount = Number(
      ethers.utils.formatUnits(amountOut, quoteDecimals)
    );

    const marketPrice = quoteAmount / collateralAmount;
    const takeablePrice = marketPrice * poolConfig.take.marketPriceFactor;

    const takeable = price <= takeablePrice;
    logger.info(
      `Take check for pool ${pool.name}: marketPrice=${marketPrice.toFixed(6)}, takeablePrice=${takeablePrice.toFixed(6)}, auctionPrice=${price.toFixed(6)}, collateral=${collateralAmount}, factor=${poolConfig.take.marketPriceFactor} → ${takeable ? 'TAKEABLE' : 'skip'}`
    );

    return {
      isTakeable: takeable,
      externalTakePath: 'oneinch',
      marketPrice,
      takeablePrice,
      quoteAmount,
      quoteAmountRaw: amountOut,
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      collateralAmount,
      quotedCollateralWad: collateral,
      reason: takeable
        ? undefined
        : 'auction price above external take threshold',
    };
  } catch (error) {
    logger.error(`Failed to fetch quote data for pool ${pool.name}: ${error}`);
    return {
      isTakeable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function computeOneInchAtomicMinReturnAmount(params: {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
}): Promise<BigNumber> {
  if (!params.poolConfig.take.marketPriceFactor) {
    throw new Error('1inch atomic execution requires marketPriceFactor');
  }
  if (!params.quoteEvaluation.quoteAmountRaw) {
    throw new Error('1inch atomic execution requires quoteAmountRaw');
  }

  const quoteAmountDueRaw = await factoryShared.getQuoteAmountDueRaw(
    params.pool,
    params.liquidation.auctionPrice,
    params.liquidation.collateral
  );
  const profitabilityFloor = factoryShared.ceilDiv(
    quoteAmountDueRaw.mul(factoryShared.MARKET_FACTOR_SCALE),
    BigNumber.from(
      factoryShared.getMarketPriceFactorUnits(
        params.poolConfig.take.marketPriceFactor
      )
    )
  );
  const slippageFloor = params.quoteEvaluation.quoteAmountRaw
    .mul(
      factoryShared.BASIS_POINTS_DENOMINATOR -
        factoryShared.getSlippageBasisPoints(1)
    )
    .div(factoryShared.BASIS_POINTS_DENOMINATOR);
  const approvedMinOutRaw =
    factoryShared.deriveApprovedMinOutRaw({
      routeMinOutRaw: params.quoteEvaluation.routeMinOutRaw,
      profitMinOutRaw: params.quoteEvaluation.profitMinOutRaw,
      fallbackMinOutRaw: params.quoteEvaluation.approvedMinOutRaw,
    }) ?? BigNumber.from(0);

  return factoryShared.maxBigNumber(
    quoteAmountDueRaw,
    profitabilityFloor,
    slippageFloor,
    approvedMinOutRaw
  );
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
      `Not taking liquidation - pool: ${pool.name}, borrower: ${decision.borrower}, reason: ${decision.reason ?? 'policy rejected candidate'}`
    );
  }
}

interface TakeLiquidationParams
  extends Pick<HandleTakeParams, 'pool' | 'signer'> {
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: OneInchExecutionConfig;
}

export async function takeLiquidation({
  pool,
  poolConfig,
  signer,
  liquidation,
  config,
}: TakeLiquidationParams): Promise<boolean> {
  const { borrower } = liquidation;
  const { dryRun } = config;

  if (dryRun) {
    const selectedLiquiditySource =
      liquidation.externalTakeQuoteEvaluation?.selectedLiquiditySource ??
      poolConfig.take.liquiditySource;
    logger.info(
      `DryRun - would Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower} using ${selectedLiquiditySource}`
    );
    return true;
  }

  const suppliedQuoteEvaluation = liquidation.externalTakeQuoteEvaluation;
  const usesOneInchExecutionPath =
    poolConfig.take.liquiditySource === LiquiditySource.ONEINCH ||
    suppliedQuoteEvaluation?.externalTakePath === 'oneinch' ||
    suppliedQuoteEvaluation?.selectedLiquiditySource ===
      LiquiditySource.ONEINCH;
  if (!usesOneInchExecutionPath) {
    logger.error(
      `Valid liquidity source not configured. Skipping liquidation of poolAddress: ${pool.poolAddress}, borrower: ${borrower}.`
    );
    return false;
  }

  let attemptedSubmission = false;
  try {
    const approvedQuoteEvaluation =
      suppliedQuoteEvaluation ??
      (await getOneInchTakeQuoteEvaluation(
        pool,
        Number(weiToDecimaled(liquidation.auctionPrice)),
        liquidation.collateral,
        poolConfig,
        {
          delayBetweenActions: config.delayBetweenActions,
          oneInchRequestTimeoutMs: config.oneInchRequestTimeoutMs,
          skipOneInchRateLimitDelay: config.skipOneInchRateLimitDelay,
          chainId: config.chainId,
          tokenDecimalsCache: config.tokenDecimalsCache,
        },
        signer,
        config.oneInchRouters,
        config.connectorTokens
      ));

    if (!approvedQuoteEvaluation.isTakeable) {
      logger.error(
        `1inch atomic take quote no longer satisfies execution policy for ${pool.name}/${borrower}: ${approvedQuoteEvaluation.reason ?? 'not takeable'}`
      );
      return false;
    }

    if (!approvedQuoteEvaluation.quoteAmountRaw) {
      logger.error(
        `1inch atomic take is missing raw quote amount for ${pool.name}/${borrower}; refusing to send an unbounded swap`
      );
      return false;
    }

    const takeWriteTransport = resolveTakeWriteTransport(signer, config);
    const keeperTaker = AjnaKeeperTaker__factory.connect(
      config.keeperTaker!,
      signer
    );

    const dexRouter = new DexRouter(signer, {
      oneInchRouters: config.oneInchRouters ?? {},
      connectorTokens: config.connectorTokens ?? [],
    });
    const chainId = await resolveOneInchChainId(config, signer);
    const configuredOneInchRouter = dexRouter.getRouter(chainId);
    if (!configuredOneInchRouter) {
      const error = `missing 1inch router for chain ${chainId}`;
      config.onOneInchSwapDataResult?.({
        success: false,
        retryable: false,
        error,
      });
      logger.error(
        `1inch atomic take cannot request swap data for ${pool.name}/${borrower}: ${error}`
      );
      return false;
    }

    if (!config.skipOneInchRateLimitDelay) {
      // Manual/single-contract 1inch mode still honors operator pacing.
      await delay(config.delayBetweenActions ?? 0);
    }

    // Convert collateral from WAD to token decimals for 1inch API consistency
    const collateralDecimals = await getOneInchTokenDecimals({
      signer,
      tokenAddress: pool.collateralAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    const collateralInTokenDecimals = convertWadToTokenDecimals(
      liquidation.collateral,
      collateralDecimals
    );

    const swapData = await dexRouter.getSwapDataFromOneInch(
      chainId,
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      1,
      keeperTaker.address,
      true,
      { timeoutMs: config.oneInchRequestTimeoutMs }
    );
    if (!swapData.success || !swapData.data) {
      config.onOneInchSwapDataResult?.({
        success: false,
        retryable: swapData.retryable,
        errorCode: swapData.errorCode,
        error: swapData.error,
      });
      logger.error(
        `1inch atomic swap data request failed for ${pool.name}/${borrower}: ${swapData.error ?? 'unknown error'}`
      );
      return false;
    }
    const swapDetails = convertSwapApiResponseToDetails(swapData.data);
    const allowedAggregationExecutors =
      config.oneInchAggregationExecutorAllowlist?.[chainId];
    const swapDetailsValidationError = validateOneInchSwapDetailsForAtomicTake(
      swapDetails,
      {
        srcToken: pool.collateralAddress,
        dstToken: pool.quoteAddress,
        srcReceiver: configuredOneInchRouter,
        dstReceiver: keeperTaker.address,
        amount: collateralInTokenDecimals,
        aggregationExecutors: allowedAggregationExecutors,
      }
    );
    if (swapDetailsValidationError) {
      config.onOneInchSwapDataResult?.({
        success: false,
        retryable: false,
        error: swapDetailsValidationError,
      });
      logger.error(
        `1inch atomic swap data validation failed for ${pool.name}/${borrower}: ${swapDetailsValidationError}`
      );
      return false;
    }
    logger.info(
      `1inch atomic take swap validated - pool: ${pool.name}, borrower: ${borrower}, executor: ${swapDetails.aggregationExecutor}, srcReceiver: ${swapDetails.swapDescription.srcReceiver}, allowlist: ${allowedAggregationExecutors ? 'configured' : 'not_configured'}`
    );

    const requiredMinReturnAmount = await computeOneInchAtomicMinReturnAmount({
      pool,
      poolConfig,
      liquidation,
      quoteEvaluation: approvedQuoteEvaluation,
    });

    const routeMinReturnAmount = BigNumber.from(
      swapDetails.swapDescription.minReturnAmount
    );
    const executionMinReturnAmount = routeMinReturnAmount.lt(
      requiredMinReturnAmount
    )
      ? requiredMinReturnAmount
      : routeMinReturnAmount;
    if (swapData.dstAmount !== undefined) {
      const freshSwapDstAmount = BigNumber.from(swapData.dstAmount);
      if (freshSwapDstAmount.lt(executionMinReturnAmount)) {
        config.onOneInchSwapDataResult?.({
          success: false,
          retryable: false,
          error: '1inch swap data expected output below execution floor',
        });
        logger.warn(
          `1inch atomic swap data expected output ${freshSwapDstAmount.toString()} is below execution floor ${executionMinReturnAmount.toString()} for ${pool.name}/${borrower}; refusing to estimate or submit`
        );
        return false;
      }
    }
    config.onOneInchSwapDataResult?.({ success: true });
    if (routeMinReturnAmount.lt(executionMinReturnAmount)) {
      swapDetails.swapDescription = {
        ...swapDetails.swapDescription,
        minReturnAmount: executionMinReturnAmount,
      };
    }
    const swapDetailsBytes = encodeOneInchSwapDetailsBytes(swapDetails);

    logger.debug(
      `Preparing takeWithAtomicSwap transaction:\n` +
        `  Pool: ${pool.poolAddress}\n` +
        `  Borrower: ${liquidation.borrower}\n` +
        `  Auction Price (WAD): ${liquidation.auctionPrice.toString()}\n` +
        `  Collateral (WAD): ${liquidation.collateral.toString()}\n` +
        `  Collateral (Token Decimals): ${collateralInTokenDecimals.toString()}\n` +
        `  Liquidity Source: ${LiquiditySource.ONEINCH}\n` +
        `  1inch Router: ${configuredOneInchRouter}\n` +
        `  Required Min Return: ${executionMinReturnAmount.toString()}\n` +
        `  Swap Data Length: ${swapData.data.length} chars`
    );

    logger.debug(
      `Sending Take Tx - poolAddress: ${pool.poolAddress}, borrower: ${borrower}`
    );
    await NonceTracker.queueTransaction(
      takeWriteTransport.signer,
      async (nonce: number) => {
        const fallbackGasLimit = ethers.BigNumber.from(1_500_000);
        const txArgs = [
          pool.poolAddress,
          liquidation.borrower,
          liquidation.auctionPrice,
          liquidation.collateral,
          Number(LiquiditySource.ONEINCH),
          configuredOneInchRouter,
          swapDetailsBytes,
        ] as const;
        const gasLimit = await estimateGasWithBuffer(
          () => keeperTaker.estimateGas.takeWithAtomicSwap(...txArgs),
          fallbackGasLimit,
          `Take ${pool.name}/${borrower}`
        );
        const txRequest =
          await keeperTaker.populateTransaction.takeWithAtomicSwap(...txArgs, {
            gasLimit,
            nonce: nonce.toString(),
          });
        attemptedSubmission = true;
        const receipt = await submitTakeTransaction(
          takeWriteTransport,
          txRequest
        );
        logTakeExecutionTelemetry({
          path: 'oneinch',
          source: LiquiditySource.ONEINCH,
          poolName: pool.name,
          poolAddress: pool.poolAddress,
          borrower,
          receipt,
          routeProfitability: approvedQuoteEvaluation.routeProfitability,
          approvedMinOutRaw: executionMinReturnAmount,
          takeWriteTransport,
        });
        logger.info(
          `Take successful - pool: ${pool.name}, borrower: ${borrower} | tx: ${receipt.transactionHash}`
        );
        return receipt;
      }
    );
    return true;
  } catch (error) {
    config.onOneInchExecutionFailure?.({
      preBroadcast: !attemptedSubmission,
      error: error instanceof Error ? error.message : String(error),
    });
    logger.error(
      `Failed to Take. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
    return false;
  }
}
