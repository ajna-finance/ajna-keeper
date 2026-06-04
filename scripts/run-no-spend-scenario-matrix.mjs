#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

function usage() {
  return `Usage: node scripts/run-no-spend-scenario-matrix.mjs [--base-fork-block N|latest] [--output /path/report.json]

Runs deterministic local no-spend scenarios against one resolved Base fork
block and writes one JSON matrix summary.
`;
}

function parseArgs(argv) {
  const options = {
    baseForkBlock:
      process.env.AJNA_AGENT_NO_SPEND_BASE_FORK_BLOCK ??
      process.env.BASE_FORK_BLOCK ??
      'latest',
    outputPath: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--base-fork-block') {
      options.baseForkBlock = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--output') {
      options.outputPath = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    options.baseForkBlock !== 'latest' &&
    (!/^\d+$/.test(options.baseForkBlock) ||
      Number(options.baseForkBlock) <= 0)
  ) {
    throw new Error('--base-fork-block must be a positive integer or latest');
  }
  return options;
}

function envValueWithSource(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return { name, value };
    }
  }
  return undefined;
}

function resolveForkRpcUrl() {
  const configured = envValueWithSource(
    'AJNA_AGENT_NO_SPEND_FORK_RPC_URL',
    'BASE_RPC_URL',
    'AJNA_RPC_URL_BASE',
    'AJNA_AGENT_RPC_URL'
  );
  const forkRpcUrl =
    configured?.value ??
    (process.env.ALCHEMY_API_KEY
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : undefined);
  const source =
    configured?.name ?? (process.env.ALCHEMY_API_KEY ? 'ALCHEMY_API_KEY' : '');
  if (!forkRpcUrl) {
    throw new Error(
      'Missing Base fork RPC. Set BASE_RPC_URL, AJNA_RPC_URL_BASE, AJNA_AGENT_RPC_URL, AJNA_AGENT_NO_SPEND_FORK_RPC_URL, or ALCHEMY_API_KEY.'
    );
  }
  return { forkRpcUrl, source };
}

function requestJsonRpc(rpcUrl, method, params = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });
    const url = new URL(rpcUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        ...(url.username || url.password
          ? {
              auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(
                url.password
              )}`,
            }
          : {}),
        timeout: 15_000,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) {
              reject(
                new Error(
                  `${method} failed: ${JSON.stringify(parsed.error)}`
                )
              );
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(
              new Error(
                `Failed to parse ${method} response: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            );
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy(new Error(`${method} timed out`));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

async function resolveForkBlock(params) {
  const tag =
    params.requested === 'latest'
      ? 'latest'
      : `0x${Number(params.requested).toString(16)}`;
  const block = await requestJsonRpc(params.forkRpcUrl, 'eth_getBlockByNumber', [
    tag,
    false,
  ]);
  if (!block?.number || !block?.hash) {
    throw new Error(`Failed to resolve Base fork block for ${params.requested}`);
  }
  return {
    requested: params.requested,
    number: Number.parseInt(block.number, 16),
    hash: block.hash,
  };
}

function redactUrlForReport(rawUrl, source) {
  const url = new URL(rawUrl);
  return {
    source,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    credentialRedacted: Boolean(url.username || url.password),
  };
}

function readTail(filePath, maxBytes = 6_000) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  const buffer = fs.readFileSync(filePath);
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString();
}

function runCommand(params) {
  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(params.logPath, { flags: 'a' });
    const child = spawn(params.command[0], params.command.slice(1), {
      cwd: ROOT,
      env: {
        ...process.env,
        ...params.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));
    child.on('close', (code, signal) => {
      logStream.end(() => {
        resolve({
          status: code === 0 ? 'passed' : 'failed',
          exitCode: code,
          signal: signal ?? undefined,
          logPath: params.logPath,
          tail: code === 0 ? undefined : readTail(params.logPath),
        });
      });
    });
    child.on('error', (error) => {
      logStream.end(() => {
        resolve({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          logPath: params.logPath,
        });
      });
    });
  });
}

