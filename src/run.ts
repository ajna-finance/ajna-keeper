import { AjnaSDK, Signer } from '@ajna-finance/sdk';
import {
  configureAjna,
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
  KeeperConfig,
  PoolConfig,
  validateAutoDiscoverConfig,
  validateTakeSettings,
} from './config-types';
import {
  delay,
  getProviderAndSigner,
  overrideMulticall,
  RequireFields,
} from './utils';
import { handleKicks } from './kick';
import { handleTakes } from './take';
import { collectBondFromPool } from './collect-bond';
import { LpCollector } from './collect-lp';
import { logger } from './logging';
import { RewardActionTracker } from './reward-action-tracker';
import { DexRouter } from './dex-router';
import { handleSettlements, tryReactiveSettlement } from './settlement';
import {
  buildDiscoveredSettlementTargets,
  buildDiscoveredTakeTargets,
  cacheConfiguredPool,
  EffectiveSettlementTarget,
  EffectiveTakeTarget,
  ensurePoolLoaded,
  getChainwideLiquidationAuctionsShared,
  getManualSettlementTargets,
  getManualTakeTargets,
  PoolHydrationCooldowns,
  PoolMap,
} from './auto-discovery';
import {
  DiscoveryRpcCache,
  handleDiscoveredSettlementTarget,
  handleDiscoveredTakeTarget,
} from './auto-discovery-handlers';
import { createFactoryQuoteProviderRuntimeCache } from './take-factory';

interface KeepPoolParams {
  poolMap: PoolMap;
  config: KeeperConfig;
  signer: Signer;
}

interface DiscoveryLoopParams extends KeepPoolParams {
  ajna: AjnaSDK;
  hydrationCooldowns: PoolHydrationCooldowns;
  discoverySnapshotState?: DiscoverySnapshotState;
}

interface KickLoopParams extends KeepPoolParams {
  chainId?: number;
}

interface DiscoverySnapshotState {
  latestLiquidationAuctions?: Awaited<
    ReturnType<typeof getChainwideLiquidationAuctionsShared>
  >;
  fetchedAt?: number;
}

interface LoopIterationResult {
  delaySeconds: number;
  recovered: boolean;
}

const LOOP_CRASH_RECOVERY_DELAY_SECONDS = 30;

export async function startKeeperFromConfig(config: KeeperConfig) {
  const { provider, signer } = await getProviderAndSigner(
    config.keeperKeystore,
    config.ethRpcUrl
  );
  const network = await provider.getNetwork();
  const chainId = network.chainId;

  configureAjna(config.ajna);
  validateAutoDiscoverConfig(config);

  const ajna = new AjnaSDK(provider);
  logger.info('...and pools:');
  const poolMap = await getPoolsFromConfig(ajna, config);
  const hydrationCooldowns: PoolHydrationCooldowns = new Map();
  const discoverySnapshotState: DiscoverySnapshotState = {};

  kickPoolsLoop({ poolMap, config, signer, chainId });
  takePoolsLoop({
    ajna,
    poolMap,
    config,
    signer,
    hydrationCooldowns,
    discoverySnapshotState,
  });
  settlementLoop({
    ajna,
    poolMap,
    config,
    signer,
    hydrationCooldowns,
    discoverySnapshotState,
  });
  collectBondLoop({ poolMap, config, signer });
  collectLpRewardsLoop({ poolMap, config, signer });
}

async function getPoolsFromConfig(
  ajna: AjnaSDK,
  config: KeeperConfig
): Promise<PoolMap> {
  const pools: PoolMap = new Map();
  for (const pool of config.pools) {
    const name: string = pool.name ?? '(unnamed)';
    logger.info(`loading pool ${name.padStart(18)} at ${pool.address}`);
    const fungiblePool = await ajna.fungiblePoolFactory.getPoolByAddress(
      pool.address
    );
    overrideMulticall(fungiblePool, config);
    cacheConfiguredPool(pools, pool, fungiblePool);
  }
  return pools;
}

function getPoolFromMap(poolMap: PoolMap, address: string) {
  return poolMap.get(address) ?? poolMap.get(address.toLowerCase());
}

