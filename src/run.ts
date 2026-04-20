import { AjnaSDK, Signer } from '@ajna-finance/sdk';
import { Wallet } from 'ethers';
import {
  configureAjna,
  getAutoDiscoverSettlementPolicy,
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
import {
  collectBondFromPool,
  LpIngester,
  LpManager,
  LpRedeemer,
  RewardActionTracker,
} from './rewards';
import {
  isLpCollectionEnabled,
  resolveCollectLpRewardForPool,
} from './config';
import { DexRouter } from './dex/router';
import { tryReactiveSettlement } from './settlement';
import {
  cacheConfiguredPool,
  ensurePoolLoaded,
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

function isPermanentTakeWriteTransportInitializationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('does not match keeper chainId') ||
    message.includes('requires the keeper signer to be connected to a provider') ||
    message.includes('Unsupported take write transport mode')
  );
}

export function shouldRunTakeLoop(config: KeeperConfig): boolean {
  const hasManualTakeTargets = config.pools.some(({ take }) => !!take);
  const hasDiscoveredTakeTargets =
    !!config.autoDiscover?.enabled &&
    !!getAutoDiscoverTakePolicy(config.autoDiscover);
  return hasManualTakeTargets || hasDiscoveredTakeTargets;
}

export function shouldRunSettlementLoop(config: KeeperConfig): boolean {
  const hasManualSettlementTargets = config.pools.some(
    ({ settlement }) => settlement?.enabled === true
  );
  const hasDiscoveredSettlementTargets =
    !!config.autoDiscover?.enabled &&
    !!getAutoDiscoverSettlementPolicy(config.autoDiscover);
  return hasManualSettlementTargets || hasDiscoveredSettlementTargets;
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
  if (params.config.dryRun) {
    return { takeLoopEnabled: true };
  }

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
    if (isPermanentTakeWriteTransportInitializationError(error)) {
      throw error;
    }

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
  if (shouldRunSettlementLoop(config)) {
    settlementLoop({ config, signer, poolMap, discoveryRuntime });
  }
  collectBondLoop({ poolMap, config, signer, subgraph });
  collectLpRewardsLoop({
    poolMap,
    config,
    signer,
    subgraph,
    ajna,
    hydrationCooldowns,
  });
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
  ajna,
  hydrationCooldowns,
}: KeepPoolParams & {
  subgraph: SubgraphReader;
  ajna: AjnaSDK;
  hydrationCooldowns: PoolHydrationCooldowns;
}) {
  // Early-exit if the operator didn't enable LP collection via either
  // `defaultLpReward` or any per-pool `collectLpReward` override.
  if (!isLpCollectionEnabled(config)) {
    logger.info(
      'LP reward collection disabled (no defaultLpReward or per-pool collectLpReward configured).'
    );
    return;
  }

  const dexRouter = new DexRouter(signer, {
    oneInchRouters: config?.oneInchRouters ?? {},
    connectorTokens: config?.connectorTokens ?? [],
    tokenAddresses: config.tokenAddresses,
  });
  const exchangeTracker = new RewardActionTracker(signer, config, dexRouter);

  const ingester = new LpIngester(signer, subgraph, config);
  const redeemers: Map<string, LpRedeemer> = new Map();

  // Resolves (and lazily hydrates) the LpRedeemer for a pool address
  // discovered in a subgraph event. Returns undefined if the pool can't
  // be hydrated (ERC721, deployment mismatch, hydration cooldown) or if
  // no LP settings apply — events for such pools are silently skipped.
  const resolveRedeemer = async (
    poolAddress: string
  ): Promise<LpRedeemer | undefined> => {
    const normalized = poolAddress.toLowerCase();
    const cached = redeemers.get(normalized);
    if (cached) return cached;

    const pool = await ensurePoolLoaded({
      ajna,
      poolMap,
      poolAddress: normalized,
      config,
      hydrationCooldowns,
    });
    if (!pool) return undefined;

    const matchingConfig = config.pools.find(
      (p) => p.address.toLowerCase() === normalized
    );
    const settings = resolveCollectLpRewardForPool(
      config.defaultLpReward,
      matchingConfig?.collectLpReward,
      normalized
    );
    if (!settings) return undefined;

    const redeemer = new LpRedeemer(
      pool,
      signer,
      settings,
      config,
      exchangeTracker
    );
    redeemers.set(normalized, redeemer);
    return redeemer;
  };

  const manager = new LpManager(ingester, resolveRedeemer);

  while (true) {
    let touched: LpRedeemer[] = [];
    try {
      touched = await manager.ingestAndDispatch();
    } catch (ingestError) {
      // A failed subgraph fetch shouldn't kill the loop — next cycle
      // retries. The cursor hasn't advanced (ingest throws before cursor
      // commit), so nothing is lost.
      logger.error(
        'LP ingest cycle failed; retrying next cycle',
        ingestError
      );
    }

    for (const redeemer of touched) {
      const pool = redeemer.pool;
      const normalized = pool.poolAddress.toLowerCase();
      const poolConfig = config.pools.find(
        (p) => p.address.toLowerCase() === normalized
      );

      try {
        await redeemer.sweep();
        await delay(config.delayBetweenActions);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('AuctionNotCleared')) {
          logger.info(
            `AuctionNotCleared detected - attempting settlement for ${pool.name}`
          );

          if (!poolConfig) {
            // Auto-discovered pool without an explicit config entry has
            // no settlement policy. Log and skip — the bucket stays in
            // lpMap; next cycle retries (maybe the auction clears in
            // the meantime).
            logger.warn(
              `Settlement skipped for ${pool.name}: no config entry (auto-discovered pool). LP remains pending.`
            );
            continue;
          }

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
              logger.info(
                `Retrying LP collection after settlement in ${pool.name}`
              );
              try {
                await redeemer.sweep();
                await delay(config.delayBetweenActions);
              } catch (retryError) {
                logger.error(
                  `LP sweep retry after settlement still failed for ${pool.name}`,
                  retryError
                );
              }
            } else {
              logger.warn(
                `Settlement attempted but bonds still locked in ${pool.name}`
              );
            }
          } catch (settlementError) {
            logger.error(
              `Settlement failed for ${pool.name}:`,
              settlementError
            );
          }
        } else {
          logger.error(
            `Failed to collect LP reward from pool: ${pool.name}.`,
            error
          );
        }
      }
    }

    try {
      await exchangeTracker.handleAllTokens();
    } catch (error) {
      // A swap/transfer failure in one cycle must not kill the whole LP
      // collection loop — next cycle will re-queue and retry any
      // unprocessed tokens that are still sitting in the tracker.
      logger.error(
        'Failed to process queued reward-action tokens; continuing.',
        error
      );
    }
    await delay(config.delayBetweenRuns);
  }
}
