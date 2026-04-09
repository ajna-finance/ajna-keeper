import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  AutoDiscoverActionPolicy,
  AutoDiscoverTakePolicy,
  KeeperConfig,
  LiquiditySource,
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
} from './config-types';
import {
  ResolvedSettlementTarget,
  ResolvedTakeTarget,
} from './auto-discovery';
import { logger } from './logging';
import {
  getOneInchTakeQuoteEvaluation,
  takeLiquidation,
} from './take';
import { arbTakeLiquidation, checkIfArbTakeable } from './arb-take';
import {
  createFactoryQuoteProviderRuntimeCache,
  FactoryQuoteProviderRuntimeCache,
  getFactoryTakeQuoteEvaluation,
  takeLiquidationFactory,
} from './take-factory';
import { ExternalTakeQuoteEvaluation } from './take-types';
import { weiToDecimaled } from './utils';
import { DexRouter } from './dex-router';
import { UniswapV3QuoteProvider } from './dex-providers/uniswap-quote-provider';
import { SushiSwapQuoteProvider } from './dex-providers/sushiswap-quote-provider';
import { getDecimalsErc20 } from './erc20';
import { AuctionToSettle, SettlementHandler } from './settlement';

const EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(900000);
const ARB_TAKE_GAS_LIMIT = BigNumber.from(450000);
const SETTLEMENT_GAS_LIMIT = BigNumber.from(800000);

type DiscoveryExecutionConfig = Pick<
  KeeperConfig,
  | 'autoDiscover'
  | 'connectorTokens'
  | 'curveRouterOverrides'
  | 'delayBetweenActions'
  | 'dryRun'
  | 'discoveredDefaults'
  | 'keeperTaker'
  | 'keeperTakerFactory'
  | 'oneInchRouters'
  | 'subgraphUrl'
  | 'sushiswapRouterOverrides'
  | 'takerContracts'
  | 'tokenAddresses'
  | 'universalRouterOverrides'
>;

interface GasPolicyResult {
  approved: boolean;
  gasCostNative: number;
  gasCostQuote: number;
  gasPriceGwei: number;
  reason?: string;
}

interface NativeToQuoteConversion {
  amountInNative: BigNumber;
  amountOutQuoteRaw: BigNumber;
}

interface DiscoveredTakeDecision {
  approvedTake: boolean;
  approvedArbTake: boolean;
  borrower: string;
  hpbIndex: number;
  collateral: BigNumber;
  auctionPrice: BigNumber;
  takeablePrice?: number;
  maxArbTakePrice?: number;
  quoteEvaluation?: ExternalTakeQuoteEvaluation;
  reason?: string;
}

export interface DiscoveryRpcCache {
  gasPrice?: BigNumber;
  factoryQuoteProviders?: FactoryQuoteProviderRuntimeCache;
}

function logDiscoveryDecision(config: DiscoveryExecutionConfig, message: string): void {
  if (config.autoDiscover?.logSkips) {
    logger.info(message);
  } else {
    logger.debug(message);
  }
}

function getTokenAddressCaseInsensitive(
  addresses: { [tokenSymbol: string]: string } | undefined,
  symbol: string
): string | undefined {
  if (!addresses) {
    return undefined;
  }
  for (const [key, value] of Object.entries(addresses)) {
    if (key.toLowerCase() === symbol.toLowerCase()) {
      return value;
    }
  }
  return undefined;
}

function resolveWrappedNativeAddress(
  config: DiscoveryExecutionConfig,
  liquiditySource?: LiquiditySource
): string | undefined {
  if (liquiditySource === LiquiditySource.UNISWAPV3) {
    return config.universalRouterOverrides?.wethAddress;
  }
  if (liquiditySource === LiquiditySource.SUSHISWAP) {
    return config.sushiswapRouterOverrides?.wethAddress;
  }
  if (liquiditySource === LiquiditySource.CURVE) {
    return config.curveRouterOverrides?.wethAddress;
  }
  return (
    getTokenAddressCaseInsensitive(config.tokenAddresses, 'weth') ??
    config.universalRouterOverrides?.wethAddress ??
    config.sushiswapRouterOverrides?.wethAddress ??
    config.curveRouterOverrides?.wethAddress
  );
}

