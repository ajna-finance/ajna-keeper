#!/usr/bin/env ts-node

import yargs from 'yargs/yargs';

import { readConfigFile } from './config';
import {
  assertRunOnceLiveAcknowledged,
  startKeeperFromConfig,
  startKeeperRunOnceFromConfig,
} from './run';
import { logger, setLoggerConfig } from './logging';
import { installProcessSafetyHandlers } from './process-safety';

const argv = yargs(process.argv.slice(2))
  .options({
    config: {
      type: 'string',
      demandOption: true,
      describe: 'Path to the config file',
    },
    'run-once': {
      type: 'boolean',
      default: false,
      describe:
        'Run one take/settlement cycle after startup preflights, then exit',
    },
    'run-once-live-ok': {
      type: 'boolean',
      default: false,
      describe:
        'Acknowledge that --run-once with runtime.dryRun=false can submit real take/settlement transactions',
    },
  })
  .parseSync();

async function main() {
  const config = await readConfigFile(argv.config);
  setLoggerConfig(config);
  logger.info(
    `Starting keeper with...  ETH_RPC_URL: ${config.network.rpcUrl}, SUBGRAPH_URL: ${config.network.subgraph.url}`
  );
  if (argv.runOnce) {
    assertRunOnceLiveAcknowledged(config, argv.runOnceLiveOk);
    if (!config.runtime.dryRun) {
      logger.warn(
        'Run-once live execution acknowledged: this process can submit real take/settlement transactions and will not run kick, bond, or LP reward loops.'
      );
    }
    const result = await startKeeperRunOnceFromConfig(config);
    logger.info(`Run-once keeper completed: ${JSON.stringify(result)}`);
    return;
  }
  await startKeeperFromConfig(config);
}

installProcessSafetyHandlers();
main().catch((error) => {
  logger.error('Fatal keeper error; exiting.', error);
  process.exit(1);
});
