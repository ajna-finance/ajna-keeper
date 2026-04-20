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
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      throw new Error(
        `lpRewardLookbackSeconds must be a non-negative integer, got: ${v}`
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