function resolveGasQuoteSource(config: DiscoveryExecutionConfig): LiquiditySource | undefined {
  return (
    config.discoveredDefaults?.take?.liquiditySource ??
    (config.oneInchRouters ? LiquiditySource.ONEINCH : undefined) ??
    (config.universalRouterOverrides ? LiquiditySource.UNISWAPV3 : undefined) ??
    (config.sushiswapRouterOverrides ? LiquiditySource.SUSHISWAP : undefined) ??
    (config.curveRouterOverrides ? LiquiditySource.CURVE : undefined)
  );
}

async function quoteTokensByLiquiditySource(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  liquiditySource: LiquiditySource;
  amountIn: BigNumber;
  tokenIn: string;
  tokenOut: string;
}): Promise<BigNumber | undefined> {
  if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) {
    return params.amountIn;
  }

  if (params.liquiditySource === LiquiditySource.ONEINCH) {
    const chainId = await params.signer.getChainId();
    if (!params.config.oneInchRouters?.[chainId]) {
      return undefined;
    }

    const dexRouter = new DexRouter(params.signer, {
      oneInchRouters: params.config.oneInchRouters,
      connectorTokens: params.config.connectorTokens ?? [],
    });
    const quoteResult = await dexRouter.getQuoteFromOneInch(
      chainId,
      params.amountIn,
      params.tokenIn,
      params.tokenOut
    );
    if (!quoteResult.success || !quoteResult.dstAmount) {
      return undefined;
    }
    return BigNumber.from(quoteResult.dstAmount);
  }

  if (params.liquiditySource === LiquiditySource.UNISWAPV3) {
    const routerConfig = params.config.universalRouterOverrides;
    if (
      !routerConfig?.universalRouterAddress ||
      !routerConfig.poolFactoryAddress ||
      !routerConfig.wethAddress
    ) {
      return undefined;
    }

    const quoteProvider = new UniswapV3QuoteProvider(params.signer, {
      universalRouterAddress: routerConfig.universalRouterAddress,
      poolFactoryAddress: routerConfig.poolFactoryAddress,
      defaultFeeTier: routerConfig.defaultFeeTier || 3000,
      wethAddress: routerConfig.wethAddress,
      quoterV2Address: routerConfig.quoterV2Address,
    });
    if (!quoteProvider.isAvailable()) {
      return undefined;
    }
    const quoteResult = await quoteProvider.getQuote(
      params.amountIn,
      params.tokenIn,
      params.tokenOut,
      routerConfig.defaultFeeTier
    );
    return quoteResult.success && quoteResult.dstAmount
      ? BigNumber.from(quoteResult.dstAmount)
      : undefined;
  }

  if (params.liquiditySource === LiquiditySource.SUSHISWAP) {
    const sushiConfig = params.config.sushiswapRouterOverrides;
    if (
      !sushiConfig?.swapRouterAddress ||
      !sushiConfig.factoryAddress ||
      !sushiConfig.wethAddress
    ) {
      return undefined;
    }
    const quoteProvider = new SushiSwapQuoteProvider(params.signer, {
      swapRouterAddress: sushiConfig.swapRouterAddress,
      quoterV2Address: sushiConfig.quoterV2Address,
      factoryAddress: sushiConfig.factoryAddress,
      defaultFeeTier: sushiConfig.defaultFeeTier || 500,
      wethAddress: sushiConfig.wethAddress,
    });
    const initialized = await quoteProvider.initialize();
    if (!initialized) {
      return undefined;
    }
    const quoteResult = await quoteProvider.getQuote(
      params.amountIn,
      params.tokenIn,
      params.tokenOut,
      sushiConfig.defaultFeeTier
    );
    return quoteResult.success && quoteResult.dstAmount
      ? BigNumber.from(quoteResult.dstAmount)
      : undefined;
  }

  if (params.liquiditySource === LiquiditySource.CURVE) {
    const curveConfig = params.config.curveRouterOverrides;
    if (!curveConfig?.poolConfigs || !curveConfig.wethAddress) {
      return undefined;
    }
    const { CurveQuoteProvider } = await import('./dex-providers/curve-quote-provider');
    const quoteProvider = new CurveQuoteProvider(params.signer, {
      poolConfigs: curveConfig.poolConfigs,
      defaultSlippage: curveConfig.defaultSlippage || 1.0,
      wethAddress: curveConfig.wethAddress,
      tokenAddresses: params.config.tokenAddresses || {},
    });
    const initialized = await quoteProvider.initialize();
    if (!initialized) {
      return undefined;
    }
    const quoteResult = await quoteProvider.getQuote(
      params.amountIn,
      params.tokenIn,
      params.tokenOut
    );
    return quoteResult.success && quoteResult.dstAmount
      ? BigNumber.from(quoteResult.dstAmount)
      : undefined;
  }

  return undefined;
}

