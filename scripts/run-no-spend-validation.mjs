#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const HARDHAT_DEFAULT_KEEPER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TS_NODE_BIN = path.join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js');
const HARDHAT_BIN = path.join(
  ROOT,
  'node_modules',
  'hardhat',
  'internal',
  'cli',
  'bootstrap.js'
);
const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_BASE_FORK_BLOCK = 'latest';

const LOCALHOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

let hardhatNode;

function usage() {
  return `Usage: node scripts/run-no-spend-validation.mjs [--port N] [--base-fork-block N|latest]

Runs a no-spend Base fork replay:
1. starts a local Base fork
2. creates and kicks a mock-token Ajna fixture with Uniswap V3 external take
3. runs keeper discovery/take dry-run through the real discovered-take path
4. reverts the dry-run snapshot
5. runs keeper discovery/take execution against the local fork

Required env:
- BASE_RPC_URL, AJNA_RPC_URL_BASE, AJNA_AGENT_RPC_URL, or ALCHEMY_API_KEY

Optional env:
- AJNA_AGENT_NO_SPEND_FORK_RPC_URL
- AJNA_AGENT_NO_SPEND_BASE_FORK_BLOCK
- AJNA_AGENT_NO_SPEND_PORT
- AJNA_AGENT_TOKEN_DEPLOYER_REPO
- AJNA_AGENT_AJNA_SKILLS_REPO
`;
}

