import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../config';
import { CurveQuoteProvider } from '../../dex-providers/curve-quote-provider';
import { DexRouter } from '../../dex-router';
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

export async function evaluateCurveFactoryQuote({
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
  config: Pick<FactoryQuoteConfig, 'curveRouterOverrides' | 'tokenAddresses'>;
  signer: Signer;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
}): Promise<ExternalTakeQuoteEvaluation> {
  if (!config.curveRouterOverrides) {
    logger.debug(`Factory: No curveRouterOverrides configured for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'missing curveRouterOverrides',
    };
  }

  const curveConfig = config.curveRouterOverrides;

  if (!curveConfig.poolConfigs || !curveConfig.wethAddress) {
    logger.debug(`Factory: Missing required Curve configuration for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'missing required Curve configuration',
    };
  }

  try {
    let quoteProvider = runtimeCache?.curve;
    if (quoteProvider === undefined) {
      const candidateProvider = new CurveQuoteProvider(signer, {
        poolConfigs: curveConfig.poolConfigs as any,
        defaultSlippage: curveConfig.defaultSlippage || 1.0,
        wethAddress: curveConfig.wethAddress,
        tokenAddresses: config.tokenAddresses || {},
      });
      const initialized = await candidateProvider.initialize();
      quoteProvider = initialized ? candidateProvider : null;
      if (runtimeCache) {
        runtimeCache.curve = quoteProvider;
      }
    }

    if (!quoteProvider) {
      logger.debug(`Factory: Curve quote provider not available for pool ${pool.name}`);
      return {
        isTakeable: false,
        reason: 'Curve quote provider unavailable',
      };
    }

    const collateralDecimals = await getDecimalsErc20(signer, pool.collateralAddress);
    const quoteDecimals = await getDecimalsErc20(signer, pool.quoteAddress);
    const collateralInTokenDecimals = convertWadToTokenDecimals(collateral, collateralDecimals);

    logger.debug(
      `Factory: Getting Curve quote for ${ethers.utils.formatUnits(
        collateralInTokenDecimals,
        collateralDecimals
      )} collateral in pool ${pool.name}`
    );

    const quoteResult = await quoteProvider.getQuote(
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress
    );

    if (!quoteResult.success || !quoteResult.dstAmount) {
      logger.debug(`Factory: Failed to get Curve quote for pool ${pool.name}: ${quoteResult.error}`);
      return {
        isTakeable: false,
        reason: quoteResult.error ?? 'Curve quote failed',
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
        reason: 'invalid Curve quote amounts',
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
      `Curve price check: pool=${pool.name}, auction=${auctionPrice.toFixed(4)}, market=${marketPrice.toFixed(4)}, takeable=${takeablePrice.toFixed(4)}, profitable=${profitable}`
    );

    return {
      isTakeable: profitable,
      marketPrice,
      takeablePrice,
      quoteAmount,
      quoteAmountRaw,
      collateralAmount,
      reason: profitable ? undefined : 'quoted output below required Curve profitability floor',
    };
  } catch (error) {
    logger.error(`Factory: Error getting Curve quote for pool ${pool.name}: ${error}`);
    return {
      isTakeable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeCurveFactoryTake({
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
    'keeperTakerFactory' | 'curveRouterOverrides' | 'tokenAddresses' | 'takeWriteTransport'
  >;
}): Promise<void> {
  const takeWriteTransport = resolveTakeWriteTransport(signer, config);
  const factory = AjnaKeeperTakerFactory__factory.connect(
    config.keeperTakerFactory!,
    takeWriteTransport.signer
  );

  if (!config.curveRouterOverrides) {
    logger.error('Factory: curveRouterOverrides required for Curve takes');
    return;
  }

  try {
    const quoteProvider = new CurveQuoteProvider(signer, {
      poolConfigs: config.curveRouterOverrides.poolConfigs! as any,
      defaultSlippage: config.curveRouterOverrides.defaultSlippage || 1.0,
      wethAddress: config.curveRouterOverrides.wethAddress!,
    });

    await quoteProvider.initialize();

    const poolExists = await quoteProvider.poolExists(
      pool.collateralAddress,
      pool.quoteAddress
    );
    if (!poolExists) {
      logger.error(`Factory: No Curve pool found for ${pool.collateralAddress}/${pool.quoteAddress}`);
      return;
    }

    const dexRouter = new DexRouter(signer, {
      tokenAddresses: config.tokenAddresses || {},
    });

    const selectedPoolConfig = dexRouter.getCurvePoolForTokenPair(
      pool.collateralAddress,
      pool.quoteAddress,
      config.curveRouterOverrides.poolConfigs!
    );

    if (!selectedPoolConfig) {
      logger.error(
        `Factory: Could not find working pool config for ${pool.collateralAddress}/${pool.quoteAddress}`
      );
      return;
    }

    let tokenInIndex: number | undefined;
    let tokenOutIndex: number | undefined;

    const discoveryAbi = ['function coins(uint256 i) external view returns (address)'];
    const poolContract = new ethers.Contract(selectedPoolConfig.address, discoveryAbi, signer);

    for (let i = 0; i < 8; i++) {
      try {
        const tokenAddr = await poolContract.coins(i);
        if (tokenAddr.toLowerCase() === pool.collateralAddress.toLowerCase()) {
          tokenInIndex = i;
        }
        if (tokenAddr.toLowerCase() === pool.quoteAddress.toLowerCase()) {
          tokenOutIndex = i;
        }
      } catch (error) {
        break;
      }
    }

    if (tokenInIndex === undefined || tokenOutIndex === undefined) {
      logger.error(
        `Factory: Could not discover token indices for Curve pool ${selectedPoolConfig.address}`
      );
      return;
    }

    logger.debug(
      `Factory: Found Curve pool tokens: ${pool.collateralAddress}@${tokenInIndex}, ${pool.quoteAddress}@${tokenOutIndex}`
    );

    const minimalAmountOut = await computeFactoryAmountOutMinimum({
      pool,
      liquidation,
      quoteEvaluation,
      liquiditySource: LiquiditySource.CURVE,
      config,
      marketPriceFactor: poolConfig.take.marketPriceFactor!,
    });
    const deadline = await getSwapDeadline(takeWriteTransport.signer);

    logger.debug(
      `Factory: Executing Curve take for pool ${pool.name}:\n` +
        `  Pool Address: ${selectedPoolConfig.address}\n` +
        `  Pool Type: ${selectedPoolConfig.poolType}\n` +
        `  Collateral (WAD): ${liquidation.collateral.toString()}\n` +
        `  Auction Price (WAD): ${liquidation.auctionPrice.toString()}\n` +
        `  Token Indices: ${tokenInIndex} -> ${tokenOutIndex}\n` +
        `  Minimal Amount Out: ${minimalAmountOut.toString()} (quoted bound)`
    );

    const encodedSwapDetails = ethers.utils.defaultAbiCoder.encode(
      ['address', 'uint8', 'uint8', 'uint8', 'uint256', 'uint256'],
      [
        selectedPoolConfig.address,
        selectedPoolConfig.poolType === CurvePoolType.STABLE ? 0 : 1,
        tokenInIndex,
        tokenOutIndex,
        minimalAmountOut,
        deadline,
      ]
    );

    logger.debug(
      `Factory: Sending Curve Take Tx - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );

    logger.debug(
      'Adding 2000ms state propagation delay before factory take (L2 sequencer protection)'
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await NonceTracker.queueTransaction(takeWriteTransport.signer, async (nonce: number) => {
      const fallbackGasLimit = ethers.BigNumber.from(1_500_000);
      const txArgs = [
        pool.poolAddress,
        liquidation.borrower,
        liquidation.auctionPrice,
        liquidation.collateral,
        Number(poolConfig.take.liquiditySource),
        selectedPoolConfig.address,
        encodedSwapDetails,
      ] as const;
      const gasLimit = await estimateGasWithBuffer(
        () => factory.estimateGas.takeWithAtomicSwap(...txArgs),
        fallbackGasLimit,
        `Factory Curve take ${pool.name}/${liquidation.borrower}`
      );
      const txRequest = await factory.populateTransaction.takeWithAtomicSwap(...txArgs, {
        gasLimit,
        nonce: nonce.toString(),
      });
      return await submitTakeTransaction(takeWriteTransport, txRequest);
    });

    logger.info(
      `Factory Curve Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );
  } catch (error) {
    logger.error(
      `Factory: Failed to Curve Take. pool: ${pool.name}, borrower: ${liquidation.borrower}`,
      error
    );
  }
}
