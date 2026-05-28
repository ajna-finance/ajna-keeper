import { TakeWriteTransportConfig } from './write-transport';
import { LifiDexConfig } from '../config';

export interface LifiQuoteConfig {
  lifi?: LifiDexConfig;
  lifiTaker?: string;
  lifiRequestAbortSignal?: AbortSignal;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
}

export interface LifiExecutionConfig
  extends LifiQuoteConfig,
    TakeWriteTransportConfig {
  dryRun?: boolean;
  keeperTakerFactory?: string;
  onLifiQuoteResult?: (result: {
    success: boolean;
    retryable?: boolean;
    errorCode?: number | string;
    error?: string;
  }) => void;
  onLifiExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
}
