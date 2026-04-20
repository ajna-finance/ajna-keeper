import { promises as fs } from 'fs';
import path from 'path';
import { Config } from '@ajna-finance/sdk';
import type {
  AjnaConfigParams,
  CollectLpRewardSettings,
  KeeperConfig,
  RewardAction,
} from './schema';
import { RewardActionLabel, PostAuctionDex } from './schema';
import { isValidLookbackSeconds, resolveCollectLpRewardForPool } from './lp-reward';
import { logger } from '../logging';

export async function readConfigFile(filePath: string): Promise<KeeperConfig> {
  try {
    const absolutePath = path.resolve(filePath);
    if (filePath.endsWith('.ts')) {
      const imported = require(absolutePath);
      const config = imported.default ?? imported;
      assertIsValidConfig(config);
      return config;
    }
    const fileContents = await fs.readFile(absolutePath, 'utf-8');
    const parsedFile = JSON.parse(fileContents);
    assertIsValidConfig(parsedFile);
    return parsedFile;
  } catch (error) {
    logger.error('Error reading config file:', error);
    process.exit(1);
  }
}

export function assertIsValidConfig(
  config: Partial<KeeperConfig>
): asserts config is KeeperConfig {
  expectProperty(config, 'ethRpcUrl');
  expectProperty(config, 'logLevel');
  expectProperty(config, 'subgraphUrl');
  expectProperty(config, 'keeperKeystore');
  expectProperty(config, 'ajna');
  expectProperty(config, 'delayBetweenActions');
  expectProperty(config, 'delayBetweenRuns');
  expectProperty(config, 'pools');

  // Optional field; only validate if the operator set it. Values flow into
  // BigNumber arithmetic for the subgraph cursor — negative, fractional, or
  // non-finite inputs silently corrupt the cursor or disable dedupe.
  if (config.lpRewardLookbackSeconds !== undefined) {
    const v = config.lpRewardLookbackSeconds;
    const hardMaxSeconds = 86_400; // 1 day
    if (!isValidLookbackSeconds(v)) {
      throw new Error(
        `lpRewardLookbackSeconds must be a non-negative integer (number), got: ${JSON.stringify(v)} (typeof ${typeof v})`
      );
    }
    if (v > hardMaxSeconds) {
      throw new Error(
        `lpRewardLookbackSeconds must not exceed ${hardMaxSeconds} (1 day), got: ${v}. ` +
          'Larger values cause near-full historical replay every cycle; ' +
          'if your subgraph really lags this much, fix the indexer instead.'
      );
    }
    // Warn (don't reject) at unusual-but-legal bounds so an obvious
    // misconfiguration surfaces in the log without blocking it.
    if (v === 0) {
      logger.warn(
        'lpRewardLookbackSeconds=0 disables the indexing-lag overlap; ' +
          'any late-indexed event will be permanently missed.'
      );
    } else if (v > 3600) {
      logger.warn(
        `lpRewardLookbackSeconds=${v} is unusually large (>1h). Each query ` +
          'shifts the cursor back by this amount; on a pool with steady ' +
          'BucketTake flow, this produces a near-full historical replay ' +
          'every cycle. Verify your subgraph really lags this much.'
      );
    }
  }

  // `defaultLpReward`, when set, must specify the two mandatory min-amount
  // fields. Without those, the redemption layer has no floor and would
  // attempt to redeem rounding-dust every cycle.
  if (config.defaultLpReward !== undefined) {
    validateCollectLpRewardSettings(config.defaultLpReward, 'defaultLpReward');
  }

  // Dry-run the per-pool override merge for every pool so config errors
  // (invalid reward-action shapes, legacy-mode per-pool entry missing
  // mandatory fields) surface at startup rather than mid-loop in a
  // resolver throw. An undefined return just means "no LP collection for
  // this pool" — not an error.
  if (config.pools) {
    for (const pool of config.pools) {
      try {
        const merged = resolveCollectLpRewardForPool(
          config.defaultLpReward,
          pool.collectLpReward,
          pool.address
        );
        if (merged) {
          validateCollectLpRewardSettings(
            merged,
            `pools[${pool.address}].collectLpReward (merged)`
          );
        }
      } catch (error) {
        throw new Error(
          `Invalid LP reward config for pool ${pool.address}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}

function validateCollectLpRewardSettings(
  settings: CollectLpRewardSettings,
  path: string
): void {
  if (
    typeof settings.minAmountQuote !== 'number' ||
    !Number.isFinite(settings.minAmountQuote) ||
    settings.minAmountQuote < 0
  ) {
    throw new Error(
      `${path}.minAmountQuote must be a non-negative number, got: ${JSON.stringify(settings.minAmountQuote)}`
    );
  }
  if (
    typeof settings.minAmountCollateral !== 'number' ||
    !Number.isFinite(settings.minAmountCollateral) ||
    settings.minAmountCollateral < 0
  ) {
    throw new Error(
      `${path}.minAmountCollateral must be a non-negative number, got: ${JSON.stringify(settings.minAmountCollateral)}`
    );
  }
  if (settings.rewardActionQuote !== undefined) {
    validateRewardAction(settings.rewardActionQuote, `${path}.rewardActionQuote`);
  }
  if (settings.rewardActionCollateral !== undefined) {
    validateRewardAction(
      settings.rewardActionCollateral,
      `${path}.rewardActionCollateral`
    );
  }
}

function validateRewardAction(action: RewardAction, path: string): void {
  if (
    action.action !== RewardActionLabel.TRANSFER &&
    action.action !== RewardActionLabel.EXCHANGE
  ) {
    throw new Error(
      `${path}.action must be RewardActionLabel.TRANSFER or RewardActionLabel.EXCHANGE, got: ${JSON.stringify((action as any).action)}`
    );
  }
  if (action.action === RewardActionLabel.EXCHANGE) {
    const validDex = Object.values(PostAuctionDex) as string[];
    if (!validDex.includes(action.dexProvider)) {
      throw new Error(
        `${path}.dexProvider must be one of ${validDex.join(', ')}; got: ${JSON.stringify(action.dexProvider)}`
      );
    }
  }
}

function expectProperty<T, K extends keyof T>(config: T, key: K): void {
  if (!(config as object).hasOwnProperty(key)) {
    throw new Error(`Missing ${String(key)} key from config`);
  }
}

export function configureAjna(ajnaConfig: AjnaConfigParams): void {
  new Config(
    ajnaConfig.erc20PoolFactory,
    ajnaConfig.erc721PoolFactory,
    ajnaConfig.poolUtils,
    ajnaConfig.positionManager,
    ajnaConfig.ajnaToken,
    ajnaConfig.grantFund ?? '',
    ajnaConfig.burnWrapper ?? '',
    ajnaConfig.lenderHelper ?? ''
  );
}
