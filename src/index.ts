#!/usr/bin/env ts-node

import yargs from 'yargs/yargs';

import { readConfigFile } from './config';
import { startKeeperFromConfig } from './run';
import { logger, setLoggerConfig } from './logging';

const argv = yargs(process.argv.slice(2))
  .options({
    config: {
      type: 'string',
      demandOption: true,
      describe: 'Path to the config file',
    },
  })
  .parseSync();

async function main() {
  const config = await readConfigFile(argv.config);
  setLoggerConfig(config);
  logger.info(
    `Starting keeper with...  ETH_RPC_URL: ${config.network.rpcUrl}, SUBGRAPH_URL: ${config.network.subgraph.url}`
  );
  await startKeeperFromConfig(config);
}

main();
