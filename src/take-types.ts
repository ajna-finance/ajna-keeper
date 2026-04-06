import { BigNumber } from 'ethers';
import { TakeSettings } from './config-types';

export interface TakeActionConfig {
  name: string;
  take: TakeSettings;
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