async function kickPoolsLoop({ poolMap, config, signer, chainId }: KickLoopParams) {
  while (true) {
    await processKickCycle({ poolMap, config, signer, chainId });
    await delay(config.delayBetweenRuns);
  }
}

export async function processKickCycle({
  poolMap,
  config,
  signer,
  chainId,
}: KickLoopParams): Promise<void> {
  const poolsWithKickSettings = config.pools.filter(hasKickSettings);
  for (const poolConfig of poolsWithKickSettings) {
    const pool = getPoolFromMap(poolMap, poolConfig.address)!;
    try {
      await handleKicks({
        pool,
        poolConfig,
        signer,
        config,
        chainId,
      });
      await delay(config.delayBetweenActions);
    } catch (error) {
      logger.error(`Failed to handle kicks for pool: ${pool.name}.`, error);
    }
  }
}

function hasKickSettings(
  config: PoolConfig
): config is RequireFields<PoolConfig, 'kick'> {
  return !!config.kick;
}

async function takePoolsLoop(params: DiscoveryLoopParams) {
  while (true) {
    const result = await runTakeLoopIteration(params);
    await delay(result.delaySeconds);
    if (result.recovered) {
      logger.info(`Restarting take loop after crash recovery delay`);
    }
  }
}

export async function runTakeLoopIteration(
  params: DiscoveryLoopParams
): Promise<LoopIterationResult> {
  try {
    await processTakeCycle(params);
    return {
      delaySeconds: params.config.delayBetweenRuns,
      recovered: false,
    };
  } catch (outerError) {
    logLoopCrash('Take', outerError);
    return {
      delaySeconds: LOOP_CRASH_RECOVERY_DELAY_SECONDS,
      recovered: true,
    };
  }
}

export async function processTakeCycle({
  ajna,
  poolMap,
  config,
  signer,
  hydrationCooldowns,
  discoverySnapshotState,
}: DiscoveryLoopParams): Promise<void> {
  const liquidationAuctions = shouldRefreshDiscoverySnapshotOnTakeCycle(config)
    ? await refreshDiscoverySnapshot(config, discoverySnapshotState)
    : undefined;

  const targets: EffectiveTakeTarget[] = [
    ...getManualTakeTargets(config),
    ...(await buildDiscoveredTakeTargets(config, liquidationAuctions)),
  ];
  const takeDiscoveryRpcCache: DiscoveryRpcCache | undefined =
    targets.some((target) => target.source === 'discovered') && signer.provider
      ? {
          gasPrice: await signer.provider.getGasPrice(),
          factoryQuoteProviders: createFactoryQuoteProviderRuntimeCache(),
        }
      : undefined;

  for (const target of targets) {
    const pool =
      target.source === 'manual'
        ? getPoolFromMap(poolMap, target.poolAddress)
        : await ensurePoolLoaded({
            ajna,
            poolMap,
            poolAddress: target.poolAddress,
            config,
            hydrationCooldowns,
          });

    if (!pool) {
      logger.warn(`Skipping take target ${target.name} because the pool is unavailable`);
      continue;
    }

    try {
      if (target.source === 'manual') {
        validateTakeSettings(target.poolConfig.take, config);
        await handleTakes({
          pool,
          poolConfig: target.poolConfig,
          signer,
          config,
        });
      } else {
        await handleDiscoveredTakeTarget({
          pool,
          signer,
          target,
          config,
          rpcCache: takeDiscoveryRpcCache,
        });
      }
      await delay(config.delayBetweenActions);
    } catch (error) {
      logger.error(`Failed to handle take for pool: ${pool.name}.`, error);
    }
  }
}

function hasTakeSettings(
  config: PoolConfig
): config is RequireFields<PoolConfig, 'take'> {
  return !!config.take;
}

async function collectBondLoop({ poolMap, config, signer }: KeepPoolParams) {
  const poolsWithCollectBondSettings = config.pools.filter(
    ({ collectBond }) => !!collectBond
  );
  while (true) {
    for (const poolConfig of poolsWithCollectBondSettings) {
      const pool = getPoolFromMap(poolMap, poolConfig.address)!;
      try {
        await collectBondFromPool({
          pool,
          signer,
          poolConfig,
          config: {
            dryRun: config.dryRun,
            subgraphUrl: config.subgraphUrl,
            delayBetweenActions: config.delayBetweenActions,
          },
        });
        await delay(config.delayBetweenActions);
      } catch (error) {
        logger.error(`Failed to collect bond from pool: ${pool.name}.`, error);
      }
    }
    await delay(config.delayBetweenRuns);
  }
}

