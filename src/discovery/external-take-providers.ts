import { isFactoryDynamicSource } from '../config';
import * as takeFactoryModule from '../take/factory';
import * as lifiExecutionModule from '../take/lifi-execution';
import * as oneInchExecutionModule from '../take/one-inch-execution';
import { ResolvedTakeTarget } from './targets';
import {
  DiscoveryExternalExecutionConfig,
  ExternalTakeRouteProvider,
  withTakeLiquiditySource,
} from './external-take-provider';
import { getLifiCircuitOpenReason } from './lifi-circuit';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from './types';

export type DiscoveryExternalTakeRouteProvider = ExternalTakeRouteProvider<
  ResolvedTakeTarget,
  DiscoveryExternalExecutionConfig
>;

export interface DiscoveryExternalTakeProviderRegistry {
  oneInchProvider: DiscoveryExternalTakeRouteProvider;
  lifiProvider: DiscoveryExternalTakeRouteProvider;
  factoryProvider: DiscoveryExternalTakeRouteProvider;
  selectExternalTakeProvider(params: {
    selectedPath: DiscoveryExternalTakeRouteProvider['path'];
  }): DiscoveryExternalTakeRouteProvider;
}

export function createDiscoveryExternalTakeProviderRegistry(params: {
  config: Pick<DiscoveryExecutionConfig, 'lifi'>;
  rpcCache?: DiscoveryRpcCache;
}): DiscoveryExternalTakeProviderRegistry {
  const getLifiExecutionRefreshCircuitOpenReason = (
    executionConfig: Pick<DiscoveryExternalExecutionConfig, 'dryRun'>
  ): string | undefined => {
    if (executionConfig.dryRun === true) {
      return undefined;
    }
    return getLifiCircuitOpenReason({
      rpcCache: params.rpcCache,
      lifiConfig: params.config.lifi,
      purpose: 'execution_refresh',
    });
  };

  const oneInchProvider: DiscoveryExternalTakeRouteProvider = {
    path: 'oneinch',
    execute: async ({ pool, signer, poolConfig, liquidation, config }) => {
      let oneInchPreSubmitRejected = false;
      let oneInchSwapDataSucceeded = false;
      let oneInchPreBroadcastFailed = false;
      const originalSwapDataResult = config.onOneInchSwapDataResult;
      const originalExecutionFailure = config.onOneInchExecutionFailure;
      const oneInchConfig = {
        ...config,
        onOneInchSwapDataResult: (result: {
          success: boolean;
          retryable?: boolean;
          errorCode?: number | string;
          error?: string;
        }) => {
          originalSwapDataResult?.(result);
          if (result.success) {
            oneInchSwapDataSucceeded = true;
          } else {
            oneInchPreSubmitRejected = true;
          }
        },
        onOneInchExecutionFailure: (result: {
          preBroadcast: boolean;
          error?: string;
        }) => {
          originalExecutionFailure?.(result);
          if (result.preBroadcast) {
            oneInchPreBroadcastFailed = true;
          }
        },
      };
      const succeeded = await oneInchExecutionModule.takeLiquidation({
        pool,
        signer,
        poolConfig,
        liquidation,
        config: oneInchConfig,
      });
      return {
        succeeded,
        preBroadcastFailed:
          (oneInchPreSubmitRejected && !oneInchSwapDataSucceeded) ||
          oneInchPreBroadcastFailed,
      };
    },
  };

  const lifiProvider: DiscoveryExternalTakeRouteProvider = {
    path: 'lifi',
    execute: async ({ pool, signer, poolConfig, liquidation, config }) => {
      let lifiPreBroadcastFailed = false;
      const originalLifiExecutionFailure = config.onLifiExecutionFailure;
      const lifiConfig = {
        ...config,
        onLifiExecutionFailure: (result: {
          preBroadcast: boolean;
          error?: string;
        }) => {
          originalLifiExecutionFailure?.(result);
          if (result.preBroadcast) {
            lifiPreBroadcastFailed = true;
          }
        },
      };
      const circuitOpenReason =
        getLifiExecutionRefreshCircuitOpenReason(config);
      if (circuitOpenReason) {
        lifiConfig.onLifiExecutionFailure?.({
          preBroadcast: true,
          error: circuitOpenReason,
        });
        return {
          succeeded: false,
          preBroadcastFailed: true,
          circuitOpenReason,
        };
      }
      const succeeded = await lifiExecutionModule.takeLiquidationLifi({
        pool,
        signer,
        poolConfig,
        liquidation,
        config: lifiConfig,
      });
      return { succeeded, preBroadcastFailed: lifiPreBroadcastFailed };
    },
  };

  const factoryProvider: DiscoveryExternalTakeRouteProvider = {
    path: 'factory',
    execute: async ({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
      selectedSource,
    }) => {
      let factoryPreBroadcastFailed = false;
      const factoryPoolConfig =
        selectedSource !== undefined && isFactoryDynamicSource(selectedSource)
          ? withTakeLiquiditySource(poolConfig, selectedSource)
          : poolConfig;
      const originalFactoryExecutionFailure = config.onFactoryExecutionFailure;
      const factoryConfig = {
        ...config,
        onFactoryExecutionFailure: (result: {
          preBroadcast: boolean;
          error?: string;
        }) => {
          originalFactoryExecutionFailure?.(result);
          if (result.preBroadcast) {
            factoryPreBroadcastFailed = true;
          }
        },
      };
      const succeeded = await takeFactoryModule.takeLiquidationFactory({
        pool,
        signer,
        poolConfig: factoryPoolConfig,
        liquidation,
        config: factoryConfig,
      });
      return { succeeded, preBroadcastFailed: factoryPreBroadcastFailed };
    },
  };

  return {
    oneInchProvider,
    lifiProvider,
    factoryProvider,
    selectExternalTakeProvider: ({ selectedPath }) => {
      switch (selectedPath) {
        case 'oneinch':
          return oneInchProvider;
        case 'lifi':
          return lifiProvider;
        case 'factory':
          return factoryProvider;
      }
      const exhaustivePath: never = selectedPath;
      throw new Error(`Unsupported external take path: ${exhaustivePath}`);
    },
  };
}