async function evaluateGasPolicy(params: {
  signer: Signer;
  config: DiscoveryExecutionConfig;
  policy?: Pick<
    AutoDiscoverActionPolicy,
    'maxGasCostNative' | 'maxGasCostQuote' | 'maxGasPriceGwei'
  > &
    Pick<AutoDiscoverTakePolicy, 'minExpectedProfitQuote'>;
  gasLimit: BigNumber;
  quoteTokenAddress: string;
  preferredLiquiditySource?: LiquiditySource;
  useProfitFloor?: boolean;
  gasPrice?: BigNumber;
  nativeToQuoteConversion?: NativeToQuoteConversion;
}): Promise<GasPolicyResult> {
  const provider = params.signer.provider;
  if (!provider) {
    return {
      approved: false,
      gasCostNative: 0,
      gasCostQuote: 0,
      gasPriceGwei: 0,
      reason: 'signer has no provider',
    };
  }

  const gasPrice = params.gasPrice ?? (await provider.getGasPrice());
  const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
  const maxGasPriceGwei = params.policy?.maxGasPriceGwei;
  if (maxGasPriceGwei !== undefined && gasPriceGwei > maxGasPriceGwei) {
    return {
      approved: false,
      gasCostNative: 0,
      gasCostQuote: 0,
      gasPriceGwei,
      reason: `gas price ${gasPriceGwei.toFixed(2)} gwei exceeds maxGasPriceGwei ${maxGasPriceGwei}`,
    };
  }

  const gasCostNativeRaw = gasPrice.mul(params.gasLimit);
  const gasCostNative = Number(ethers.utils.formatEther(gasCostNativeRaw));
  const maxGasCostNative = params.policy?.maxGasCostNative;
  if (maxGasCostNative !== undefined && gasCostNative > maxGasCostNative) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote: 0,
      gasPriceGwei,
      reason: `estimated gas cost ${gasCostNative.toFixed(6)} exceeds maxGasCostNative ${maxGasCostNative}`,
    };
  }

  const requiresGasCostQuote =
    params.policy?.maxGasCostQuote !== undefined ||
    (params.useProfitFloor && params.policy?.minExpectedProfitQuote !== undefined);
  if (!requiresGasCostQuote) {
    return {
      approved: true,
      gasCostNative,
      gasCostQuote: 0,
      gasPriceGwei,
    };
  }

  const wrappedNativeAddress =
    resolveWrappedNativeAddress(params.config, params.preferredLiquiditySource) ??
    resolveWrappedNativeAddress(params.config, resolveGasQuoteSource(params.config));
  if (!wrappedNativeAddress) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote: 0,
      gasPriceGwei,
      reason: 'no wrapped native token configured for gas cost conversion',
    };
  }
  const quoteDecimals = await getDecimalsErc20(
    params.signer,
    params.quoteTokenAddress
  );

  let gasCostQuote: number;
  if (wrappedNativeAddress.toLowerCase() === params.quoteTokenAddress.toLowerCase()) {
    gasCostQuote = Number(ethers.utils.formatUnits(gasCostNativeRaw, quoteDecimals));
  } else if (
    params.nativeToQuoteConversion &&
    params.nativeToQuoteConversion.amountInNative.gt(0)
  ) {
    const gasCostQuoteRaw = gasCostNativeRaw
      .mul(params.nativeToQuoteConversion.amountOutQuoteRaw)
      .add(params.nativeToQuoteConversion.amountInNative.sub(1))
      .div(params.nativeToQuoteConversion.amountInNative);
    gasCostQuote = Number(ethers.utils.formatUnits(gasCostQuoteRaw, quoteDecimals));
  } else {
    const liquiditySource =
      params.preferredLiquiditySource ?? resolveGasQuoteSource(params.config);
    if (liquiditySource === undefined) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote: 0,
        gasPriceGwei,
        reason: 'no liquidity source available for gas cost conversion',
      };
    }

    const quotedAmount = await quoteTokensByLiquiditySource({
      signer: params.signer,
      config: params.config,
      liquiditySource,
      amountIn: gasCostNativeRaw,
      tokenIn: wrappedNativeAddress,
      tokenOut: params.quoteTokenAddress,
    });
    if (!quotedAmount) {
      return {
        approved: false,
        gasCostNative,
        gasCostQuote: 0,
        gasPriceGwei,
        reason: 'failed to quote gas cost into quote token',
      };
    }
    gasCostQuote = Number(ethers.utils.formatUnits(quotedAmount, quoteDecimals));
  }

  const maxGasCostQuote = params.policy?.maxGasCostQuote;
  if (maxGasCostQuote !== undefined && gasCostQuote > maxGasCostQuote) {
    return {
      approved: false,
      gasCostNative,
      gasCostQuote,
      gasPriceGwei,
      reason: `estimated gas cost ${gasCostQuote.toFixed(6)} exceeds maxGasCostQuote ${maxGasCostQuote}`,
    };
  }

  return {
    approved: true,
    gasCostNative,
    gasCostQuote,
    gasPriceGwei,
  };
}

