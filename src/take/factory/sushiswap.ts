import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../config';
import { SushiSwapQuoteProvider } from '../../dex-providers/sushiswap-quote-provider';
import { convertWadToTokenDecimals, getDecimalsErc20 } from '../../erc20';
import { logger } from '../../logging';
import { NonceTracker } from '../../nonce';
import { ExternalTakeQuoteEvaluation, TakeActionConfig, TakeLiquidationPlan } from '../types';
import { estimateGasWithBuffer, weiToDecimaled } from '../../utils';
import { AjnaKeeperTakerFactory__factory } from '../../../typechain-types';
import {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  MARKET_FACTOR_SCALE,
  ceilDiv,
  computeFactoryAmountOutMinimum,
  getMarketPriceFactorUnits,
  getQuoteAmountDueRaw,
  getSwapDeadline,
} from './shared';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';

export async function evaluateSushiSwapFactoryQuote({
  pool,
  auctionPriceWad,
  collateral,
  poolConfig,
  config,
  signer,
  runtimeCache,
}: {
  pool: FungiblePool;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  poolConfig: TakeActionConfig;
  config: Pick<FactoryQuoteConfig, 'sushiswapRouterOverrides'>;
  signer: Signer;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): Promise<ExternalTakeQuoteEvaluation> {
  if (!config.sushiswapRouterOverrides) {
    logger.debug(`Factory: No sushiswapRouterOverrides configured for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'missing sushiswapRouterOverrides',
    };
  }

  const sushiConfig = config.sushiswapRouterOverrides;

  if (
    !sushiConfig.swapRouterAddress ||
    !sushiConfig.factoryAddress ||
    !sushiConfig.wethAddress
  ) {
    logger.debug(`Factory: Missing required SushiSwap configuration for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'missing required SushiSwap configuration',
    };
  }

  try {
    let quoteProvider = runtimeCache?.sushiswap;
    if (quoteProvider === undefined) {
      const candidateProvider = new SushiSwapQuoteProvider(signer, {
        swapRouterAddress: sushiConfig.swapRouterAddress,
        quoterV2Address: sushiConfig.quoterV2Address,
        factoryAddress: sushiConfig.factoryAddress,
        defaultFeeTier: sushiConfig.defaultFeeTier || 500,
        wethAddress: sushiConfig.wethAddress,
      });
      const initialized = await candidateProvider.initialize();
      quoteProvider = initialized ? candidateProvider : null;
      if (runtimeCache) {
        runtimeCache.sushiswap = quoteProvider;
      }
    }

    if (!quoteProvider) {
      logger.debug(`Factory: SushiSwap quote provider not available for pool ${pool.name}`);
      return {
        isTakeable: false,
        reason: 'SushiSwap quote provider unavailable',
      };
    }

    const collateralDecimals = await getDecimalsErc20(signer, pool.collateralAddress);
    const quoteDecimals = await getDecimalsErc20(signer, pool.quoteAddress);
    const collateralInTokenDecimals = convertWadToTokenDecimals(collateral, collateralDecimals);

    logger.debug(
      `Factory: Getting SushiSwap quote for ${ethers.utils.formatUnits(
        collateralInTokenDecimals,
        collateralDecimals
      )} collateral in pool ${pool.name}`
    );

    const quoteResult = await quoteProvider.getQuote(
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      sushiConfig.defaultFeeTier
    );

    if (!quoteResult.success || !quoteResult.dstAmount) {
      logger.debug(`Factory: Failed to get SushiSwap quote for pool ${pool.name}: ${quoteResult.error}`);
      return {
        isTakeable: false,
        reason: quoteResult.error ?? 'SushiSwap quote failed',
      };
    }

    const collateralAmount = Number(
      ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)
    );
    const quoteAmountRaw = quoteResult.dstAmount;
    const quoteAmount = Number(ethers.utils.formatUnits(quoteAmountRaw, quoteDecimals));
    const auctionPrice = Number(weiToDecimaled(auctionPriceWad));

    if (collateralAmount <= 0 || quoteAmount <= 0) {
      logger.debug(
        `Factory: Invalid amounts - collateral: ${collateralAmount}, quote: ${quoteAmount} for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'invalid SushiSwap quote amounts',
      };
    }

    const marketPrice = quoteAmount / collateralAmount;
    const marketPriceFactor = poolConfig.take.marketPriceFactor;
    if (!marketPriceFactor) {
      logger.debug(`Factory: No marketPriceFactor configured for pool ${pool.name}`);
      return {
        isTakeable: false,
        reason: 'marketPriceFactor is not configured',
      };
    }

    const takeablePrice = marketPrice * marketPriceFactor;
    const profitabilityFloor = ceilDiv(
      (await getQuoteAmountDueRaw(pool, auctionPriceWad, collateral)).mul(MARKET_FACTOR_SCALE),
      BigNumber.from(getMarketPriceFactorUnits(marketPriceFactor))
    );
    const profitable = quoteAmountRaw.gte(profitabilityFloor);

    logger.debug(
      `SushiSwap price check: pool=${pool.name}, auction=${auctionPrice.toFixed(4)}, market=${marketPrice.toFixed(4)}, takeable=${takeablePrice.toFixed(4)}, profitable=${profitable}`
    );

    return {
      isTakeable: profitable,
      marketPrice,
      takeablePrice,
      quoteAmount,
      quoteAmountRaw,
      collateralAmount,
      reason: profitable
        ? undefined
        : 'quoted output below required SushiSwap profitability floor',
    };
  } catch (error) {
    logger.error(`Factory: Error getting SushiSwap quote for pool ${pool.name}: ${error}`);
    return {
      isTakeable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeSushiSwapFactoryTake({
  pool,
  poolConfig,
  signer,
  liquidation,
  quoteEvaluation,
  config,
}: {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: TakeLiquidationPlan;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  config: Pick<
    FactoryExecutionConfig,
    'keeperTakerFactory' | 'sushiswapRouterOverrides' | 'takeWriteTransport'
  >;
}): Promise<void> {
  const takeWriteTransport = resolveTakeWriteTransport(signer, config);
  const factory = AjnaKeeperTakerFactory__factory.connect(
    config.keeperTakerFactory!,
    takeWriteTransport.signer
  );

  if (!config.sushiswapRouterOverrides) {
    logger.error('Factory: sushiswapRouterOverrides required for SushiSwap takes');
    return;
  }

  const minimalAmountOut = await computeFactoryAmountOutMinimum({
    pool,
    liquidation,
    quoteEvaluation,
    liquiditySource: LiquiditySource.SUSHISWAP,
    config,
    marketPriceFactor: poolConfig.take.marketPriceFactor!,
  });
  const deadline = await getSwapDeadline(takeWriteTransport.signer);

  logger.debug(
    `Factory: Using WAD amounts for SushiSwap pool ${pool.name}:\n` +
      `  Collateral (WAD): ${liquidation.collateral.toString()}\n` +
      `  Auction Price (WAD): ${liquidation.auctionPrice.toString()}\n` +
      `  Minimal Amount Out: ${minimalAmountOut.toString()} (quoted bound)`
  );

  const swapDetails = {
    swapRouter: config.sushiswapRouterOverrides.swapRouterAddress!,
    targetToken: pool.quoteAddress,
    feeTier: config.sushiswapRouterOverrides.defaultFeeTier || 500,
    amountOutMinimum: minimalAmountOut,
    deadline,
  };

  const encodedSwapDetails = ethers.utils.defaultAbiCoder.encode(
    ['uint24', 'uint256', 'uint256'],
    [swapDetails.feeTier, swapDetails.amountOutMinimum, swapDetails.deadline]
  );

  try {
    logger.debug(
      `Factory: Sending SushiSwap Take Tx - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );

    await NonceTracker.queueTransaction(takeWriteTransport.signer, async (nonce: number) => {
      const fallbackGasLimit = ethers.BigNumber.from(1_500_000);
      const txArgs = [
        pool.poolAddress,
        liquidation.borrower,
        liquidation.auctionPrice,
        liquidation.collateral,
        Number(poolConfig.take.liquiditySource),
        swapDetails.swapRouter,
        encodedSwapDetails,
      ] as const;
      const gasLimit = await estimateGasWithBuffer(
        () => factory.estimateGas.takeWithAtomicSwap(...txArgs),
        fallbackGasLimit,
        `Factory Sushi take ${pool.name}/${liquidation.borrower}`
      );
      const txRequest = await factory.populateTransaction.takeWithAtomicSwap(...txArgs, {
        gasLimit,
        nonce: nonce.toString(),
      });
      return await submitTakeTransaction(takeWriteTransport, txRequest);
    });

    logger.info(
      `Factory SushiSwap Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );
  } catch (error) {
    logger.error(
      `Factory: Failed to SushiSwap Take. pool: ${pool.name}, borrower: ${liquidation.borrower}`,
      error
    );
  }
}
