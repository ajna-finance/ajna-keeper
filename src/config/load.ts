import { promises as fs } from 'fs';
import path from 'path';
import { Config } from '@ajna-finance/sdk';
import type { AjnaConfigParams, KeeperConfig } from './schema';
import { logger } from '../logging';

export async function readConfigFile(filePath: string): Promise<KeeperConfig> {
  try {
    if (filePath.endsWith('.ts')) {
      // FIXME: this prevents users from reading config files from other folders
      const imported = await import('../' + filePath);
      return imported.default;
    }

    const absolutePath = path.resolve(filePath);
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
  expectProperty(config, 'subgraphUrl');
  expectProperty(config, 'keeperKeystore');
  expectProperty(config, 'ajna');
  expectProperty(config, 'pools');
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
