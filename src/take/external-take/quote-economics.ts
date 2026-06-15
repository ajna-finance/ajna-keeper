import { FungiblePool } from '@ajna-finance/sdk';
import { quoteTokenScale } from '@ajna-finance/sdk/dist/contracts/pool';
import { BigNumber, ethers } from 'ethers';
import { MARKET_FACTOR_SCALE, WAD } from '../../constants';
import { ceilDivBigNumber, decimaledToWei, maxBigNumber } from '../../utils';
import {
  applyExternalTakeRoutePolicy,
  ExternalTakeRoutePolicyResult,
} from './policy';

export function ceilWmul(x: BigNumber, y: BigNumber): BigNumber {
  return x.mul(y).add(WAD.sub(1)).div(WAD);
}

export function ceilDiv(x: BigNumber, y: BigNumber): BigNumber {
  return ceilDivBigNumber(x, y);
}

export function deriveApprovedMinOutRaw(params: {
  routeMinOutRaw?: BigNumber;
  profitMinOutRaw?: BigNumber;
  fallbackMinOutRaw?: BigNumber;
}): BigNumber | undefined {
  const splitFloors = [params.routeMinOutRaw, params.profitMinOutRaw].filter(
    (value): value is BigNumber => value !== undefined
  );
  if (splitFloors.length) {
    return maxBigNumber(...splitFloors);
  }
  return params.fallbackMinOutRaw;
}

export function getMarketPriceFactorUnits(marketPriceFactor: number): number {
  const scaled = Math.floor(marketPriceFactor * MARKET_FACTOR_SCALE);
  if (scaled <= 0) {
    throw new Error(
      `External take: invalid marketPriceFactor ${marketPriceFactor}`
    );
  }
  return scaled;
}

export function getQuoteAmountDueRawForScale(params: {
  quoteTokenScale: BigNumber;
  auctionPriceWad: BigNumber;
  collateralWad: BigNumber;
}): BigNumber {
  // Round repayment up so execution min-out covers the exact Ajna quote obligation.
  return ceilDiv(
    ceilWmul(params.collateralWad, params.auctionPriceWad),
    params.quoteTokenScale
  );
}

export async function getQuoteAmountDueRaw(
  pool: FungiblePool,
  auctionPriceWad: BigNumber,
  collateralWad: BigNumber
): Promise<BigNumber> {
  return getQuoteAmountDueRawForScale({
    quoteTokenScale: await quoteTokenScale(pool.contract),
    auctionPriceWad,
    collateralWad,
  });
}

export function getMarketFactorFloorQuoteRaw(params: {
  quoteAmountDueRaw: BigNumber;
  marketPriceFactor: number;
}): BigNumber {
  return ceilDiv(
    params.quoteAmountDueRaw.mul(MARKET_FACTOR_SCALE),
    BigNumber.from(getMarketPriceFactorUnits(params.marketPriceFactor))
  );
}

export interface ExternalTakeQuoteEconomics {
  collateralAmount: number;
  quoteAmount: number;
  marketPrice: number;
  takeablePrice: number;
  effectiveAuctionPriceWad: BigNumber;
  quoteAmountDueRaw: BigNumber;
  marketFactorFloorQuoteRaw: BigNumber;
  policy: ExternalTakeRoutePolicyResult;
}

export async function buildExternalTakeQuoteEconomics(params: {
  pool: FungiblePool;
  displayAuctionPrice: number;
  auctionPriceWad?: BigNumber;
  collateralWad: BigNumber;
  collateralInTokenDecimals: BigNumber;
  collateralDecimals: number;
  quoteDecimals: number;
  quoteAmountRaw: BigNumber;
  routeMinOutRaw?: BigNumber;
  marketPriceFactor: number;
  allowSubsidy?: boolean;
}): Promise<ExternalTakeQuoteEconomics> {
  const collateralAmount = Number(
    ethers.utils.formatUnits(
      params.collateralInTokenDecimals,
      params.collateralDecimals
    )
  );
  const quoteAmount = Number(
    ethers.utils.formatUnits(params.quoteAmountRaw, params.quoteDecimals)
  );
  const marketPrice = quoteAmount / collateralAmount;
  const effectiveAuctionPriceWad =
    params.auctionPriceWad ?? decimaledToWei(params.displayAuctionPrice);
  const quoteAmountDueRaw = await getQuoteAmountDueRaw(
    params.pool,
    effectiveAuctionPriceWad,
    params.collateralWad
  );
  const marketFactorFloorQuoteRaw = getMarketFactorFloorQuoteRaw({
    quoteAmountDueRaw,
    marketPriceFactor: params.marketPriceFactor,
  });
  const policy = applyExternalTakeRoutePolicy({
    configuredMarketPriceFactor: params.marketPriceFactor,
    allowSubsidy: params.allowSubsidy === true,
    quoteAmountRaw: params.quoteAmountRaw,
    quoteDueRaw: quoteAmountDueRaw,
    marketFactorFloorQuoteRaw,
    routeMinOutRaw: params.routeMinOutRaw,
  });

  return {
    collateralAmount,
    quoteAmount,
    marketPrice,
    takeablePrice: marketPrice * policy.effectiveMarketPriceFactor,
    effectiveAuctionPriceWad,
    quoteAmountDueRaw,
    marketFactorFloorQuoteRaw,
    policy,
  };
}