function buildNoSpendCommand(params) {
  return [
    'npm',
    'run',
    'no-spend-validation',
    '--',
    '--scenario',
    params.name,
    '--base-fork-block',
    String(params.blockNumber),
    '--hybrid-gas-quote-fallback',
    params.hybridGasQuoteFallback ?? 'factory_first',
    '--expect',
    params.expect ?? 'success',
    '--output',
    params.outputPath,
    ...(params.mode ? ['--mode', params.mode] : []),
    ...(params.dryRunOnly ? ['--dry-run-only'] : []),
    ...(params.runConfigSmoke ? ['--run-config-smoke'] : []),
    ...(params.expectedFeeTier
      ? ['--expected-fee-tier', String(params.expectedFeeTier)]
      : []),
  ];
}

function summarizeNoSpendReport(reportPath, expectedBlock) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const sameFork =
    report.resolvedForkBlockNumber === expectedBlock.number &&
    report.resolvedForkBlockHash === expectedBlock.hash;
  return {
    sameFork,
    requestedForkBlock: report.requestedForkBlock,
    resolvedForkBlockNumber: report.resolvedForkBlockNumber,
    resolvedForkBlockHash: report.resolvedForkBlockHash,
    replayCommand: report.replayCommand,
    route: report.route,
    selectedFeeTier: report.route?.selectedFeeTier,
    receipt: report.receipt,
    transactionHash: report.receipt?.transactionHash,
    skipReasons: report.dryRun?.skip?.reasons ?? [],
    configArtifact: report.dryRun?.config,
    stateIntegrity: report.stateIntegrity,
    transport: report.transport,
    env: report.env,
    reportPath,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajna-no-spend-matrix-'));
  const outputPath =
    options.outputPath ?? path.join(tempDir, 'scenario-matrix-report.json');
  const forkRpc = resolveForkRpcUrl();
  const resolvedForkBlock = await resolveForkBlock({
    forkRpcUrl: forkRpc.forkRpcUrl,
    requested: options.baseForkBlock,
  });

  const forkScenarios = [
    {
      name: 'strict-hybrid',
      runConfigSmoke: true,
      expect: 'success',
      env: {
        AJNA_AGENT_NO_SPEND_UNISWAP_LIQUIDITY_MODE: 'strict_hybrid',
        AJNA_AGENT_NO_SPEND_UNISWAP_FEE_TIER_TEST_MODE: 'all_configured',
      },
    },
    {
      name: 'fallback-regression-disabled',
      expect: 'skip',
      dryRunOnly: true,
      hybridGasQuoteFallback: 'disabled',
      env: {
        AJNA_AGENT_NO_SPEND_UNISWAP_LIQUIDITY_MODE: 'fallback_regression',
      },
    },
    {
      name: 'fallback-regression-factory-first',
      expect: 'success',
      hybridGasQuoteFallback: 'factory_first',
      env: {
        AJNA_AGENT_NO_SPEND_UNISWAP_LIQUIDITY_MODE: 'fallback_regression',
      },
    },
    {
      name: 'fee-tier-default-only',
      expect: 'success',
      expectedFeeTier: 3000,
      env: {
        AJNA_AGENT_NO_SPEND_UNISWAP_LIQUIDITY_MODE: 'strict_hybrid',
        AJNA_AGENT_NO_SPEND_UNISWAP_FEE_TIER_TEST_MODE: 'default_only',
      },
    },
    {
      name: 'fee-tier-single-non-default',
      expect: 'success',
      expectedFeeTier: 500,
      env: {
        AJNA_AGENT_NO_SPEND_UNISWAP_LIQUIDITY_MODE: 'strict_hybrid',
        AJNA_AGENT_NO_SPEND_UNISWAP_FEE_TIER_TEST_MODE:
          'single_non_default',
        AJNA_AGENT_NO_SPEND_EXPECTED_FEE_TIER: '500',
      },
    },
    {
      name: 'policy-rejection-profit-floor',
      expect: 'skip',
      dryRunOnly: true,
      env: {
        AJNA_AGENT_NO_SPEND_UNISWAP_LIQUIDITY_MODE: 'strict_hybrid',
        AJNA_AGENT_HARNESS_MIN_EXPECTED_PROFIT_QUOTE: '999999999999',
      },
    },
    {
      name: 'manual-factory',
      mode: 'manual',
      expect: 'success',
      env: {
        AJNA_AGENT_NO_SPEND_UNISWAP_LIQUIDITY_MODE: 'strict_hybrid',
      },
    },
  ];

  const results = [];
  for (const scenario of forkScenarios) {
    const reportPath = path.join(tempDir, `${scenario.name}.json`);
    const logPath = path.join(tempDir, `${scenario.name}.log`);
    const command = buildNoSpendCommand({
      ...scenario,
      blockNumber: resolvedForkBlock.number,
      outputPath: reportPath,
    });
    process.stdout.write(`[matrix] running ${scenario.name}\n`);
    const run = await runCommand({
      command,
      env: {
        ...scenario.env,
        AJNA_AGENT_NO_SPEND_BASE_FORK_BLOCK: String(resolvedForkBlock.number),
      },
      logPath,
    });
    const result = {
      name: scenario.name,
      kind: 'fork',
      required: true,
      command,
      logPath,
      status: run.status,
      exitCode: run.exitCode,
      signal: run.signal,
      reportPath,
      ...(run.status === 'passed' && fs.existsSync(reportPath)
        ? summarizeNoSpendReport(reportPath, resolvedForkBlock)
        : { failureTail: run.tail, error: run.error }),
    };
    if (result.status === 'passed' && result.sameFork !== true) {
      result.status = 'failed';
      result.error = 'scenario report did not use the matrix resolved fork block';
    }
    results.push(result);
  }

  const cacheConcurrency = {
    name: 'cache-concurrency-route-probe',
    kind: 'unit',
    required: true,
    command: [
      'npx',
      'mocha',
      '--require',
      'ts-node/register',
      'tests/unit/discovery-handlers.test.ts',
      'tests/unit/discovery-targets.test.ts',
      'tests/unit/discovery-gas-policy.test.ts',
      'tests/unit/utils.test.ts',
      '--grep',
      'maxConcurrentCandidateEvaluations|maxExecutionsPerPoolPerRun|maxInFlightRouteProbes|RouteProbeLimiter|gas quote|hot take|hot auction|shared discovery scans|hybrid gas quote fallback',
    ],
  };
  process.stdout.write(`[matrix] running ${cacheConcurrency.name}\n`);
  const cacheLogPath = path.join(tempDir, `${cacheConcurrency.name}.log`);
  const cacheRun = await runCommand({
    command: cacheConcurrency.command,
    env: {},
    logPath: cacheLogPath,
  });
  results.push({
    ...cacheConcurrency,
    status: cacheRun.status,
    exitCode: cacheRun.exitCode,
    signal: cacheRun.signal,
    logPath: cacheLogPath,
    selectedRouteMetadata: 'unit-backed',
    transactionMetadata: 'not-applicable',
    cacheCounters: 'covered-by-focused-unit-slice',
    concurrencySettings: {
      maxConcurrentCandidateEvaluations: [1, 2],
      maxInFlightRouteProbes: [1, 2],
      maxExecutionsPerPoolPerRun: [1, 2],
    },
    ...(cacheRun.status === 'passed'
      ? {}
      : { failureTail: cacheRun.tail, error: cacheRun.error }),
  });

  const failed = results.filter((result) => result.status !== 'passed');
  const report = {
    status: failed.length === 0 ? 'passed' : 'failed',
    tempDir,
    requestedForkBlock: resolvedForkBlock.requested,
    resolvedForkBlockNumber: resolvedForkBlock.number,
    resolvedForkBlockHash: resolvedForkBlock.hash,
    forkRpc: redactUrlForReport(forkRpc.forkRpcUrl, forkRpc.source),
    results,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `[matrix] status=${report.status}\n[matrix] report=${outputPath}\n`
  );
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `[matrix] failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
