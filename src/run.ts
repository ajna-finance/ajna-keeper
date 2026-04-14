import { AjnaSDK, Signer } from '@ajna-finance/sdk';
import { Wallet } from 'ethers';
import {
  configureAjna,
  getAutoDiscoverTakePolicy,
  KeeperConfig,
  PoolConfig,
  validateAutoDiscoverConfig,
  validateTakeWriteConfig,
  validateTakeSettingsForChain,
} from './config';
import {
  delay,
  getProviderAndSigner,
  overrideMulticall,
  RequireFields,
} from './utils';
import { handleKicks } from './kick';
import { logger } from './logging';
import { collectBondFromPool, LpCollector, RewardActionTracker } from './rewards';
import { DexRouter } from './dex/router';
import { tryReactiveSettlement } from './settlement';
import {
  cacheConfiguredPool,
  PoolHydrationCooldowns,
  PoolMap,
} from './discovery/targets';
import { createDiscoveryRuntime, DiscoveryRuntime } from './discovery/runtime';
import { createSubgraphReader, SubgraphReader } from './read-transports';
import {
  createTakeWriteTransport,
  TakeWriteTransport,
} from './take/write-transport';

interface KeepPoolParams {
  poolMap: PoolMap;
  config: KeeperConfig;
  signer: Signer;
}

interface DiscoveryLoopParams extends KeepPoolParams {
  discoveryRuntime: DiscoveryRuntime;
}

interface KickLoopParams extends KeepPoolParams {
  chainId?: number;
  subgraph: SubgraphReader;
}

interface LoopIterationResult {
  delaySeconds: number;
  recovered: boolean;
}

const LOOP_CRASH_RECOVERY_DELAY_SECONDS = 30;

export function shouldRunTakeLoop(config: KeeperConfig): boolean {
  const hasManualTakeTargets = config.pools.some(({ take }) => !!take);
  const hasDiscoveredTakeTargets =
    !!config.autoDiscover?.enabled &&
    !!getAutoDiscoverTakePolicy(config.autoDiscover);
  return hasManualTakeTargets || hasDiscoveredTakeTargets;
}

export async function initializeTakeLoop(params: {
  config: KeeperConfig;
  signer: Wallet;
  chainId: number;
}): Promise<{
  takeLoopEnabled: boolean;
  takeWriteTransport?: TakeWriteTransport;
}> {
  const takeLoopConfigured = shouldRunTakeLoop(params.config);
  if (!takeLoopConfigured) {
    return { takeLoopEnabled: false };
  }

  validateTakeSettingsForChain(params.config, params.chainId);
  validateTakeWriteConfig(params.config);

  try {
    return {
      takeLoopEnabled: true,
      takeWriteTransport: await createTakeWriteTransport({
        signer: params.signer,
        config: params.config,
        expectedChainId: params.chainId,
      }),
    };
  } catch (error) {
    logger.error(
      'Failed to initialize take write transport during startup; the take loop remains enabled and will retry transport initialization in-cycle.',
      error
    );
    return {
      takeLoopEnabled: true,
    };
  }
}

export async function startKeeperFromConfig(config: KeeperConfig) {
  const { provider, signer } = await getProviderAndSigner(
    config.keeperKeystore,
    config.ethRpcUrl
  );
  const network = await provider.getNetwork();
  const chainId = network.chainId;

  configureAjna(config.ajna);
  validateAutoDiscoverConfig(config, chainId);
  const { takeLoopEnabled, takeWriteTransport } = await initializeTakeLoop({
    config,
    signer,
    chainId,
  });

  const ajna = new AjnaSDK(provider);
  logger.info('...and pools:');
  const poolMap = await getPoolsFromConfig(ajna, config);
  const hydrationCooldowns: PoolHydrationCooldowns = new Map();
  const discoverySnapshotState = {};
  const subgraph = createSubgraphReader(config);
  const discoveryRuntime = createDiscoveryRuntime({
    ajna,
    poolMap,
    config,
    signer,
    takeWriteTransport,
    hydrationCooldowns,
    discoverySnapshotState,
  });

  kickPoolsLoop({ poolMap, config, signer, chainId, subgraph });
  if (takeLoopEnabled) {
    takePoolsLoop({ config, signer, poolMap, discoveryRuntime });
  }
  settlementLoop({ config, signer, poolMap, discoveryRuntime });
  collectBondLoop({ poolMap, config, signer, subgraph });
  collectLpRewardsLoop({ poolMap, config, signer, subgraph });
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

async function kickPoolsLoop({
  poolMap,
  config,
  signer,
  chainId,
  subgraph,
}: KickLoopParams) {
  while (true) {
    await processKickCycle({ poolMap, config, signer, chainId, subgraph });
    await delay(config.delayBetweenRuns);
  }
}

export async function processKickCycle({
  poolMap,
  config,
  signer,
  chainId,
  subgraph,
}: KickLoopParams): Promise<void> {
  const poolsWithKickSettings = config.pools.filter(hasKickSettings);
  for (const poolConfig of poolsWithKickSettings) {
    const pool = getPoolFromMap(poolMap, poolConfig.address)!;
    try {
      await handleKicks({
        pool,
        poolConfig,
        signer,
        config: {
          dryRun: config.dryRun,
          delayBetweenActions: config.delayBetweenActions,
          coinGeckoApiKey: config.coinGeckoApiKey,
          ethRpcUrl: config.ethRpcUrl,
          tokenAddresses: config.tokenAddresses,
          subgraph,
        },
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
    await params.discoveryRuntime.runTakeCycle();
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

async function collectBondLoop({
  poolMap,
  config,
  signer,
  subgraph,
}: KeepPoolParams & { subgraph: SubgraphReader }) {
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
            delayBetweenActions: config.delayBetweenActions,
            subgraph,
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
      await params.discoveryRuntime.runSettlementCycle();

      const settlementCheckIntervalSeconds =
        params.discoveryRuntime.getSettlementCheckIntervalSeconds();
      const nextCheck = new Date(
        Date.now() + settlementCheckIntervalSeconds * 1000
      ).toISOString();
      logger.debug(
        `Settlement loop completed, sleeping for ${settlementCheckIntervalSeconds}s until ${nextCheck}`
      );
      await delay(settlementCheckIntervalSeconds);
    } catch (outerError) {
      logLoopCrash('Settlement', outerError);
      await delay(LOOP_CRASH_RECOVERY_DELAY_SECONDS);
      logger.info(`Restarting settlement loop after crash recovery delay`);
    }
  }
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
  subgraph,
}: KeepPoolParams & { subgraph: SubgraphReader }) {
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
                delayBetweenActions: config.delayBetweenActions,
                subgraph,
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
