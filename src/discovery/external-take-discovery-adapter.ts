import {
  ActiveExternalTakeRouteSelectionMode,
  ExternalTakePathKind,
  LiquiditySource,
  isFactoryDynamicSource,
} from '../config';
import { logger } from '../logging';
import { ExternalTakeAdapter } from '../take/engine';
import { createNoExternalTakeAdapter } from '../take/one-inch-adapter';
import {
  DiscoveryExternalTakeApprovalContext,
  DiscoveryExternalTakeApprover,
} from './external-take-approval';
import {
  DiscoveryExternalTakeProviderRegistry,
  DiscoveryExternalTakeRouteProvider,
} from './external-take-providers';
import { DiscoveryExternalExecutionConfig } from './external-take-provider';
import { AutoDiscoverTakePolicyRuntime } from './external-take-quotes';
import {
  DiscoveredTakeTargetStats,
  recordSuccessfulExternalTakeRouteStats,
} from './external-take-stats';
import {
  evaluateHybridExternalTakeForDiscovery,
  executeHybridExternalTakeForDiscovery,
} from './hybrid-external-take';
import { ResolvedTakeTarget } from './targets';

function createProviderBackedDirectAdapter(params: {
  kind: 'oneinch' | 'lifi' | 'factory';
  provider: DiscoveryExternalTakeRouteProvider;
  stats: DiscoveredTakeTargetStats;
  onFailedAttempt?: (params: {
    poolName: string;
    borrower: string;
    circuitOpenReason?: string;
  }) => void;
}): ExternalTakeAdapter<
  ResolvedTakeTarget,
  DiscoveryExternalExecutionConfig,
  DiscoveryExternalTakeApprovalContext
> {
  return {
    kind: params.kind,
    evaluateExternalTake: async ({
      pool,
      signer,
      poolConfig,
      price,
      auctionPrice,
      collateral,
    }) => ({
      quoteEvaluation: await params.provider.quote({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
        intent: { kind: 'direct' },
      }),
    }),
    executeExternalTake: async ({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    }) => {
      const attempt = await params.provider.execute({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      });
      if (attempt.succeeded) {
        recordSuccessfulExternalTakeRouteStats(
          params.stats,
          liquidation.externalTakeQuoteEvaluation,
          config.dryRun === true
        );
      } else {
        params.onFailedAttempt?.({
          poolName: pool.name,
          borrower: liquidation.borrower,
          circuitOpenReason: attempt.circuitOpenReason,
        });
      }
      return attempt.succeeded;
    },
  };
}

export function createExternalTakeAdapterForDiscovery(params: {
  target: ResolvedTakeTarget;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  probeTimeoutMs: number;
  approveExternalTake: DiscoveryExternalTakeApprover;
  stats: DiscoveredTakeTargetStats;
  providerRegistry: DiscoveryExternalTakeProviderRegistry;
}): ExternalTakeAdapter<
  ResolvedTakeTarget,
  DiscoveryExternalExecutionConfig,
  DiscoveryExternalTakeApprovalContext
> {
  if (params.takePolicy?.allowedExternalTakePaths !== undefined) {
    return {
      kind: 'hybrid',
      evaluateExternalTake: async ({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
      }) =>
        evaluateHybridExternalTakeForDiscovery({
          pool,
          signer,
          poolConfig,
          takePolicy: params.takePolicy,
          externalTakePaths: params.externalTakePaths,
          routeSelectionMode: params.routeSelectionMode,
          probeTimeoutMs: params.probeTimeoutMs,
          price,
          auctionPrice,
          collateral,
          providerRegistry: params.providerRegistry,
          approveExternalTake: params.approveExternalTake,
          stats: params.stats,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) =>
        await executeHybridExternalTakeForDiscovery({
          pool,
          signer,
          poolConfig,
          liquidation,
          config,
          externalTakePaths: params.externalTakePaths,
          providerRegistry: params.providerRegistry,
          approveExternalTake: params.approveExternalTake,
          stats: params.stats,
        }),
    };
  }

  if (params.target.take.liquiditySource === LiquiditySource.ONEINCH) {
    return createProviderBackedDirectAdapter({
      kind: 'oneinch',
      provider: params.providerRegistry.oneInchProvider,
      stats: params.stats,
    });
  }

  if (params.target.take.liquiditySource === LiquiditySource.LIFI) {
    return createProviderBackedDirectAdapter({
      kind: 'lifi',
      provider: params.providerRegistry.lifiProvider,
      stats: params.stats,
      onFailedAttempt: ({ poolName, borrower, circuitOpenReason }) => {
        if (circuitOpenReason) {
          logger.warn(
            `LI.FI execution refresh circuit is open for ${poolName}/${borrower}; skipping direct LI.FI external take`
          );
        }
      },
    });
  }

  if (isFactoryDynamicSource(params.target.take.liquiditySource)) {
    return createProviderBackedDirectAdapter({
      kind: 'factory',
      provider: params.providerRegistry.factoryProvider,
      stats: params.stats,
    });
  }

  return createNoExternalTakeAdapter<DiscoveryExternalTakeApprovalContext>();
}