async function revalidateTakeDecision(params: {
  pool: FungiblePool;
  borrower: string;
  takeablePrice?: number;
  maxArbTakePrice?: number;
}): Promise<{
  approvedTake: boolean;
  approvedArbTake: boolean;
  collateral: BigNumber;
  auctionPrice: BigNumber;
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
    };
  }

  return {
    approvedTake:
      params.takeablePrice !== undefined && currentPrice <= params.takeablePrice,
    approvedArbTake:
      params.maxArbTakePrice !== undefined && currentPrice < params.maxArbTakePrice,
    collateral,
    auctionPrice: liquidationStatus.price,
  };
}

async function evaluateTakeCandidate(params: {
  pool: FungiblePool;
  signer: Signer;
  target: ResolvedTakeTarget;
  config: DiscoveryExecutionConfig;
  borrower: string;
  rpcCache?: DiscoveryRpcCache;
}): Promise<DiscoveredTakeDecision> {
  const liquidationStatus = await params.pool
    .getLiquidation(params.borrower)
    .getStatus();
  const collateral = liquidationStatus.collateral;
  if (!collateral.gt(0)) {
    return {
      approvedTake: false,
      approvedArbTake: false,
      borrower: params.borrower,
      hpbIndex: 0,
      collateral,
      auctionPrice: liquidationStatus.price,
      reason: 'auction no longer has collateral onchain',
    };
  }

  const auctionPriceNumber = Number(weiToDecimaled(liquidationStatus.price));
  let approvedTake = false;
  let approvedArbTake = false;
  let takeablePrice: number | undefined;
  let maxArbTakePrice: number | undefined;
  let hpbIndex = 0;
  let reason: string | undefined;
  let selectedQuoteEvaluation: ExternalTakeQuoteEvaluation | undefined;
  const takePolicy = getAutoDiscoverTakePolicy(params.config.autoDiscover);

  if (
    params.target.take.marketPriceFactor !== undefined &&
    params.target.take.liquiditySource !== undefined
  ) {
    const quoteEvaluation =
      params.target.take.liquiditySource === LiquiditySource.ONEINCH
        ? await getOneInchTakeQuoteEvaluation(
            params.pool,
            auctionPriceNumber,
            collateral,
            params.target,
            { delayBetweenActions: params.config.delayBetweenActions },
            params.signer,
            params.config.oneInchRouters,
            params.config.connectorTokens
          )
        : await getFactoryTakeQuoteEvaluation(
            params.pool,
            liquidationStatus.price,
            collateral,
            params.target,
            {
              universalRouterOverrides: params.config.universalRouterOverrides,
              sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
              curveRouterOverrides: params.config.curveRouterOverrides,
              tokenAddresses: params.config.tokenAddresses,
            },
            params.signer,
            params.rpcCache?.factoryQuoteProviders
          );

    if (!quoteEvaluation.isTakeable) {
      reason = quoteEvaluation.reason;
    } else {
      const wrappedNativeAddress = resolveWrappedNativeAddress(
        params.config,
        params.target.take.liquiditySource
      );
      const nativeToQuoteConversion =
        wrappedNativeAddress &&
        wrappedNativeAddress.toLowerCase() === params.pool.collateralAddress.toLowerCase() &&
        quoteEvaluation.quoteAmountRaw
          ? {
              amountInNative: collateral,
              amountOutQuoteRaw: quoteEvaluation.quoteAmountRaw,
            }
          : undefined;
      const gasPolicy = await evaluateGasPolicy({
        signer: params.signer,
        config: params.config,
        policy: takePolicy,
        gasLimit: EXTERNAL_TAKE_GAS_LIMIT,
        quoteTokenAddress: params.pool.quoteAddress,
        preferredLiquiditySource: params.target.take.liquiditySource,
        useProfitFloor: true,
        nativeToQuoteConversion,
        gasPrice: params.rpcCache?.gasPrice,
      });

      if (!gasPolicy.approved) {
        reason = gasPolicy.reason;
      } else {
        const auctionCostQuote =
          auctionPriceNumber * (quoteEvaluation.collateralAmount ?? 0);
        const expectedProfit =
          (quoteEvaluation.quoteAmount ?? 0) -
          auctionCostQuote -
          gasPolicy.gasCostQuote;
        const minExpectedProfitQuote = takePolicy?.minExpectedProfitQuote;

        if (
          minExpectedProfitQuote !== undefined &&
          expectedProfit < minExpectedProfitQuote
        ) {
          reason = `expected take profit ${expectedProfit.toFixed(6)} below minExpectedProfitQuote ${minExpectedProfitQuote}`;
        } else {
          approvedTake = true;
          takeablePrice = quoteEvaluation.takeablePrice;
          selectedQuoteEvaluation = quoteEvaluation;
        }
      }
    }
  }

  if (
    params.target.take.minCollateral !== undefined &&
    params.target.take.hpbPriceFactor !== undefined
  ) {
    if (takePolicy?.minExpectedProfitQuote !== undefined) {
      logDiscoveryDecision(
        params.config,
        `Skipping discovered arbTake for ${params.pool.poolAddress}/${params.borrower} because quote-normalized profit is not available`
      );
    } else {
      const prices = await params.pool.getPrices();
      const hpb = Number(weiToDecimaled(prices.hpb));
      const minDeposit = params.target.take.minCollateral / hpb;
      const arbEvaluation =
        await checkIfArbTakeable(
          params.pool,
          auctionPriceNumber,
          collateral,
          params.target,
          params.config.subgraphUrl,
          minDeposit.toString(),
          params.signer
        );

      if (!arbEvaluation.isArbTakeable) {
        if (!approvedTake) {
          reason = arbEvaluation.reason ?? reason;
        }
      } else {
        const gasPolicy = await evaluateGasPolicy({
          signer: params.signer,
          config: params.config,
          policy: takePolicy,
          gasLimit: ARB_TAKE_GAS_LIMIT,
          quoteTokenAddress: params.pool.quoteAddress,
          preferredLiquiditySource: params.target.take.liquiditySource,
          useProfitFloor: false,
          gasPrice: params.rpcCache?.gasPrice,
        });
        if (!gasPolicy.approved) {
          if (!approvedTake) {
            reason = gasPolicy.reason;
          }
        } else {
          approvedArbTake = true;
          hpbIndex = arbEvaluation.hpbIndex;
          maxArbTakePrice = arbEvaluation.maxArbTakePrice;
        }
      }
    }
  }

  return {
    approvedTake,
    approvedArbTake,
    borrower: params.borrower,
    hpbIndex,
    collateral,
    auctionPrice: liquidationStatus.price,
    takeablePrice,
    maxArbTakePrice,
    quoteEvaluation: selectedQuoteEvaluation,
    reason,
  };
}

