#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  OneInchRouteCanarySummary,
  runOneInchRouteCanary,
} from '../src/dex/oneinch-aggregator/route-canary';

dotenv.config();

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function writeSummaryIfRequested(summary: OneInchRouteCanarySummary): void {
  const outputPath = optionalEnv('AJNA_AGENT_ONEINCH_CANARY_OUTPUT_PATH');
  if (!outputPath) {
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function emitSummary(summary: OneInchRouteCanarySummary): void {
  writeSummaryIfRequested(summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function main(): Promise<void> {
  const result = await runOneInchRouteCanary({ env: process.env });
  emitSummary(result.summary);
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  process.stderr.write(
    `1inch canary failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
