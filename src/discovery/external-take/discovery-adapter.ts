import {
  ActiveExternalTakeRouteSelectionMode,
  ExternalTakePathKind,
  LiquiditySource,
  isDirectDexDynamicSource,
  resolveCalldataAggregatorProviderForSource,
  resolveExternalTakePolicy,
  resolveExternalTakePathFromSource,
} from '../../config';
import { ExternalTakeAdapter } from '../../take/engine';
import { TakeAuctionStatusReader } from '../../take/liquidation-status';
import {
  bindExternalTakeQuoteToExecutionResult,
  getExternalTakeExecutionPlanPrimaryEvaluation,
} from '../../take/external-take/execution-plan';
import { createNoExternalTakeAdapter } from '../../take/no-external-take-adapter';
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
  kind: 'calldata_aggregator' | 'direct_dex';
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
  const resolvedExternalTakePolicy = resolveExternalTakePolicy({
    defaultLiquiditySource: params.target.take.liquiditySource,
    takePolicy: params.takePolicy,
  });
  if (resolvedExternalTakePolicy.externalTakePathsExplicitlyConfigured) {
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
          calldataAggregatorProviders:
            resolvedExternalTakePolicy.calldataAggregatorProviders,
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
          calldataAggregatorProviders:
            resolvedExternalTakePolicy.calldataAggregatorProviders,
          providerRegistry: params.providerRegistry,
          approveExternalTake: params.approveExternalTake,
          takeAuctionStatusReader: params.takeAuctionStatusReader,
          stats: params.stats,
        }),
    };
  }

  const targetPath = resolveExternalTakePathFromSource(
    params.target.take.liquiditySource
  );
  if (targetPath === 'calldata_aggregator') {
    const providerId = resolveCalldataAggregatorProviderForSource(
      params.target.take.liquiditySource
    );
    if (!providerId) {
      return createNoExternalTakeAdapter<DiscoveryExternalTakeApprovalContext>();
    }
    return createProviderBackedDirectAdapter({
      kind: 'calldata_aggregator',
      provider: params.providerRegistry.selectExternalTakeProvider({
        selectedPath: 'calldata_aggregator',
        providerId,
      }),
      stats: params.stats,
    });
  }

  if (isDirectDexDynamicSource(params.target.take.liquiditySource)) {
    return createProviderBackedDirectAdapter({
      kind: 'direct_dex',
      provider: params.providerRegistry.selectExternalTakeProvider({
        selectedPath: 'direct_dex',
      }),
      stats: params.stats,
    });
  }

  return createNoExternalTakeAdapter<DiscoveryExternalTakeApprovalContext>();
}
