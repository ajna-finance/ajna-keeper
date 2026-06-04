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

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return { name, value };
    }
  }
  return undefined;
}

function resolveForkRpcUrl() {
  const configured = envValue(
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
  return forkRpcUrl ? { forkRpcUrl, source } : undefined;
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

async function resolveForkBlock(forkRpcUrl) {
  const block = await requestJsonRpc(forkRpcUrl, 'eth_getBlockByNumber', [
    'latest',
    false,
  ]);
  if (!block?.number || !block?.hash) {
    throw new Error('Failed to resolve latest Base fork block');
  }
  return {
    requested: 'latest',
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

function runStep(step, tempDir, commonEnv) {
  return new Promise((resolve) => {
    const logPath = path.join(tempDir, `${step.name}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const child = spawn(step.command[0], step.command.slice(1), {
      cwd: ROOT,
      env: {
        ...process.env,
        ...commonEnv,
        ...(step.env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));
    child.on('close', (code, signal) => {
      logStream.end(() => {
        resolve({
          name: step.name,
          classification: step.classification,
          status: code === 0 ? 'passed' : 'failed',
          command: step.command,
          logPath,
          exitCode: code,
          signal: signal ?? undefined,
        });
      });
    });
    child.on('error', (error) => {
      logStream.end(() => {
        resolve({
          name: step.name,
          classification: step.classification,
          status: 'failed',
          command: step.command,
          logPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  });
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

  const forkRpc = resolveForkRpcUrl();
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
