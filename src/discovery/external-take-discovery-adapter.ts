import {
  ActiveExternalTakeRouteSelectionMode,
  ExternalTakePathKind,
  LiquiditySource,
} from '../config';
import { logger } from '../logging';
import { ExternalTakeAdapter } from '../take/engine';
import { createNoExternalTakeAdapter } from '../take/one-inch-adapter';
import { DiscoveryExternalTakeApprover } from './external-take-approval';
import { createDiscoveryExternalTakeProviderRegistry } from './external-take-providers';
import { DiscoveryExternalExecutionConfig } from './external-take-provider';
import {
  AutoDiscoverTakePolicyRuntime,
  FactoryPathQuoteFn,
  LifiCircuitOutcome,
  LifiPathQuoteFn,
  OneInchCircuitOutcome,
  OneInchPathQuoteFn,
} from './external-take-quotes';
import {
  DiscoveredTakeTargetStats,
  recordSuccessfulExternalTakeRouteStats,
} from './external-take-stats';
import {
  evaluateHybridExternalTakeForDiscovery,
  executeHybridExternalTakeForDiscovery,
} from './hybrid-external-take';
import { ResolvedTakeTarget } from './targets';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from './types';

export function createExternalTakeAdapterForDiscovery(params: {
  target: ResolvedTakeTarget;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  externalTakePaths: ExternalTakePathKind[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  probeTimeoutMs: number;
  quoteOneInchPath: OneInchPathQuoteFn;
  quoteKeeperTakerOneInchTake: OneInchPathQuoteFn;
  quoteFactoryPath: FactoryPathQuoteFn;
  quoteLifiPath: LifiPathQuoteFn;
  approveExternalTake: DiscoveryExternalTakeApprover;
  recordOneInchCircuitOutcome: (outcome: OneInchCircuitOutcome) => void;
  recordLifiCircuitOutcome: (outcome: LifiCircuitOutcome) => void;
  stats: DiscoveredTakeTargetStats;
  config: DiscoveryExecutionConfig;
  rpcCache?: DiscoveryRpcCache;
}): ExternalTakeAdapter<ResolvedTakeTarget, DiscoveryExternalExecutionConfig> {
  const providerRegistry = createDiscoveryExternalTakeProviderRegistry({
    config: params.config,
    rpcCache: params.rpcCache,
  });

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
          quoteOneInchPath: params.quoteOneInchPath,
          quoteFactoryPath: params.quoteFactoryPath,
          quoteLifiPath: params.quoteLifiPath,
          approveExternalTake: params.approveExternalTake,
          recordOneInchCircuitOutcome: params.recordOneInchCircuitOutcome,
          recordLifiCircuitOutcome: params.recordLifiCircuitOutcome,
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
          providerRegistry,
          approveExternalTake: params.approveExternalTake,
          stats: params.stats,
        }),
    };
  }

  if (params.target.take.liquiditySource === LiquiditySource.ONEINCH) {
    return {
      kind: 'oneinch',
      evaluateExternalTake: async ({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
      }) =>
        params.quoteKeeperTakerOneInchTake({
          pool,
          signer,
          poolConfig,
          price,
          auctionPrice,
          collateral,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) => {
        const attempt = await providerRegistry.oneInchProvider.execute({
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
        }
        return attempt.succeeded;
      },
    };
  }

  if (params.target.take.liquiditySource === LiquiditySource.LIFI) {
    return {
      kind: 'lifi',
      evaluateExternalTake: async ({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
      }) =>
        params.quoteLifiPath({
          pool,
          signer,
          poolConfig,
          price,
          auctionPrice,
          collateral,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) => {
        const attempt = await providerRegistry.lifiProvider.execute({
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
        } else if (attempt.circuitOpenReason) {
          logger.warn(
            `LI.FI execution refresh circuit is open for ${pool.name}/${liquidation.borrower}; skipping direct LI.FI external take`
          );
        }
        return attempt.succeeded;
      },
    };
  }

  if (params.target.take.liquiditySource !== undefined) {
    return {
      kind: 'factory',
      evaluateExternalTake: async ({
        pool,
        signer,
        poolConfig,
        auctionPrice,
        collateral,
      }) =>
        params.quoteFactoryPath({
          pool,
          signer,
          poolConfig,
          auctionPrice,
          collateral,
        }),
      executeExternalTake: async ({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }) => {
        const attempt = await providerRegistry.factoryProvider.execute({
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
        }
        return attempt.succeeded;
      },
    };
  }

  return createNoExternalTakeAdapter();
}
