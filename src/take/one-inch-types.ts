import { KeeperConfig } from '../config';
import { TakeWriteTransportConfig } from './write-transport';

export type OneInchExecutionConfig = Pick<
  KeeperConfig,
  | 'dryRun'
  | 'delayBetweenActions'
  | 'connectorTokens'
  | 'oneInchDefaultSlippage'
  | 'oneInchRouters'
  | 'oneInchAggregationExecutorAllowlist'
  | 'keeperTaker'
> &
  TakeWriteTransportConfig & {
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
  };

export type OneInchQuoteConfig = Pick<
  KeeperConfig,
  | 'delayBetweenActions'
  | 'oneInchDefaultSlippage'
  | 'oneInchRouters'
  | 'connectorTokens'
> & {
  oneInchRequestTimeoutMs?: number;
  skipOneInchRateLimitDelay?: boolean;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
};
