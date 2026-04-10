import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { quoteTokenScale } from '@ajna-finance/sdk/dist/contracts/pool';
import { BigNumber, ethers } from 'ethers';
import { KeeperConfig, LiquiditySource, PoolConfig } from '../../config';
import {
  SubgraphConfigInput,
  WithSubgraph,
} from '../../read-transports';
import { RequireFields } from '../../utils';
import { SushiSwapQuoteProvider } from '../../dex-providers/sushiswap-quote-provider';
import { UniswapV3QuoteProvider } from '../../dex-providers/uniswap-quote-provider';
import { ExternalTakeQuoteEvaluation, TakeLiquidationPlan } from '../types';
import { TakeWriteTransport } from '../write-transport';

type FactoryTakeConfigBase = Pick<
  KeeperConfig,
  | 'dryRun'
  | 'delayBetweenActions'
  | 'keeperTakerFactory'
  | 'takerContracts'
  | 'universalRouterOverrides'
  | 'sushiswapRouterOverrides'
  | 'curveRouterOverrides'
  | 'tokenAddresses'
>;

export type FactoryTakeConfig = WithSubgraph<FactoryTakeConfigBase>;
export type FactoryTakeConfigInput = SubgraphConfigInput<FactoryTakeConfigBase>;

export interface FactoryTakeParams {
  signer: Signer;
  takeWriteTransport?: TakeWriteTransport;
  pool: FungiblePool;
  poolConfig: RequireFields<PoolConfig, 'take'>;
  config: FactoryTakeConfigInput;
}

export type FactoryExecutionConfig = Pick<
  FactoryTakeConfig,
  | 'dryRun'
  | 'keeperTakerFactory'
  | 'universalRouterOverrides'
  | 'sushiswapRouterOverrides'
  | 'curveRouterOverrides'
  | 'tokenAddresses'
> & {
  takeWriteTransport?: TakeWriteTransport;
};

export type FactoryQuoteConfig = Pick<
  FactoryTakeConfig,
  | 'universalRouterOverrides'
  | 'sushiswapRouterOverrides'
  | 'curveRouterOverrides'
  | 'tokenAddresses'
>;

export interface FactoryQuoteProviderRuntimeCache {
  uniswapV3?: UniswapV3QuoteProvider | null;
  sushiswap?: SushiSwapQuoteProvider | null;
  curve?: any | null;
}

export function createFactoryQuoteProviderRuntimeCache(): FactoryQuoteProviderRuntimeCache {
  return {};
}

export const WAD = ethers.constants.WeiPerEther;
export const BASIS_POINTS_DENOMINATOR = 10_000;
export const MARKET_FACTOR_SCALE = 1_000_000;

export function ceilWmul(x: BigNumber, y: BigNumber): BigNumber {
  return x.mul(y).add(WAD.sub(1)).div(WAD);
}

export function ceilDiv(x: BigNumber, y: BigNumber): BigNumber {
  return x.add(y).sub(1).div(y);
}

export function maxBigNumber(...values: BigNumber[]): BigNumber {
  return values.reduce((max, value) => (value.gt(max) ? value : max), values[0]);
}

export async function getSwapDeadline(
  signer: Signer,
  ttlSeconds: number = 1800
): Promise<number> {
  const latestBlock = await signer.provider?.getBlock('latest');
  const baseTimestamp = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  return baseTimestamp + ttlSeconds;
}

export function getMarketPriceFactorUnits(marketPriceFactor: number): number {
  const scaled = Math.floor(marketPriceFactor * MARKET_FACTOR_SCALE);
  if (scaled <= 0) {
    throw new Error(`Factory: invalid marketPriceFactor ${marketPriceFactor}`);
  }
  return scaled;
}

export function getSlippageBasisPoints(defaultSlippage: number | undefined): number {
  const slippagePercentage = defaultSlippage ?? 1.0;
  const basisPoints = Math.floor(slippagePercentage * 100);
  return Math.max(0, Math.min(BASIS_POINTS_DENOMINATOR, basisPoints));
}

export async function getQuoteAmountDueRaw(
  pool: FungiblePool,
  auctionPrice: BigNumber,
  collateral: BigNumber
): Promise<BigNumber> {
  const scale = await quoteTokenScale(pool.contract);
  return ceilDiv(ceilWmul(collateral, auctionPrice), scale);
}

export async function computeFactoryAmountOutMinimum({
  pool,
  liquidation,
  quoteEvaluation,
  liquiditySource,
  config,
  marketPriceFactor,
}: {
  pool: FungiblePool;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  liquiditySource: LiquiditySource;
  config: Pick<
    FactoryExecutionConfig,
    'universalRouterOverrides' | 'sushiswapRouterOverrides' | 'curveRouterOverrides'
  >;
  marketPriceFactor: number;
}): Promise<BigNumber> {
  if (!quoteEvaluation.quoteAmountRaw) {
    throw new Error('Factory: quoteAmountRaw missing from evaluation');
  }

  const quoteAmountDueRaw = await getQuoteAmountDueRaw(
    pool,
    liquidation.auctionPrice,
    liquidation.collateral
  );
  const profitabilityFloor = ceilDiv(
    quoteAmountDueRaw.mul(MARKET_FACTOR_SCALE),
    BigNumber.from(getMarketPriceFactorUnits(marketPriceFactor))
  );

  let slippageBasisPoints = 100;
  if (liquiditySource === LiquiditySource.UNISWAPV3) {
    slippageBasisPoints = getSlippageBasisPoints(
      config.universalRouterOverrides?.defaultSlippage
    );
  } else if (liquiditySource === LiquiditySource.SUSHISWAP) {
    slippageBasisPoints = getSlippageBasisPoints(
      config.sushiswapRouterOverrides?.defaultSlippage
    );
  } else if (liquiditySource === LiquiditySource.CURVE) {
    slippageBasisPoints = getSlippageBasisPoints(
      config.curveRouterOverrides?.defaultSlippage
    );
  }

  const slippageFloor = quoteEvaluation.quoteAmountRaw
    .mul(BASIS_POINTS_DENOMINATOR - slippageBasisPoints)
    .div(BASIS_POINTS_DENOMINATOR);

  return maxBigNumber(quoteAmountDueRaw, profitabilityFloor, slippageFloor);
}