export async function handleDiscoveredTakeTarget(params: {
  pool: FungiblePool;
  signer: Signer;
  target: ResolvedTakeTarget;
  config: DiscoveryExecutionConfig;
  rpcCache?: DiscoveryRpcCache;
}): Promise<void> {
  const rpcCache =
    params.rpcCache ??
    (params.signer.provider
      ? {
          gasPrice: await params.signer.provider.getGasPrice(),
          factoryQuoteProviders: createFactoryQuoteProviderRuntimeCache(),
        }
      : undefined);
  for (const candidate of params.target.candidates) {
    const decision = await evaluateTakeCandidate({
      pool: params.pool,
      signer: params.signer,
      target: params.target,
      config: params.config,
      borrower: candidate.borrower,
      rpcCache,
    });

    if (!decision.approvedTake && !decision.approvedArbTake) {
      logDiscoveryDecision(
        params.config,
        `Skipping discovered take candidate ${params.pool.poolAddress}/${candidate.borrower}: ${decision.reason ?? 'policy rejected candidate'}`
      );
      continue;
    }

    const revalidated = await revalidateTakeDecision({
      pool: params.pool,
      borrower: candidate.borrower,
      takeablePrice: decision.takeablePrice,
      maxArbTakePrice: decision.maxArbTakePrice,
    });

    if (decision.approvedTake && revalidated.approvedTake) {
      if (params.target.take.liquiditySource === LiquiditySource.ONEINCH) {
        await takeLiquidation({
          pool: params.pool,
          poolConfig: params.target,
          signer: params.signer,
          liquidation: {
            borrower: candidate.borrower,
            hpbIndex: decision.hpbIndex,
            collateral: revalidated.collateral,
            auctionPrice: revalidated.auctionPrice,
            isTakeable: true,
            isArbTakeable: false,
          },
          config: {
            dryRun: params.target.dryRun,
            delayBetweenActions: params.config.delayBetweenActions,
            connectorTokens: params.config.connectorTokens,
            oneInchRouters: params.config.oneInchRouters,
            keeperTaker: params.config.keeperTaker,
          },
        });
      } else {
        await takeLiquidationFactory({
          pool: params.pool,
          poolConfig: params.target,
          signer: params.signer,
          liquidation: {
            borrower: candidate.borrower,
            hpbIndex: decision.hpbIndex,
            collateral: revalidated.collateral,
            auctionPrice: revalidated.auctionPrice,
            isTakeable: true,
            isArbTakeable: false,
            externalTakeQuoteEvaluation: decision.quoteEvaluation,
          },
          config: {
            dryRun: params.target.dryRun,
            keeperTakerFactory: params.config.keeperTakerFactory,
            universalRouterOverrides: params.config.universalRouterOverrides,
            sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
            curveRouterOverrides: params.config.curveRouterOverrides,
            tokenAddresses: params.config.tokenAddresses,
          },
        });
      }

      if (decision.approvedArbTake && revalidated.approvedArbTake) {
        await new Promise((resolve) =>
          setTimeout(resolve, params.config.delayBetweenActions * 1000)
        );
      }
    }

    if (decision.approvedArbTake && revalidated.approvedArbTake) {
      await arbTakeLiquidation({
        pool: params.pool,
        signer: params.signer,
        liquidation: {
          borrower: candidate.borrower,
          hpbIndex: decision.hpbIndex,
        },
        config: {
          dryRun: params.target.dryRun,
        },
      });
    }

    if (
      (decision.approvedTake && !revalidated.approvedTake) ||
      (decision.approvedArbTake && !revalidated.approvedArbTake)
    ) {
      logDiscoveryDecision(
        params.config,
        `Skipping discovered take execution for ${params.pool.poolAddress}/${candidate.borrower} because onchain revalidation changed the auction state`
      );
    }
  }
}

