import { TakeWriteTransportConfig } from './write-transport';

export interface OneInchExecutionConfig extends TakeWriteTransportConfig {
  dryRun?: boolean;
  delayBetweenActions: number;
  connectorTokens?: Array<string>;
  oneInchDefaultSlippage?: number;
  oneInchRouters?: { [chainId: number]: string };
  oneInchAggregationExecutorAllowlist?: { [chainId: number]: string[] };
  keeperTaker?: string;
  oneInchRequestTimeoutMs?: number;
  skipOneInchRateLimitDelay?: boolean;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
  onOneInchSwapDataResult?: (result: {
    success: boolean;
    retryable?: boolean;
    errorCode?: number | string;
    error?: string;
  }) => void;
  onOneInchExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
}

export interface OneInchQuoteConfig {
  delayBetweenActions: number;
  oneInchDefaultSlippage?: number;
  oneInchRouters?: { [chainId: number]: string };
  connectorTokens?: Array<string>;
  oneInchRequestTimeoutMs?: number;
  skipOneInchRateLimitDelay?: boolean;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
}
