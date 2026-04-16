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
import { handleFactoryTakes } from './factory';
import * as factoryShared from './factory/shared';
import {
  arbTakeLiquidation,
  checkIfArbTakeable,
} from './arb';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
  TakeWriteTransportConfig,
} from './write-transport';
import {
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from './types';
import {
  ExternalTakeAdapter,
  formatTakeStrategyLog,
  getTakeBorrowerCandidates,
  logSkippedTakeCandidate,
  processTakeCandidates,
} from './engine';

type HandleTakeConfigBase = Pick<
  KeeperConfig,
  | 'dryRun'
  | 'delayBetweenActions'
  | 'connectorTokens'
  | 'oneInchRouters'
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

type OneInchExecutionConfig = Pick<
  KeeperConfig,
  | 'dryRun'
  | 'delayBetweenActions'
  | 'connectorTokens'
  | 'oneInchRouters'
  | 'keeperTaker'
> &
  TakeWriteTransportConfig;

type OneInchQuoteConfig = Pick<
  KeeperConfig,
  'delayBetweenActions' | 'oneInchRouters' | 'connectorTokens'
>;

function stripExternalTakeSettings(
  poolConfig: RequireFields<PoolConfig, 'take'>
): RequireFields<PoolConfig, 'take'> {
  return {
    ...poolConfig,
    take: {
      ...poolConfig.take,
      liquiditySource: undefined,
      marketPriceFactor: undefined,
    },
  };
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
  const deploymentType = await dexManager.detectDeploymentTypeForPool(poolConfig);
  const validation = await dexManager.validateDeploymentForPool(poolConfig);

  logger.debug(
    `Detection Results - Pool: ${pool.name}, Requested Source: ${requestedLiquiditySource ?? 'arb-only'}, Type: ${deploymentType}, Valid: ${validation.valid}`
  );
  if (!validation.valid) {
    logger.error(`Configuration errors: ${validation.errors.join(', ')}`);
  }

  switch (deploymentType) {
    case 'single':
      logger.debug(`Using single contract (1inch) take handler for pool: ${pool.name}`);
      await handleLegacyOrArbTakes({
        signer,
        takeWriteTransport,
        pool,
        poolConfig,
        config: resolvedConfig,
      });
      break;

    case 'factory':
      logger.debug(`Using factory (multi-DEX) take handler for pool: ${pool.name}`);
      await handleFactoryTakes({
        signer,
        takeWriteTransport,
        pool,
        poolConfig,
        config: {
          subgraph: resolvedConfig.subgraph,
          dryRun: resolvedConfig.dryRun,
          delayBetweenActions: resolvedConfig.delayBetweenActions,
          keeperTakerFactory: resolvedConfig.keeperTakerFactory,
          takerContracts: resolvedConfig.takerContracts,
          universalRouterOverrides: resolvedConfig.universalRouterOverrides,
          sushiswapRouterOverrides: resolvedConfig.sushiswapRouterOverrides,
          curveRouterOverrides: resolvedConfig.curveRouterOverrides,
          tokenAddresses: resolvedConfig.tokenAddresses,
        },
      });
      break;

    case 'none':
      logger.warn(
        `External liquidity source ${requestedLiquiditySource ?? 'none'} unavailable for pool ${pool.name} - checking arbTake only`
      );
      await handleLegacyOrArbTakes({
        signer,
        takeWriteTransport,
        pool,
        poolConfig: stripExternalTakeSettings(poolConfig),
        config: resolvedConfig,
      });
      break;
  }
}


/**
 * Handle the non-factory take path:
 * - legacy 1inch external takes when available
 * - arbTake-only fallback when no external DEX deployment exists
 */

export async function handleLegacyOrArbTakes({
  signer,
  takeWriteTransport,
  pool,
  poolConfig,
  config,
}: HandleTakeParams) {
  const resolvedConfig: HandleTakeConfig = resolveSubgraphConfig(config);
  const candidates = await getTakeBorrowerCandidates({
    subgraph: resolvedConfig.subgraph,
    poolAddress: pool.poolAddress,
    minCollateral: poolConfig.take.minCollateral ?? 0,
  });

  const externalTakeAdapter: ExternalTakeAdapter<any, any> =
    poolConfig.take.liquiditySource === LiquiditySource.ONEINCH
      ? createOneInchTakeAdapter({
          delayBetweenActions: resolvedConfig.delayBetweenActions ?? 0,
          oneInchRouters: resolvedConfig.oneInchRouters,
          connectorTokens: resolvedConfig.connectorTokens,
        })
      : createNoExternalTakeAdapter();

  await processTakeCandidates({
    pool,
    signer,
    poolConfig,
    candidates,
    subgraph: resolvedConfig.subgraph,
    externalTakeAdapter,
    externalExecutionConfig: {
      dryRun: resolvedConfig.dryRun,
      delayBetweenActions: resolvedConfig.delayBetweenActions ?? 0,
      connectorTokens: resolvedConfig.connectorTokens,
      oneInchRouters: resolvedConfig.oneInchRouters,
      keeperTaker: resolvedConfig.keeperTaker,
      takeWriteTransport,
    },
    dryRun: resolvedConfig.dryRun ?? false,
    delayBetweenActions: resolvedConfig.delayBetweenActions ?? 0,
    takeWriteTransport,
    onFound: (decision) => {
      logger.info(
        `Found liquidation to ${formatTakeStrategyLog(
          externalTakeAdapter.kind,
          decision.approvedTake,
          decision.approvedArbTake
        )} - pool: ${pool.name}, borrower: ${decision.borrower}, auctionPrice: ${Number(
          weiToDecimaled(decision.auctionPrice)
        ).toFixed(6)}, collateral: ${weiToDecimaled(decision.collateral)}`
      );
    },
    onSkip: ({ candidate, reason }) => {
      logSkippedTakeCandidate({
        pool,
        borrower: candidate.borrower,
        reason,
      });
    },
  });
}

type LiquidationToTake = TakeLiquidationPlan;

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
        { delayBetweenActions: quoteConfig.delayBetweenActions },
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
  config: Partial<Pick<KeeperConfig, 'delayBetweenActions'>>,
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
    const chainId = await signer.getChainId();
    if (!oneInchRouters || !oneInchRouters[chainId]) {
      logger.debug(
        `No 1inch router configured for chainId ${chainId} in pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: `missing 1inch router for chain ${chainId}`,
      };
    }

    // Pause between getting a quote for each liquidation to avoid 1inch rate limit
    await delay(config.delayBetweenActions ?? 0);

    const dexRouter = new DexRouter(signer, {
      oneInchRouters: oneInchRouters ?? {},
      connectorTokens: connectorTokens ?? [],
    });
    
    // In checkIfTakeable function, before the dexRouter quote call:
    const collateralDecimals = await getDecimalsErc20(signer, pool.collateralAddress);
    const collateralInTokenDecimals = convertWadToTokenDecimals(collateral, collateralDecimals);


    const quoteResult = await dexRouter.getQuoteFromOneInch(
      chainId,
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress
    );

    if (!quoteResult.success) {
      logger.debug(
        `No valid quote data for collateral ${ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)} in pool ${pool.name}: ${quoteResult.error}`	      
      );
      return {
        isTakeable: false,
        reason: quoteResult.error ?? '1inch quote failed',
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

    const quoteDecimals = await getDecimalsErc20(signer, pool.quoteAddress);

    //collateralAmount is the human readable amount
    const collateralAmount = Number(
     ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)  // ← Use converted amount
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
      marketPrice,
      takeablePrice,
      quoteAmount,
      quoteAmountRaw: amountOut,
      collateralAmount,
      reason: takeable ? undefined : 'auction price above external take threshold',
    };
  } catch (error) {
    logger.error(`Failed to fetch quote data for pool ${pool.name}: ${error}`);
    return {
      isTakeable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkIfTakeable(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<Pick<KeeperConfig, 'delayBetweenActions'>>,
  signer: Signer,
  oneInchRouters: { [chainId: number]: string } | undefined,
  connectorTokens: string[] | undefined
): Promise<{ isTakeable: boolean }> {
  const evaluation = await getOneInchTakeQuoteEvaluation(
    pool,
    price,
    collateral,
    poolConfig,
    config,
    signer,
    oneInchRouters,
    connectorTokens
  );
  return { isTakeable: evaluation.isTakeable };
}

async function computeLegacyOneInchMinReturnAmount(params: {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
}): Promise<BigNumber> {
  if (!params.poolConfig.take.marketPriceFactor) {
    throw new Error('Legacy 1inch execution requires marketPriceFactor');
  }
  if (!params.quoteEvaluation.quoteAmountRaw) {
    throw new Error('Legacy 1inch execution requires quoteAmountRaw');
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

  return factoryShared.maxBigNumber(
    quoteAmountDueRaw,
    profitabilityFloor,
    slippageFloor
  );
}

export async function* getLiquidationsToTake({
  pool,
  poolConfig,
  signer,
  config,
}: GetLiquidationsToTakeParams): AsyncGenerator<LiquidationToTake> {
  const resolvedConfig = resolveSubgraphConfig(config);
  const { oneInchRouters, connectorTokens } = resolvedConfig;
  const {
    pool: { hpb, hpbIndex, liquidationAuctions },
  } = await resolvedConfig.subgraph.getLiquidations(
    pool.poolAddress,
    poolConfig.take.minCollateral ?? 0
  );
  for (const auction of liquidationAuctions) {
    const { borrower } = auction;
    const liquidationStatus = await pool.getLiquidation(borrower).getStatus();
    const price = Number(weiToDecimaled(liquidationStatus.price));
    const collateral = liquidationStatus.collateral;

    let isTakeable = false;
    let isArbTakeable = false;
    let arbHpbIndex = 0;

    if (poolConfig.take.marketPriceFactor && poolConfig.take.liquiditySource) {
      isTakeable = (await checkIfTakeable(
        pool,
        price,
        collateral,
        poolConfig,
        resolvedConfig,
        signer,
        oneInchRouters,
        connectorTokens
      )).isTakeable;
    }

    if (poolConfig.take.minCollateral && poolConfig.take.hpbPriceFactor) {
      const minDeposit = poolConfig.take.minCollateral / hpb;
      const arbTakeCheck = await checkIfArbTakeable(
        pool,
        price,
        collateral,
        poolConfig,
        resolvedConfig.subgraph,
        minDeposit.toString(),
        signer
      );
      isArbTakeable = arbTakeCheck.isArbTakeable;
      arbHpbIndex = arbTakeCheck.hpbIndex;
    }

    if (isTakeable || isArbTakeable) {
      const strategyLog = isTakeable && !isArbTakeable ? 'take'
        : !isTakeable && isArbTakeable ? 'arbTake'
        : isTakeable && isArbTakeable ? 'take and arbTake'
        : 'none';
      logger.info(`Found liquidation to ${strategyLog} - pool: ${pool.name}, borrower: ${borrower}, auctionPrice: ${price.toFixed(6)}, collateral: ${weiToDecimaled(collateral)}`);

      yield {
        borrower,
        hpbIndex: arbHpbIndex,
        collateral,
        auctionPrice: liquidationStatus.price,
        isTakeable,
        isArbTakeable,
      };
      continue;

    } else {
      logger.debug(
        `Not taking liquidation since price ${price} is too high - pool: ${pool.name}, borrower: ${borrower}`
      );
    }
  }
}

interface TakeLiquidationParams
  extends Pick<HandleTakeParams, 'pool' | 'signer'> {
  poolConfig: TakeActionConfig;
  liquidation: LiquidationToTake;
  config: Pick<
    KeeperConfig,
    'dryRun' | 'delayBetweenActions' | 'connectorTokens' | 'oneInchRouters' | 'keeperTaker'
  > &
    TakeWriteTransportConfig;
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
    logger.info(
      `DryRun - would Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower} using ${poolConfig.take.liquiditySource}`
    );
    return true;
  }

  if (poolConfig.take.liquiditySource !== LiquiditySource.ONEINCH) {
    logger.error(
      `Valid liquidity source not configured. Skipping liquidation of poolAddress: ${pool.poolAddress}, borrower: ${borrower}.`
    );
    return false;
  }

  try {
    const approvedQuoteEvaluation =
      liquidation.externalTakeQuoteEvaluation ??
      (await getOneInchTakeQuoteEvaluation(
        pool,
        Number(weiToDecimaled(liquidation.auctionPrice)),
        liquidation.collateral,
        poolConfig,
        { delayBetweenActions: config.delayBetweenActions },
        signer,
        config.oneInchRouters,
        config.connectorTokens
      ));

    if (!approvedQuoteEvaluation.isTakeable) {
      logger.error(
        `Legacy 1inch take quote no longer satisfies execution policy for ${pool.name}/${borrower}: ${approvedQuoteEvaluation.reason ?? 'not takeable'}`
      );
      return false;
    }

    if (!approvedQuoteEvaluation.quoteAmountRaw) {
      logger.error(
        `Legacy 1inch take is missing raw quote amount for ${pool.name}/${borrower}; refusing to send an unbounded swap`
      );
      return false;
    }

    const takeWriteTransport = resolveTakeWriteTransport(signer, config);
    const keeperTaker = AjnaKeeperTaker__factory.connect(
      config.keeperTaker!,
      signer
    );

    // pause between getting the 1inch quote and requesting the swap to avoid 1inch rate limit
    await delay(config.delayBetweenActions);
    const dexRouter = new DexRouter(signer, {
      oneInchRouters: config.oneInchRouters ?? {},
      connectorTokens: config.connectorTokens ?? [],
    });

    // Convert collateral from WAD to token decimals for 1inch API consistency
    const collateralDecimals = await getDecimalsErc20(
      signer,
      pool.collateralAddress
    );
    const collateralInTokenDecimals = convertWadToTokenDecimals(
      liquidation.collateral,
      collateralDecimals
    );
    const chainId = await signer.getChainId();

    const swapData = await dexRouter.getSwapDataFromOneInch(
      chainId,
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      1,
      keeperTaker.address,
      true
    );
    const swapDetails = convertSwapApiResponseToDetails(swapData.data);
    const requiredMinReturnAmount = await computeLegacyOneInchMinReturnAmount({
      pool,
      poolConfig,
      liquidation,
      quoteEvaluation: approvedQuoteEvaluation,
    });

    const routeMinReturnAmount = BigNumber.from(
      swapDetails.swapDescription.minReturnAmount
    );
    if (routeMinReturnAmount.lt(requiredMinReturnAmount)) {
      swapDetails.swapDescription = {
        ...swapDetails.swapDescription,
        minReturnAmount: requiredMinReturnAmount,
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
        `  Liquidity Source: ${poolConfig.take.liquiditySource}\n` +
        `  1inch Router: ${dexRouter.getRouter(chainId)}\n` +
        `  Required Min Return: ${requiredMinReturnAmount.toString()}\n` +
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
          Number(poolConfig.take.liquiditySource),
          dexRouter.getRouter(chainId)!,
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
        const receipt = await submitTakeTransaction(takeWriteTransport, txRequest);
        logger.info(
          `Take successful - pool: ${pool.name}, borrower: ${borrower} | tx: ${receipt.transactionHash}`
        );
        return receipt;
      }
    );
    return true;
  } catch (error) {
    logger.error(
      `Failed to Take. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
    return false;
  }
}