async function settlementLoop(params: DiscoveryLoopParams) {
  while (true) {
    try {
      const startTime = new Date().toISOString();
      logger.debug(`Settlement loop iteration starting at ${startTime}`);
      await processSettlementCycle(params);

      const settlementCheckIntervalSeconds = getSettlementCheckIntervalSeconds(
        params.config
      );
      const nextCheck = new Date(
        Date.now() + settlementCheckIntervalSeconds * 1000
      ).toISOString();
      logger.debug(
        `Settlement loop completed, sleeping for ${settlementCheckIntervalSeconds}s until ${nextCheck}`
      );
      await delay(settlementCheckIntervalSeconds);
    } catch (outerError) {
      const errorMessage =
        outerError instanceof Error ? outerError.message : String(outerError);
      const errorStack =
        outerError instanceof Error ? outerError.stack : undefined;

      logger.error(`Settlement loop crashed, restarting in 30 seconds: ${errorMessage}`);
      if (errorStack) {
        logger.error(`Stack trace:`, errorStack);
      }

      await delay(LOOP_CRASH_RECOVERY_DELAY_SECONDS);
      logger.info(`Restarting settlement loop after crash recovery delay`);
    }
  }
}

export async function processSettlementCycle({
  ajna,
  poolMap,
  config,
  signer,
  hydrationCooldowns,
  discoverySnapshotState,
}: DiscoveryLoopParams): Promise<void> {
  const refreshedLiquidationAuctions = shouldRefreshDiscoverySnapshotOnSettlementCycle(
    config
  )
    ? await refreshDiscoverySnapshot(config, discoverySnapshotState)
    : undefined;
  const discoveredLiquidationAuctions =
    refreshedLiquidationAuctions ??
    (discoverySnapshotState
      ? discoverySnapshotState.latestLiquidationAuctions ?? []
      : undefined);

  const targets: EffectiveSettlementTarget[] = [
    ...getManualSettlementTargets(config),
    ...(await buildDiscoveredSettlementTargets(config, discoveredLiquidationAuctions)),
  ];
  const settlementDiscoveryRpcCache: DiscoveryRpcCache | undefined =
    targets.some((target) => target.source === 'discovered') && signer.provider
      ? {
          gasPrice: await signer.provider.getGasPrice(),
        }
      : undefined;

  logger.info(`Settlement loop started with ${targets.length} pools`);
  logger.info(`Settlement pools: ${targets.map((target) => target.name).join(', ')}`);

  for (const target of targets) {
    const pool =
      target.source === 'manual'
        ? getPoolFromMap(poolMap, target.poolAddress)
        : await ensurePoolLoaded({
            ajna,
            poolMap,
            poolAddress: target.poolAddress,
            config,
            hydrationCooldowns,
          });

    if (!pool) {
      logger.warn(
        `Skipping settlement target ${target.name} because the pool is unavailable`
      );
      continue;
    }

    try {
      logger.debug(`Processing settlement check for pool: ${pool.name}`);
      if (target.source === 'manual') {
        await handleSettlements({
          pool,
          poolConfig: target.poolConfig,
          signer,
          config: {
            dryRun: config.dryRun,
            subgraphUrl: config.subgraphUrl,
            delayBetweenActions: config.delayBetweenActions,
          },
        });
      } else {
        await handleDiscoveredSettlementTarget({
          pool,
          signer,
          target,
          config,
          rpcCache: settlementDiscoveryRpcCache,
        });
      }

      logger.debug(`Settlement check completed for pool: ${pool.name}`);
      await delay(config.delayBetweenActions);
    } catch (poolError) {
      logger.error(`Failed to handle settlements for pool: ${pool.name}`, poolError);
    }
  }
}

function hasSettlementSettings(
  config: PoolConfig
): config is RequireFields<PoolConfig, 'settlement'> {
  return !!config.settlement?.enabled;
}

