import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { SubgraphReader } from '../read-transports';
import { weiToDecimaled } from '../utils';
import { ArbTakeStrategy } from './arb-strategy';
import {
  TakeAuctionStatusReader,
  defaultTakeAuctionStatusReader,
} from './liquidation-status';
import { getExpectedQuotedCollateralWad } from './take-sizing';
import {
  AuctionTakeFacts,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
} from './types';

export type RevalidatedQuoteContextIssue =
  | 'collateral_mismatch'
  | 'auction_price_stale';

/**
 * Compares an approved quote evaluation against revalidated auction state.
 * Aggregator quotes are denominated in the debt-clamped take size, so the
 * collateral comparison uses the same path-aware size derived from the
 * refreshed facts.
 */
export function getRevalidatedQuoteContextIssue(
  params: AuctionTakeFacts & {
    quoteEvaluation: Pick<
      ExternalTakeQuoteEvaluation,
      'externalTakePath' | 'quotedCollateralWad' | 'quotedAuctionPriceWad'
    >;
  }
): RevalidatedQuoteContextIssue | undefined {
  const { quoteEvaluation } = params;
  if (quoteEvaluation.quotedCollateralWad) {
    const expectedQuotedCollateral = getExpectedQuotedCollateralWad({
      externalTakePath: quoteEvaluation.externalTakePath,
      collateral: params.collateral,
      auctionPrice: params.auctionPrice,
      debtToCover: params.debtToCover,
    });
    if (!expectedQuotedCollateral.eq(quoteEvaluation.quotedCollateralWad)) {
      return 'collateral_mismatch';
    }
  }
  if (
    quoteEvaluation.quotedAuctionPriceWad &&
    params.auctionPrice.gt(quoteEvaluation.quotedAuctionPriceWad)
  ) {
    return 'auction_price_stale';
  }
  return undefined;
}

export async function revalidateTakeDecision<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
>(params: {
  pool: FungiblePool;
  signer: Signer;
  borrower: string;
  subgraph: SubgraphReader;
  poolConfig: TPoolConfig;
  arbTakeStrategy: ArbTakeStrategy<TPoolConfig>;
  takeAuctionStatusReader?: TakeAuctionStatusReader;
  takeablePrice?: number;
  hpbIndex?: number;
  maxArbTakePrice?: number;
}): Promise<{
  approvedTake: boolean;
  approvedArbTake: boolean;
  collateral: BigNumber;
  auctionPrice: BigNumber;
  debtToCover?: BigNumber;
  hpbIndex: number;
  maxArbTakePrice?: number;
}> {
  const statusReader =
    params.takeAuctionStatusReader ?? defaultTakeAuctionStatusReader;
  const liquidationStatus = await statusReader.read({
    pool: params.pool,
    borrower: params.borrower,
  });
  const currentPrice = Number(weiToDecimaled(liquidationStatus.auctionPrice));
  const collateral = liquidationStatus.collateral;
  if (!collateral.gt(0)) {
    return {
      approvedTake: false,
      approvedArbTake: false,
      collateral,
      auctionPrice: liquidationStatus.auctionPrice,
      debtToCover: liquidationStatus.debtToCover,
      hpbIndex: 0,
    };
  }

  let approvedArbTake = false;
  let hpbIndex = params.hpbIndex ?? 0;
  let maxArbTakePrice = params.maxArbTakePrice;

  if (
    params.maxArbTakePrice !== undefined &&
    params.arbTakeStrategy.isEnabled(params.poolConfig)
  ) {
    const arbEvaluation = await params.arbTakeStrategy.evaluateArbTake({
      pool: params.pool,
      signer: params.signer,
      poolConfig: params.poolConfig,
      subgraph: params.subgraph,
      price: currentPrice,
      auctionPrice: liquidationStatus.auctionPrice,
      collateral,
      borrower: params.borrower,
    });

    approvedArbTake = arbEvaluation.isArbTakeable;
    hpbIndex = arbEvaluation.hpbIndex;
    maxArbTakePrice = arbEvaluation.maxArbTakePrice;
  }

  return {
    approvedTake:
      params.takeablePrice !== undefined &&
      currentPrice <= params.takeablePrice,
    approvedArbTake,
    collateral,
    auctionPrice: liquidationStatus.auctionPrice,
    debtToCover: liquidationStatus.debtToCover,
    hpbIndex,
    maxArbTakePrice,
  };
}
