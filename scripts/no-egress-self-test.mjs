#!/usr/bin/env node

import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import process from 'process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { installNoEgressGuard } = require('./no-egress-guard.cjs');

function parseArgs(argv) {
  const options = {
    outputPath: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') {
      options.outputPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--help') {
      process.stdout.write(
        'Usage: node scripts/no-egress-self-test.mjs [--output /path/report.json]\n'
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requestWithHttpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
  });
}

async function expectBlocked(name, fn) {
  try {
    await fn();
    return {
      name,
      passed: false,
      error: 'request was not blocked',
    };
  } catch (error) {
    const metadata = error?.egressGuard;
    return {
      name,
      passed:
        error?.code === 'AJNA_UNEXPECTED_EGRESS' &&
        metadata?.result === 'unexpected_egress' &&
        typeof metadata?.redactedTarget === 'string' &&
        !metadata.redactedTarget.includes('?') &&
        !metadata.redactedTarget.includes('/v1/') &&
        !metadata.redactedTarget.includes('/swap/'),
      code: error?.code,
      classification: metadata?.result,
      redactedTarget: metadata?.redactedTarget,
      hostname: metadata?.hostname,
      error:
        error instanceof Error
          ? error.message.replace(/https?:\/\/[^ ]+/g, '[redacted-url]')
          : String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajna-egress-self-'));
  const outputPath =
    options.outputPath ?? path.join(tempDir, 'egress-self-test-report.json');
  const blockedJsonlPath = path.join(tempDir, 'blocked-egress.jsonl');
  const blockedRecords = [];

  installNoEgressGuard({
    allowedHosts: '127.0.0.1,localhost,::1',
    reportPath: blockedJsonlPath,
    reporter: (metadata) => blockedRecords.push(metadata),
  });

  const results = await Promise.all([
    expectBlocked('lifi', () => fetch('https://li.quest/v1/status')),
    expectBlocked('oneinch', () =>
      requestWithHttpsGet(
        'https://api.1inch.dev/swap/v6.0/8453/quote?src=0x0000000000000000000000000000000000000000'
      )
    ),
    expectBlocked('relay', () =>
      fetch('https://relay.flashbots.net', {
        method: 'POST',
        body: '{}',
      })
    ),
    expectBlocked('live-subgraph', () =>
      fetch('https://api.thegraph.com/subgraphs/name/ajna/base')
    ),
  ]);

  const report = {
    status:
      blockedRecords.some((record) => record.result === 'guard_installed') &&
      results.every((result) => result.passed)
        ? 'passed'
        : 'failed',
    results,
    blockedRecords,
    blockedJsonlPath,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    `[egress-self-test] status=${report.status}\n` +
      `[egress-self-test] report=${outputPath}\n`
  );
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `[egress-self-test] failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