function hydrateSettlementAuction(candidate: ResolvedSettlementTarget['candidates'][number]): AuctionToSettle {
  return {
    borrower: candidate.borrower,
    kickTime: candidate.kickTime,
    debtRemaining: ethers.utils.parseEther(candidate.debtRemaining || '0'),
    collateralRemaining: ethers.utils.parseEther(candidate.collateralRemaining || '0'),
  };
}

export async function handleDiscoveredSettlementTarget(params: {
  pool: FungiblePool;
  signer: Signer;
  target: ResolvedSettlementTarget;
  config: DiscoveryExecutionConfig;
  rpcCache?: DiscoveryRpcCache;
}): Promise<void> {
  const handler = new SettlementHandler(
    params.pool,
    params.signer,
    { settlement: params.target.settlement },
    {
      dryRun: params.target.dryRun,
      subgraphUrl: params.config.subgraphUrl,
      delayBetweenActions: params.config.delayBetweenActions,
    }
  );
  const rpcCache =
    params.rpcCache ??
    (params.signer.provider
      ? {
          gasPrice: await params.signer.provider.getGasPrice(),
        }
      : undefined);

  const approvedAuctions: AuctionToSettle[] = [];
  const settlementPolicy = getAutoDiscoverSettlementPolicy(
    params.config.autoDiscover
  );
  for (const candidate of params.target.candidates) {
    const needsSettlement = await handler.needsSettlement(candidate.borrower);
    if (!needsSettlement.needs) {
      logDiscoveryDecision(
        params.config,
        `Skipping discovered settlement candidate ${params.pool.poolAddress}/${candidate.borrower}: ${needsSettlement.reason}`
      );
      continue;
    }

    if (params.target.settlement.checkBotIncentive) {
      const incentiveCheck = await handler.checkBotIncentive(candidate.borrower);
      if (!incentiveCheck.hasIncentive) {
        logDiscoveryDecision(
          params.config,
          `Skipping discovered settlement candidate ${params.pool.poolAddress}/${candidate.borrower}: ${incentiveCheck.reason}`
        );
        continue;
      }
    }

    const gasPolicy = await evaluateGasPolicy({
      signer: params.signer,
      config: params.config,
      policy: settlementPolicy,
      gasLimit: SETTLEMENT_GAS_LIMIT,
      quoteTokenAddress: params.pool.quoteAddress,
      useProfitFloor: false,
      gasPrice: rpcCache?.gasPrice,
    });
    if (!gasPolicy.approved) {
      logDiscoveryDecision(
        params.config,
        `Skipping discovered settlement candidate ${params.pool.poolAddress}/${candidate.borrower}: ${gasPolicy.reason}`
      );
      continue;
    }

    approvedAuctions.push(hydrateSettlementAuction(candidate));
  }

  if (approvedAuctions.length === 0) {
    return;
  }

  await handler.handleCandidateAuctions(approvedAuctions);
}
