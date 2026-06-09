#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import {
  redactUrlForReport,
  resolveForkBlock,
  resolveForkRpcUrl,
  runLoggedCommand,
} from './no-spend/runtime.mjs';

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

function runCommand(params) {
  return runLoggedCommand(params);
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
