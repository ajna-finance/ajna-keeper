import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../config-types';
import { UniswapV3QuoteProvider } from '../../dex-providers/uniswap-quote-provider';
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

export async function evaluateUniswapV3FactoryQuote({
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
  config: Pick<FactoryQuoteConfig, 'universalRouterOverrides'>;
  signer: Signer;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): Promise<ExternalTakeQuoteEvaluation> {
  if (!config.universalRouterOverrides) {
    logger.debug(`Factory: No universalRouterOverrides configured for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'missing universalRouterOverrides',
    };
  }

  const routerConfig = config.universalRouterOverrides;

  if (
    !routerConfig.universalRouterAddress ||
    !routerConfig.poolFactoryAddress ||
    !routerConfig.wethAddress
  ) {
    logger.debug(`Factory: Missing required router configuration for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'missing required Uniswap router configuration',
    };
  }

  try {
    let quoteProvider = runtimeCache?.uniswapV3;
    if (quoteProvider === undefined) {
      quoteProvider = new UniswapV3QuoteProvider(signer, {
        universalRouterAddress: routerConfig.universalRouterAddress,
        poolFactoryAddress: routerConfig.poolFactoryAddress,
        defaultFeeTier: routerConfig.defaultFeeTier || 3000,
        wethAddress: routerConfig.wethAddress,
        quoterV2Address: routerConfig.quoterV2Address,
      });
      if (runtimeCache) {
        runtimeCache.uniswapV3 = quoteProvider.isAvailable() ? quoteProvider : null;
      }
    }

    if (!quoteProvider || !quoteProvider.isAvailable()) {
      logger.debug(`Factory: UniswapV3QuoteProvider not available for pool ${pool.name}`);
      return {
        isTakeable: false,
        reason: 'Uniswap V3 quote provider unavailable',
      };
    }

    const quoterAddress = quoteProvider.getQuoterAddress();
    logger.debug(`Factory: Using QuoterV2 at ${quoterAddress} for pool ${pool.name}`);

    const collateralDecimals = await getDecimalsErc20(signer, pool.collateralAddress);
    const quoteDecimals = await getDecimalsErc20(signer, pool.quoteAddress);
    const collateralInTokenDecimals = convertWadToTokenDecimals(collateral, collateralDecimals);

    logger.debug(
      `Factory: Getting official Uniswap V3 quote for ${ethers.utils.formatUnits(
        collateralInTokenDecimals,
        collateralDecimals
      )} collateral in pool ${pool.name}`
    );

    const quoteResult = await quoteProvider.getQuote(
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      routerConfig.defaultFeeTier
    );

    if (!quoteResult.success || !quoteResult.dstAmount) {
      logger.debug(
        `Factory: Failed to get official Uniswap V3 quote for pool ${pool.name}: ${quoteResult.error}`
      );
      return {
        isTakeable: false,
        reason: quoteResult.error ?? 'Uniswap V3 quote failed',
      };
    }

    const quoteAmountRaw = BigNumber.from(quoteResult.dstAmount);
    const collateralAmount = Number(
      ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)
    );
    const quoteAmount = Number(ethers.utils.formatUnits(quoteAmountRaw, quoteDecimals));
    const auctionPrice = Number(weiToDecimaled(auctionPriceWad));

    if (collateralAmount <= 0 || quoteAmount <= 0) {
      logger.debug(
        `Factory: Invalid amounts - collateral: ${collateralAmount}, quote: ${quoteAmount} for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'invalid Uniswap V3 quote amounts',
      };
    }

    const officialMarketPrice = quoteAmount / collateralAmount;
    const marketPriceFactor = poolConfig.take.marketPriceFactor;
    if (!marketPriceFactor) {
      logger.debug(`Factory: No marketPriceFactor configured for pool ${pool.name}`);
      return {
        isTakeable: false,
        reason: 'marketPriceFactor is not configured',
      };
    }

    const takeablePrice = officialMarketPrice * marketPriceFactor;
    const profitabilityFloor = ceilDiv(
      (await getQuoteAmountDueRaw(pool, auctionPriceWad, collateral)).mul(MARKET_FACTOR_SCALE),
      BigNumber.from(getMarketPriceFactorUnits(marketPriceFactor))
    );
    const profitable = quoteAmountRaw.gte(profitabilityFloor);

    logger.debug(
      `Price check: pool=${pool.name}, auction=${auctionPrice.toFixed(4)}, market=${officialMarketPrice.toFixed(4)}, takeable=${takeablePrice.toFixed(4)}, profitable=${profitable}`
    );

    return {
      isTakeable: profitable,
      marketPrice: officialMarketPrice,
      takeablePrice,
      quoteAmount,
      quoteAmountRaw,
      collateralAmount,
      reason: profitable
        ? undefined
        : 'quoted output below required Uniswap V3 profitability floor',
    };
  } catch (error) {
    logger.error(`Factory: Error getting official Uniswap V3 quote for pool ${pool.name}: ${error}`);
    return {
      isTakeable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeUniswapV3FactoryTake({
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
    'keeperTakerFactory' | 'universalRouterOverrides' | 'takeWriteTransport'
  >;
}): Promise<void> {
  const takeWriteTransport = resolveTakeWriteTransport(signer, config);
  const factory = AjnaKeeperTakerFactory__factory.connect(
    config.keeperTakerFactory!,
    takeWriteTransport.signer
  );

  if (!config.universalRouterOverrides) {
    logger.error('Factory: universalRouterOverrides required for UniswapV3 takes');
    return;
  }

  const minimalAmountOut = await computeFactoryAmountOutMinimum({
    pool,
    liquidation,
    quoteEvaluation,
    liquiditySource: LiquiditySource.UNISWAPV3,
    config,
    marketPriceFactor: poolConfig.take.marketPriceFactor!,
  });
  const deadline = await getSwapDeadline(takeWriteTransport.signer);

  logger.debug(
    `Factory: Executing Uniswap V3 take for pool ${pool.name}:\n` +
      `  Collateral (WAD): ${liquidation.collateral.toString()}\n` +
      `  Auction Price (WAD): ${liquidation.auctionPrice.toString()}\n` +
      `  Minimal Amount Out: ${minimalAmountOut.toString()} (quoted bound)`
  );

  const swapDetails = {
    universalRouter: config.universalRouterOverrides.universalRouterAddress!,
    permit2: config.universalRouterOverrides.permit2Address!,
    targetToken: pool.quoteAddress,
    feeTier: config.universalRouterOverrides.defaultFeeTier || 3000,
    amountOutMinimum: minimalAmountOut,
    deadline,
  };

  const encodedSwapDetails = ethers.utils.defaultAbiCoder.encode(
    ['(address,address,address,uint24,uint256,uint256)'],
    [[
      swapDetails.universalRouter,
      swapDetails.permit2,
      swapDetails.targetToken,
      swapDetails.feeTier,
      swapDetails.amountOutMinimum,
      swapDetails.deadline,
    ]]
  );

  try {
    logger.debug(
      `Factory: Sending Uniswap V3 Take Tx - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );

    await NonceTracker.queueTransaction(takeWriteTransport.signer, async (nonce: number) => {
      const fallbackGasLimit = ethers.BigNumber.from(1_500_000);
      const txArgs = [
        pool.poolAddress,
        liquidation.borrower,
        liquidation.auctionPrice,
        liquidation.collateral,
        Number(poolConfig.take.liquiditySource),
        swapDetails.universalRouter,
        encodedSwapDetails,
      ] as const;
      const gasLimit = await estimateGasWithBuffer(
        () => factory.estimateGas.takeWithAtomicSwap(...txArgs),
        fallbackGasLimit,
        `Factory Uniswap take ${pool.name}/${liquidation.borrower}`
      );
      const txRequest = await factory.populateTransaction.takeWithAtomicSwap(...txArgs, {
        gasLimit,
        nonce: nonce.toString(),
      });
      return await submitTakeTransaction(takeWriteTransport, txRequest);
    });

    logger.info(
      `Factory Uniswap V3 Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );
  } catch (error) {
    logger.error(
      `Factory: Failed to Uniswap V3 Take. pool: ${pool.name}, borrower: ${liquidation.borrower}`,
      error
    );
  }
}