function shouldRefreshDiscoverySnapshotOnTakeCycle(config: KeeperConfig): boolean {
  return !!config.autoDiscover?.enabled && !!getAutoDiscoverTakePolicy(config.autoDiscover);
}

function shouldRefreshDiscoverySnapshotOnSettlementCycle(
  config: KeeperConfig
): boolean {
  return (
    !!config.autoDiscover?.enabled &&
    !getAutoDiscoverTakePolicy(config.autoDiscover) &&
    !!getAutoDiscoverSettlementPolicy(config.autoDiscover)
  );
}

async function refreshDiscoverySnapshot(
  config: KeeperConfig,
  discoverySnapshotState?: DiscoverySnapshotState
) {
  const liquidationAuctions = await getChainwideLiquidationAuctionsShared(config);
  if (discoverySnapshotState) {
    discoverySnapshotState.latestLiquidationAuctions = liquidationAuctions;
    discoverySnapshotState.fetchedAt = Date.now();
  }
  return liquidationAuctions;
}

function getSettlementCheckIntervalSeconds(config: KeeperConfig): number {
  return Math.max(config.delayBetweenRuns * 5, 120);
}

function logLoopCrash(loopName: string, outerError: unknown): void {
  const errorMessage =
    outerError instanceof Error ? outerError.message : String(outerError);
  const errorStack = outerError instanceof Error ? outerError.stack : undefined;

  logger.error(
    `${loopName} loop crashed, restarting in ${LOOP_CRASH_RECOVERY_DELAY_SECONDS} seconds: ${errorMessage}`
  );
  if (errorStack) {
    logger.error(`Stack trace:`, errorStack);
  }
}

async function collectLpRewardsLoop({
  poolMap,
  config,
  signer,
}: KeepPoolParams) {
  const poolsWithCollectLpSettings = config.pools.filter(hasCollectLpSettings);
  const lpCollectors: Map<string, LpCollector> = new Map();
  const dexRouter = new DexRouter(signer, {
    oneInchRouters: config?.oneInchRouters ?? {},
    connectorTokens: config?.connectorTokens ?? [],
    tokenAddresses: config.tokenAddresses,
  });
  const exchangeTracker = new RewardActionTracker(
    signer,
    config,
    dexRouter
  );

  for (const poolConfig of poolsWithCollectLpSettings) {
    const pool = getPoolFromMap(poolMap, poolConfig.address)!;
    const collector = new LpCollector(
      pool,
      signer,
      poolConfig,
      config,
      exchangeTracker
    );
    lpCollectors.set(poolConfig.address, collector);
    await collector.startSubscription();
  }

  while (true) {
    for (const poolConfig of poolsWithCollectLpSettings) {
      const collector = lpCollectors.get(poolConfig.address)!;
      try {
        await collector.collectLpRewards();
        await delay(config.delayBetweenActions);
      } catch (error) {
        const pool = getPoolFromMap(poolMap, poolConfig.address)!;
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('AuctionNotCleared')) {
          logger.info(`AuctionNotCleared detected - attempting settlement for ${pool.name}`);

          try {
            const settled = await tryReactiveSettlement({
              pool,
              poolConfig,
              signer,
              config: {
                dryRun: config.dryRun,
                subgraphUrl: config.subgraphUrl,
                delayBetweenActions: config.delayBetweenActions,
              },
            });

            if (settled) {
              logger.info(`Retrying LP collection after settlement in ${pool.name}`);
              await collector.collectLpRewards();
              await delay(config.delayBetweenActions);
            } else {
              logger.warn(`Settlement attempted but bonds still locked in ${pool.name}`);
            }
          } catch (settlementError) {
            logger.error(`Settlement failed for ${pool.name}:`, settlementError);
          }
        } else {
          logger.error(`Failed to collect LP reward from pool: ${pool.name}.`, error);
        }
      }
    }
    await exchangeTracker.handleAllTokens();
    await delay(config.delayBetweenRuns);
  }
}

function hasCollectLpSettings(
  config: PoolConfig
): config is RequireFields<PoolConfig, 'collectLpReward'> {
  return !!config.collectLpReward;
}
