import { promises as fs } from 'fs';
import path from 'path';
import { Config } from '@ajna-finance/sdk';
import type { AjnaConfigParams, KeeperConfig } from './schema';
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
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
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
