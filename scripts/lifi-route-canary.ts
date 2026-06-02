#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import yargs from 'yargs/yargs';
import { readConfigFile } from '../src/config';
import {
  LifiRouteCanarySummary,
  runLifiRouteCanary,
} from '../src/dex/lifi/route-canary';

dotenv.config();

const argv = yargs(process.argv.slice(2))
  .options({
    config: {
      type: 'string',
      describe:
        'Optional keeper config path. When provided, dex.lifi and takers.contracts.Lifi seed the canary policy.',
    },
  })
  .parseSync();

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function writeSummaryIfRequested(summary: LifiRouteCanarySummary): void {
  const outputPath = optionalEnv('AJNA_AGENT_LIFI_CANARY_OUTPUT_PATH');
  if (!outputPath) {
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function emitSummary(summary: LifiRouteCanarySummary): void {
  writeSummaryIfRequested(summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function main(): Promise<void> {
  const config = argv.config ? await readConfigFile(argv.config) : undefined;
  const result = await runLifiRouteCanary({
    env: process.env,
    config,
  });
  emitSummary(result.summary);
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  process.stderr.write(
    `LI.FI canary failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
