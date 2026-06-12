import {
  ActiveExternalTakeRouteSelectionMode,
  ExternalTakePathKind,
  LiquiditySource,
  isFactoryDynamicSource,
} from '../../config';
import { ExternalTakeAdapter } from '../../take/engine';
import { TakeAuctionStatusReader } from '../../take/liquidation-status';
import {
  bindExternalTakeQuoteToExecutionResult,
  getExternalTakeExecutionPlanPrimaryEvaluation,
} from '../../take/external-take/execution-plan';
import { createNoExternalTakeAdapter } from '../../take/one-inch-adapter';
import {
  DiscoveryExternalTakeApprovalContext,
  DiscoveryExternalTakeApprover,
} from './approval';
import {
  DiscoveryExternalTakeProviderRegistry,
  DiscoveryExternalTakeRouteProvider,
} from './providers';
import { DiscoveryExternalExecutionConfig } from './provider';
import { AutoDiscoverTakePolicyRuntime } from './quotes';
import {
  DiscoveredTakeTargetStats,
  recordSuccessfulExternalTakeRouteStats,
} from './stats';
import {
  evaluateHybridExternalTakeForDiscovery,
  executeHybridExternalTakeForDiscovery,
} from './hybrid';
import { ResolvedTakeTarget } from '../targets';

function createProviderBackedDirectAdapter(params: {
  kind: 'oneinch' | 'lifi' | 'factory';
  provider: DiscoveryExternalTakeRouteProvider;
  stats: DiscoveredTakeTargetStats;
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
      candidate,
      price,
      auctionPrice,
      collateral,
      debtToCover,
    }) => {
      const quoteEvaluation = await params.provider.quote({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
        debtToCover,
        intent: { kind: 'direct' },
      });
      return bindExternalTakeQuoteToExecutionResult({
        quoteEvaluation,
        configuredLiquiditySource: poolConfig.take.liquiditySource,
        poolName: pool.name,
        borrower: candidate.borrower,
      });
    },
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
          getExternalTakeExecutionPlanPrimaryEvaluation(
            liquidation.externalTakeExecutionPlan
          ),
          config.dryRun === true
        );
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
  takeAuctionStatusReader: TakeAuctionStatusReader;
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
        debtToCover,
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
          debtToCover,
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
          takeAuctionStatusReader: params.takeAuctionStatusReader,
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