function parseArgs(argv) {
  const options = {
    port: process.env.AJNA_AGENT_NO_SPEND_PORT
      ? Number(process.env.AJNA_AGENT_NO_SPEND_PORT)
      : undefined,
    baseForkBlock:
      process.env.AJNA_AGENT_NO_SPEND_BASE_FORK_BLOCK ??
      process.env.BASE_FORK_BLOCK ??
      DEFAULT_BASE_FORK_BLOCK,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--port') {
      options.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--base-fork-block') {
      options.baseForkBlock = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port <= 0 ||
      options.port > 65535)
  ) {
    throw new Error('--port must be an integer between 1 and 65535');
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

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function isLocalhostUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return LOCALHOST_NAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

function assertLocalRpcUrl(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL: ${rawUrl}`);
  }
  if (!LOCALHOST_NAMES.has(parsed.hostname)) {
    throw new Error(`${label} must point to localhost, got ${rawUrl}`);
  }
}

function resolveForkRpcUrl() {
  const configured = envValue(
    'AJNA_AGENT_NO_SPEND_FORK_RPC_URL',
    'BASE_RPC_URL',
    'AJNA_RPC_URL_BASE',
    'AJNA_AGENT_RPC_URL'
  );
  const forkRpcUrl =
    configured ??
    (process.env.ALCHEMY_API_KEY
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : undefined);

  if (!forkRpcUrl) {
    throw new Error(
      'Missing Base fork RPC. Set BASE_RPC_URL, AJNA_RPC_URL_BASE, AJNA_AGENT_RPC_URL, AJNA_AGENT_NO_SPEND_FORK_RPC_URL, or ALCHEMY_API_KEY.'
    );
  }
  if (isLocalhostUrl(forkRpcUrl)) {
    throw new Error(
      `Refusing to use localhost as the Base fork source RPC: ${forkRpcUrl}`
    );
  }
  return forkRpcUrl;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
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
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 1_000,
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

function readTail(filePath, maxBytes = 6_000) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  const buffer = fs.readFileSync(filePath);
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString();
}

function startHardhatNode(params) {
  const logStream = fs.createWriteStream(params.logPath, { flags: 'a' });
  const nodeEnv = {
    ...process.env,
    FORK_NETWORK: 'base',
    HARDHAT_CHAIN_ID: '8453',
    BASE_FORK_BLOCK: params.baseForkBlock,
    AJNA_AGENT_RPC_URL: params.forkRpcUrl,
    AJNA_RPC_URL_BASE: params.forkRpcUrl,
    BASE_RPC_URL: params.forkRpcUrl,
  };

  const child = spawn(
    process.execPath,
    [
      HARDHAT_BIN,
      'node',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(params.port),
    ],
    {
      cwd: ROOT,
      env: nodeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.on('data', (chunk) => logStream.write(chunk));
  child.stderr.on('data', (chunk) => logStream.write(chunk));
  child.on('close', () => logStream.end());
  hardhatNode = child;
  return child;
}

async function waitForRpcReady(params) {
  const deadline = Date.now() + DEFAULT_RPC_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (params.child.exitCode !== null) {
      throw new Error(
        `Hardhat node exited early with code ${params.child.exitCode}.\n${readTail(
          params.logPath
        )}`
      );
    }
    try {
      const chainId = await requestJsonRpc(params.rpcUrl, 'eth_chainId');
      if (chainId !== '0x2105') {
        throw new Error(`expected chainId 0x2105, got ${chainId}`);
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw new Error(
    `Timed out waiting for local Base fork RPC. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }\n${readTail(params.logPath)}`
  );
}

function runNodeScript(label, scriptPath, args, env, logPath) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`[no-spend] ${label}\n`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const child = spawn(process.execPath, [TS_NODE_BIN, scriptPath, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      logStream.end(() => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `${label} failed${
              signal ? ` with signal ${signal}` : ` with exit code ${code}`
            }\n${readTail(logPath)}`
          )
        );
      });
    });
  });
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to read ${label} at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function sumDiscoveryStats(report, field) {
  if (!Array.isArray(report.discoveryStats)) {
    return 0;
  }
  return report.discoveryStats.reduce(
    (sum, stats) => sum + Number(stats?.[field] ?? 0),
    0
  );
}

function sumPathCounter(report, pathName, field) {
  if (!Array.isArray(report.discoveryStats)) {
    return 0;
  }
  return report.discoveryStats.reduce((sum, stats) => {
    return sum + Number(stats?.externalTakeByPath?.[pathName]?.[field] ?? 0);
  }, 0);
}

function assertDryRunReport(report) {
  if (report.mode !== 'discovery') {
    throw new Error(`Dry-run harness mode was ${report.mode}, expected discovery`);
  }
  const dryRunExternalTakes = sumDiscoveryStats(report, 'dryRunExternalTakes');
  const dryRunFactoryPathTakes = sumPathCounter(report, 'factory', 'dryRun');
  if (dryRunExternalTakes < 1 || dryRunFactoryPathTakes < 1) {
    throw new Error(
      `Dry-run did not reach the discovered external-take path. dryRunExternalTakes=${dryRunExternalTakes} factoryDryRuns=${dryRunFactoryPathTakes}`
    );
  }
}

function assertExecutionReport(report) {
  if (report.mode !== 'discovery') {
    throw new Error(
      `Execution harness mode was ${report.mode}, expected discovery`
    );
  }
  if (report.takeExecuted !== true || report.collateralReducedByTake !== true) {
    throw new Error(
      `Execution did not reduce auction collateral. takeExecuted=${report.takeExecuted} collateralReducedByTake=${report.collateralReducedByTake}`
    );
  }
  const executedExternalTakes = sumDiscoveryStats(
    report,
    'executedExternalTakes'
  );
  const executedFactoryPathTakes = sumPathCounter(report, 'factory', 'executed');
  if (executedExternalTakes < 1 || executedFactoryPathTakes < 1) {
    throw new Error(
      `Execution did not record a factory external take. executedExternalTakes=${executedExternalTakes} factoryExecutions=${executedFactoryPathTakes}`
    );
  }
}

function fixtureEnv(params) {
  const env = {
    ...process.env,
    AJNA_AGENT_RPC_URL: params.rpcUrl,
    AJNA_RPC_URL_BASE: params.rpcUrl,
    AJNA_AGENT_KEEPER_KEY: HARDHAT_DEFAULT_KEEPER_KEY,
    AJNA_AGENT_KEY_FILE: params.keyFilePath,
    AJNA_AGENT_OUTPUT_PATH: params.summaryPath,
    AJNA_AGENT_ALLOW_EVM_TIME_TRAVEL: 'yes',
    AJNA_AGENT_FINAL_KICK: 'yes',
    AJNA_AGENT_ENABLE_UNISWAP_V3_EXTERNAL_TAKE: '1',
    AJNA_AGENT_PROFILE: 'realistic-1d',
    AJNA_AGENT_FUND_NATIVE_GAS: 'yes',
    AJNA_AGENT_CREATE_POOL: 'yes',
    AJNA_AGENT_DEPLOY_TOKENS: 'yes',
    AJNA_AGENT_TRANSFER_TOKENS: 'yes',
    AJNA_AGENT_SEED_UNISWAP: 'yes',
    AJNA_AGENT_DEPLOY_EXTERNAL_TAKE: 'yes',
    AJNA_AGENT_UNISWAP_LIQUIDITY_MODE:
      process.env.AJNA_AGENT_NO_SPEND_UNISWAP_LIQUIDITY_MODE ??
      'strict_hybrid',
    AJNA_AGENT_UNISWAP_FEE_TIER_TEST_MODE:
      process.env.AJNA_AGENT_NO_SPEND_UNISWAP_FEE_TIER_TEST_MODE ??
      'all_configured',
    AJNA_AGENT_UNISWAP_WETH_LIQUIDITY_RAW:
      process.env.AJNA_AGENT_NO_SPEND_UNISWAP_WETH_LIQUIDITY_RAW ??
      '1000000000000000000',
    AJNA_AGENT_UNISWAP_WETH_QUOTE_LIQUIDITY_RAW:
      process.env.AJNA_AGENT_NO_SPEND_UNISWAP_WETH_QUOTE_LIQUIDITY_RAW ??
      '3000000000000000000000',
  };

  for (const name of [
    'AJNA_AGENT_LENDER_KEY',
    'AJNA_AGENT_BORROWER_KEY',
    'AJNA_AGENT_QUOTE_TOKEN_ADDRESS',
    'AJNA_AGENT_COLLATERAL_TOKEN_ADDRESS',
    'AJNA_AGENT_POOL_ADDRESS',
    'AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS',
    'AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS',
  ]) {
    delete env[name];
  }

  return env;
}

function harnessEnv(params) {
  return {
    ...process.env,
    AJNA_AGENT_RPC_URL: params.rpcUrl,
    AJNA_RPC_URL_BASE: params.rpcUrl,
    AJNA_AGENT_KEEPER_KEY: HARDHAT_DEFAULT_KEEPER_KEY,
    AJNA_AGENT_HARNESS_OUTPUT_PATH: params.outputPath,
  };
}

async function stopHardhatNode() {
  const child = hardhatNode;
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const forkRpcUrl = resolveForkRpcUrl();
  const port = options.port ?? (await getFreePort());
  const rpcUrl = `http://127.0.0.1:${port}`;
  assertLocalRpcUrl(rpcUrl, 'local fixture RPC');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajna-no-spend-'));
  const nodeLogPath = path.join(tempDir, 'hardhat-node.log');
  const fixtureLogPath = path.join(tempDir, 'fixture.log');
  const dryRunLogPath = path.join(tempDir, 'dry-run-harness.log');
  const executionLogPath = path.join(tempDir, 'execution-harness.log');
  const summaryPath = path.join(tempDir, 'fixture-summary.json');
  const dryRunReportPath = path.join(tempDir, 'dry-run-report.json');
  const executionReportPath = path.join(tempDir, 'execution-report.json');
  const keyFilePath = path.join(tempDir, 'fixture-keys.json');

  process.stdout.write(
    `[no-spend] tempDir=${tempDir}\n` +
      `[no-spend] localRpc=${rpcUrl}\n` +
      `[no-spend] baseForkBlock=${options.baseForkBlock}\n`
  );

  const node = startHardhatNode({
    port,
    forkRpcUrl,
    baseForkBlock: options.baseForkBlock,
    logPath: nodeLogPath,
  });

  try {
    await waitForRpcReady({ rpcUrl, child: node, logPath: nodeLogPath });

    await runNodeScript(
      'creating local liquidatable Uniswap fixture',
      path.join(ROOT, 'scripts', 'create-liquidatable-ajna-fixture.ts'),
      [
        '--with-uniswap-v3-external-take',
        '--allow-evm-time-travel',
        '--final-kick',
      ],
      fixtureEnv({ rpcUrl, keyFilePath, summaryPath }),
      fixtureLogPath
    );

    const snapshotId = await requestJsonRpc(rpcUrl, 'evm_snapshot');
    try {
      await runNodeScript(
        'running discovered-take dry-run harness',
        path.join(ROOT, 'scripts', 'run-fixture-keeper-harness.ts'),
        [
          '--summary',
          summaryPath,
          '--mode',
          'discovery',
          '--hybrid-gas-quote-fallback',
          'factory_first',
          '--dry-run',
          '--auto-warp-to-take',
        ],
        harnessEnv({ rpcUrl, outputPath: dryRunReportPath }),
        dryRunLogPath
      );
      assertDryRunReport(readJson(dryRunReportPath, 'dry-run report'));
    } finally {
      await requestJsonRpc(rpcUrl, 'evm_revert', [snapshotId]);
    }

    await runNodeScript(
      'running discovered-take execution harness on local fork',
      path.join(ROOT, 'scripts', 'run-fixture-keeper-harness.ts'),
      [
        '--summary',
        summaryPath,
        '--mode',
        'discovery',
        '--hybrid-gas-quote-fallback',
        'factory_first',
        '--auto-warp-to-take',
      ],
      harnessEnv({ rpcUrl, outputPath: executionReportPath }),
      executionLogPath
    );
    assertExecutionReport(readJson(executionReportPath, 'execution report'));

    process.stdout.write(
      `[no-spend] validation passed\n` +
        `[no-spend] fixtureSummary=${summaryPath}\n` +
        `[no-spend] dryRunReport=${dryRunReportPath}\n` +
        `[no-spend] executionReport=${executionReportPath}\n` +
        `[no-spend] fixtureLog=${fixtureLogPath}\n` +
        `[no-spend] dryRunLog=${dryRunLogPath}\n` +
        `[no-spend] executionLog=${executionLogPath}\n` +
        `[no-spend] hardhatLog=${nodeLogPath}\n`
    );
  } finally {
    await stopHardhatNode();
  }
}

process.once('SIGINT', async () => {
  await stopHardhatNode();
  process.exit(130);
});
process.once('SIGTERM', async () => {
  await stopHardhatNode();
  process.exit(143);
});

main().catch(async (error) => {
  await stopHardhatNode();
  process.stderr.write(
    `[no-spend] validation failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
