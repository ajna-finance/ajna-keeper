import { BigNumber } from 'ethers';
import { LiquiditySource, formatLiquiditySource } from '../../config';

function getDirectDexRouteSourceLabel(source: LiquiditySource): string {
  switch (source) {
    case LiquiditySource.ONEINCH:
      return '1inch';
    case LiquiditySource.UNISWAPV3:
      return 'Uniswap V3';
    case LiquiditySource.CURVE:
      return 'Curve';
    default:
      return formatLiquiditySource(source);
  }
}

export function formatDirectDexQuoteRequestLog(params: {
  source: LiquiditySource;
  poolName: string;
  collateralAmount: string;
  feeTier?: number;
}): string {
  const feeTier =
    params.feeTier !== undefined ? ` feeTier=${params.feeTier}` : '';
  return `Direct DEX: Getting ${getDirectDexRouteSourceLabel(params.source)} quote for ${params.collateralAmount} collateral in pool ${params.poolName}${feeTier}`;
}

export function formatDirectDexPriceCheckLog(params: {
  source: LiquiditySource;
  poolName: string;
  auctionPrice: number;
  marketPrice?: number;
  takeablePrice?: number;
  feeTier?: number;
  profitable: boolean;
}): string {
  const feeTier =
    params.feeTier !== undefined ? ` feeTier=${params.feeTier}` : '';
  return (
    `Direct DEX: price check source=${getDirectDexRouteSourceLabel(params.source)} pool=${params.poolName}` +
    ` auction=${params.auctionPrice.toFixed(4)}` +
    ` market=${(params.marketPrice ?? 0).toFixed(4)}` +
    ` takeable=${(params.takeablePrice ?? 0).toFixed(4)}` +
    `${feeTier} profitable=${params.profitable}`
  );
}

export function formatDirectDexExecutionLog(params: {
  source: LiquiditySource;
  poolName: string;
  collateralWad: BigNumber;
  auctionPriceWad: BigNumber;
  minimalAmountOut: BigNumber;
  extraLines?: string[];
}): string {
  const extraLines = params.extraLines?.length
    ? `${params.extraLines.map((line) => `\n  ${line}`).join('')}`
    : '';
  return (
    `Direct DEX: Executing ${getDirectDexRouteSourceLabel(params.source)} take for pool ${params.poolName}:` +
    `${extraLines}\n` +
    `  Collateral (WAD): ${params.collateralWad.toString()}\n` +
    `  Auction Price (WAD): ${params.auctionPriceWad.toString()}\n` +
    `  Router Amount Out Minimum: ${params.minimalAmountOut.toString()}`
  );
}

export function formatDirectDexTakeSubmissionLog(params: {
  source: LiquiditySource;
  poolAddress: string;
  borrower: string;
}): string {
  return `Direct DEX: Sending ${getDirectDexRouteSourceLabel(params.source)} Take Tx - poolAddress: ${params.poolAddress}, borrower: ${params.borrower}`;
}
