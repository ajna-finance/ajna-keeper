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
  return `Usage: node scripts/run-high-confidence-validation.mjs [--runtime-only] [--output /path/report.json]

Runs deterministic local Ajna keeper validation gates and records optional
external-provider-dependent fork checks as explicit skips when their env is
missing.
`;
}

function parseArgs(argv) {
  const options = {
    runtimeOnly: false,
    outputPath: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runtime-only') {
      options.runtimeOnly = true;
      continue;
    }
    if (arg === '--output') {
      options.outputPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runStep(step, tempDir, commonEnv) {
  const logPath = path.join(tempDir, `${step.name}.log`);
  return runLoggedCommand({
    command: step.command,
    env: {
      ...commonEnv,
      ...(step.env ?? {}),
    },
    logPath,
  }).then((result) => ({
    name: step.name,
    classification: step.classification,
    status: result.status,
    command: step.command,
    logPath,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
  }));
}

function missingHybridEnv() {
  const required = [
    'AJNA_AGENT_HYBRID_FORK_CONFIG',
    'AJNA_AGENT_HYBRID_LENDER_WHALE',
    'AJNA_AGENT_HYBRID_BORROWER_WHALE',
  ];
  return required.filter(
    (name) => !process.env[name] || process.env[name].trim().length === 0
  );
}

function missingLifiForkCanaryEnv() {
  const missing = [];
  if (
    !process.env.AJNA_AGENT_LIFI_FORK_CANARY_CONFIG &&
    !process.env.AJNA_AGENT_LIFI_CANARY_CONFIG
  ) {
    missing.push(
      'AJNA_AGENT_LIFI_FORK_CANARY_CONFIG or AJNA_AGENT_LIFI_CANARY_CONFIG'
    );
  }
  if (
    !process.env.AJNA_AGENT_LIFI_API_KEY &&
    !process.env.AJNA_AGENT_LIFI_FORK_CANARY_API_KEY &&
    !process.env.AJNA_AGENT_LIFI_CANARY_API_KEY &&
    !process.env.LIFI_API_KEY
  ) {
    missing.push(
      'AJNA_AGENT_LIFI_API_KEY, AJNA_AGENT_LIFI_FORK_CANARY_API_KEY, AJNA_AGENT_LIFI_CANARY_API_KEY, or LIFI_API_KEY'
    );
  }
  return missing;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajna-high-confidence-'));
  const outputPath =
    options.outputPath ?? path.join(tempDir, 'high-confidence-report.json');

  const forkRpc = resolveForkRpcUrl({ required: false });
  if (!forkRpc) {
    throw new Error(
      'Base RPC is required for high-confidence validation. Set BASE_RPC_URL, AJNA_RPC_URL_BASE, AJNA_AGENT_RPC_URL, AJNA_AGENT_NO_SPEND_FORK_RPC_URL, or ALCHEMY_API_KEY.'
    );
  }
  const resolvedForkBlock = await resolveForkBlock(forkRpc.forkRpcUrl);
  const commonEnv = {
    BASE_FORK_BLOCK: String(resolvedForkBlock.number),
    AJNA_AGENT_NO_SPEND_BASE_FORK_BLOCK: String(resolvedForkBlock.number),
  };

  const steps = [];
  if (!options.runtimeOnly) {
    steps.push(
      {
        name: 'git-diff-check',
        classification: 'required',
        command: ['git', 'diff', '--check', 'HEAD'],
      },
      {
        name: 'node-check-no-spend',
        classification: 'required',
        command: ['node', '--check', 'scripts/run-no-spend-validation.mjs'],
      },
      {
        name: 'node-check-egress-self-test',
        classification: 'required',
        command: ['node', '--check', 'scripts/no-egress-self-test.mjs'],
      },
      {
        name: 'node-check-scenario-matrix',
        classification: 'required',
        command: ['node', '--check', 'scripts/run-no-spend-scenario-matrix.mjs'],
      },
      {
        name: 'node-check-high-confidence',
        classification: 'required',
        command: ['node', '--check', 'scripts/run-high-confidence-validation.mjs'],
      },
      {
        name: 'tsc',
        classification: 'required',
        command: ['npx', 'tsc', '--noEmit', '--skipLibCheck'],
      },
      {
        name: 'unit-tests',
        classification: 'required',
        command: ['npm', 'run', 'unit-tests'],
      }
    );
  }

  steps.push(
    {
      name: 'egress-guard-self-test',
      classification: 'required',
      command: ['npm', 'run', 'no-spend-validation:egress-guard-self-test'],
    },
    {
      name: 'no-spend-validation',
      classification: 'required',
      command: [
        'npm',
        'run',
        'no-spend-validation',
        '--',
        '--base-fork-block',
        String(resolvedForkBlock.number),
      ],
    },
    {
      name: 'no-spend-scenario-matrix',
      classification: 'required',
      command: [
        'npm',
        'run',
        'no-spend-validation:matrix',
        '--',
        '--base-fork-block',
        String(resolvedForkBlock.number),
      ],
    },
    {
      name: 'no-spend-daemon-smoke',
      classification: 'required',
      command: [
        'npm',
        'run',
        'no-spend-validation:daemon-smoke',
        '--',
        '--base-fork-block',
        String(resolvedForkBlock.number),
      ],
    },
    {
      // The run-once daemon-smoke above exercises startKeeperRunOnceFromConfig
      // (one take/settlement cycle). This leg runs the PERSISTENT daemon via
      // startKeeperFromConfig: it starts all five supervised loops, loops
      // multiple cycles, takes a real auction, and asserts a clean SIGTERM
      // shutdown — the only gate that covers the long-running daemon path.
      name: 'no-spend-daemon-lifecycle',
      classification: 'required',
      command: [
        'npm',
        'run',
        'no-spend-validation:daemon-lifecycle',
        '--',
        '--base-fork-block',
        String(resolvedForkBlock.number),
      ],
    },
    {
      name: 'preflight-fork-reconciliation',
      classification: 'required',
      command: ['npm', 'run', 'preflight-fork-reconciliation'],
    }
  );

  const skipped = [];
  const lifiMissing = missingLifiForkCanaryEnv();
  if (lifiMissing.length > 0) {
    skipped.push({
      name: 'lifi-fork-execution-canary',
      classification: 'external-service-dependent',
      status: 'skipped',
      reason: `missing optional env: ${lifiMissing.join(', ')}`,
    });
  } else {
    steps.push({
      name: 'lifi-fork-execution-canary',
      classification: 'external-service-dependent',
      command: ['npm', 'run', 'lifi-fork-execution-canary'],
    });
  }

  const hybridMissing = missingHybridEnv();
  if (hybridMissing.length > 0) {
    skipped.push(
      {
        name: 'hybrid-lifi-fork-proof',
        classification: 'external-service-dependent',
        status: 'skipped',
        reason: `missing optional env: ${hybridMissing.join(', ')}`,
      },
      {
        name: 'hybrid-fork-loop',
        classification: 'external-service-dependent',
        status: 'skipped',
        reason: `missing optional env: ${hybridMissing.join(', ')}`,
      }
    );
  } else {
    steps.push(
      {
        name: 'hybrid-lifi-fork-proof',
        classification: 'external-service-dependent',
        command: ['npm', 'run', 'hybrid-lifi-fork-proof'],
      },
      {
        name: 'hybrid-fork-loop',
        classification: 'external-service-dependent',
        command: ['npm', 'run', 'hybrid-fork-loop'],
      }
    );
  }

  const results = [];
  for (const step of steps) {
    process.stdout.write(
      `[high-confidence] running ${step.name}: ${step.command.join(' ')}\n`
    );
    results.push(await runStep(step, tempDir, commonEnv));
  }
  results.push(...skipped);

  const failedRequired = results.filter(
    (result) =>
      result.classification === 'required' && result.status !== 'passed'
  );
  const failedExternal = results.filter(
    (result) =>
      result.classification === 'external-service-dependent' &&
      result.status === 'failed'
  );
  const report = {
    status:
      failedRequired.length === 0 && failedExternal.length === 0
        ? 'passed'
        : 'failed',
    runtimeOnly: options.runtimeOnly,
    tempDir,
    requestedForkBlock: resolvedForkBlock.requested,
    resolvedForkBlockNumber: resolvedForkBlock.number,
    resolvedForkBlockHash: resolvedForkBlock.hash,
    forkRpc: redactUrlForReport(forkRpc.forkRpcUrl, forkRpc.source),
    results,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    `[high-confidence] status=${report.status}\n` +
      `[high-confidence] report=${outputPath}\n`
  );
  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `[high-confidence] failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
