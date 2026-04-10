import { BigNumber } from 'ethers';
import { TakeSettings } from './config-types';

export interface TakeActionConfig {
  name?: string;
  take: TakeSettings;
}

export type ExternalTakeStrategyKind = 'none' | 'oneinch' | 'factory';

export interface TakeBorrowerCandidate {
  borrower: string;
}

export interface ExternalTakeQuoteEvaluation {
  isTakeable: boolean;
  marketPrice?: number;
  takeablePrice?: number;
  quoteAmount?: number;
  quoteAmountRaw?: BigNumber;
  collateralAmount?: number;
  reason?: string;
}

export interface ArbTakeEvaluation {
  isArbTakeable: boolean;
  hpbIndex: number;
  maxArbTakePrice?: number;
  reason?: string;
}

export interface TakeLiquidationPlan {
  borrower: string;
  hpbIndex: number;
  collateral: BigNumber; // WAD
  auctionPrice: BigNumber; // WAD
  isTakeable: boolean;
  isArbTakeable: boolean;
  externalTakeQuoteEvaluation?: ExternalTakeQuoteEvaluation;
}

export interface TakeDecision {
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
