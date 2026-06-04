#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Wallet } from 'ethers';

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
const NO_EGRESS_GUARD_PATH = path.join(ROOT, 'scripts', 'no-egress-guard.cjs');
const BASE_ONEINCH_ROUTER = '0x1111111254EEB25477B68fb85Ed929f73A960582';
const BASE_AJNA_CONFIG = {
  erc20PoolFactory: '0x214f62B5836D83f3D6c4f71F174209097B1A779C',
  erc721PoolFactory: '0xeefEC5d1Cc4bde97279d01D88eFf9e0fEe981769',
  poolUtils: '0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa',
  positionManager: '0x59710a4149A27585f1841b5783ac704a08274e64',
  ajnaToken: '0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47',
  grantFund: '',
  burnWrapper: '',
  lenderHelper: '',
};

const LOCALHOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

let hardhatNode;

function usage() {
  return `Usage: node scripts/run-no-spend-validation.mjs [--port N] [--base-fork-block N|latest] [--scenario NAME] [--mode discovery|manual] [--expect success|skip] [--dry-run-only] [--hybrid-gas-quote-fallback disabled|factory_first] [--run-config-smoke] [--run-daemon-smoke] [--daemon-smoke-only] [--expected-fee-tier N] [--output /path/report.json]

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
    scenarioName: process.env.AJNA_AGENT_NO_SPEND_SCENARIO ?? 'strict-hybrid',
    harnessMode: process.env.AJNA_AGENT_NO_SPEND_HARNESS_MODE ?? 'discovery',
    expectedResult: process.env.AJNA_AGENT_NO_SPEND_EXPECT ?? 'success',
    dryRunOnly: process.env.AJNA_AGENT_NO_SPEND_DRY_RUN_ONLY === '1',
    hybridGasQuoteFallback:
      process.env.AJNA_AGENT_NO_SPEND_HYBRID_GAS_QUOTE_FALLBACK ??
      'factory_first',
    runConfigSmoke: process.env.AJNA_AGENT_NO_SPEND_CONFIG_SMOKE === '1',
    runDaemonSmoke: process.env.AJNA_AGENT_NO_SPEND_DAEMON_SMOKE === '1',
    daemonSmokeOnly:
      process.env.AJNA_AGENT_NO_SPEND_DAEMON_SMOKE_ONLY === '1',
    expectedFeeTier: process.env.AJNA_AGENT_NO_SPEND_EXPECTED_FEE_TIER
      ? Number(process.env.AJNA_AGENT_NO_SPEND_EXPECTED_FEE_TIER)
      : undefined,
    outputPath: process.env.AJNA_AGENT_NO_SPEND_OUTPUT_PATH,
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
    if (arg === '--scenario') {
      options.scenarioName = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--mode') {
      options.harnessMode = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--expect') {
      options.expectedResult = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--dry-run-only') {
      options.dryRunOnly = true;
      continue;
    }
    if (arg === '--hybrid-gas-quote-fallback') {
      options.hybridGasQuoteFallback = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--run-config-smoke') {
      options.runConfigSmoke = true;
      continue;
    }
    if (arg === '--run-daemon-smoke') {
      options.runDaemonSmoke = true;
      continue;
    }
    if (arg === '--daemon-smoke-only') {
      options.runDaemonSmoke = true;
      options.daemonSmokeOnly = true;
      continue;
    }
    if (arg === '--expected-fee-tier') {
      options.expectedFeeTier = Number(argv[i + 1]);
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
  if (options.harnessMode !== 'discovery' && options.harnessMode !== 'manual') {
    throw new Error('--mode must be discovery or manual');
  }
  if (options.expectedResult !== 'success' && options.expectedResult !== 'skip') {
    throw new Error('--expect must be success or skip');
  }
  if (
    options.hybridGasQuoteFallback !== 'disabled' &&
    options.hybridGasQuoteFallback !== 'factory_first'
  ) {
    throw new Error(
      '--hybrid-gas-quote-fallback must be disabled or factory_first'
    );
  }
  if (
    options.expectedFeeTier !== undefined &&
    (!Number.isInteger(options.expectedFeeTier) || options.expectedFeeTier <= 0)
  ) {
    throw new Error('--expected-fee-tier must be a positive integer');
  }

  return options;
}

function envValue(...names) {
  return envValueWithSource(...names)?.value;
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
  const source = configured?.name ?? (process.env.ALCHEMY_API_KEY ? 'ALCHEMY_API_KEY' : undefined);

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
  return { forkRpcUrl, source };
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

function requestJsonRpc(rpcUrl, method, params = [], timeoutMs = 1_000) {
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
        timeout: timeoutMs,
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

function redactUrlForReport(rawUrl, source) {
  try {
    const parsed = new URL(rawUrl);
    return {
      source,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      credentialRedacted: Boolean(parsed.username || parsed.password),
    };
  } catch {
    return {
      source,
      protocol: 'unknown',
      hostname: 'unparseable',
      credentialRedacted: true,
    };
  }
}

async function resolveForkBlock(params) {
  const requested = params.requestedForkBlock;
  const tag =
    requested === 'latest' ? 'latest' : `0x${Number(requested).toString(16)}`;
  const block = await requestJsonRpc(
    params.forkRpcUrl,
    'eth_getBlockByNumber',
    [tag, false],
    15_000
  );
  if (!block?.number || !block?.hash) {
    throw new Error(`Failed to resolve Base fork block for ${requested}`);
  }
  return {
    requested,
    number: Number.parseInt(block.number, 16),
    hash: block.hash,
  };
}

function getAllowedHostList(...urls) {
  const hosts = new Set(Array.from(LOCALHOST_NAMES));
  for (const rawUrl of urls) {
    if (!rawUrl) continue;
    try {
      hosts.add(new URL(rawUrl).hostname.toLowerCase());
    } catch {
      // URL validity is checked elsewhere; ignore here so reporting helpers stay side-effect free.
    }
  }
  return Array.from(hosts).sort().join(',');
}

function baseChildEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? os.homedir(),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    NODE_ENV: 'test',
    ...extra,
  };
}

function withNoEgressGuard(env, params) {
  const nodeOptions = [
    env.NODE_OPTIONS,
    `--require=${NO_EGRESS_GUARD_PATH}`,
  ].filter(Boolean);
  return {
    ...env,
    NODE_OPTIONS: nodeOptions.join(' '),
    AJNA_NO_EGRESS_GUARD_ENABLED: '1',
    AJNA_NO_EGRESS_ALLOWED_HOSTS: params.allowedHosts,
    AJNA_NO_EGRESS_REPORT_PATH: params.reportPath,
  };
}

function buildReplayCommand(params) {
  return [
    'npm',
    'run',
    'no-spend-validation',
    '--',
    '--base-fork-block',
    String(params.resolvedForkBlockNumber),
  ];
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
  const nodeEnv = withNoEgressGuard(baseChildEnv({
    FORK_NETWORK: 'base',
    HARDHAT_CHAIN_ID: '8453',
    BASE_FORK_BLOCK: String(params.resolvedForkBlockNumber),
    AJNA_AGENT_RPC_URL: params.forkRpcUrl,
    AJNA_RPC_URL_BASE: params.forkRpcUrl,
    BASE_RPC_URL: params.forkRpcUrl,
  }), {
    allowedHosts: params.allowedHosts,
    reportPath: params.egressReportPath,
  });

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

function runCommandWithTimeout(label, command, env, logPath, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    process.stdout.write(`[no-spend] ${label}\n`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 5_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      logStream.end(() => {
        resolve({
          status: code === 0 && !timedOut ? 'passed' : 'failed',
          exitCode: code,
          signal: signal ?? undefined,
          timedOut,
          logPath,
          tail: code === 0 && !timedOut ? undefined : readTail(logPath),
        });
      });
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      logStream.end(() => {
        resolve({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          logPath,
        });
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

function getFixtureAuction(summary) {
  return {
    id: `${summary.pool.address.toLowerCase()}-${summary.borrower.owner.toLowerCase()}`,
    borrower: summary.borrower.owner,
    kickTime: String(summary.finalKick?.auction?.kickTime ?? '0'),
    debtRemaining:
      summary.finalKick?.auction?.debtToCover ??
      summary.borrower.debt ??
      '0',
    collateralRemaining: summary.borrower.collateral ?? '0',
    neutralPrice:
      summary.finalKick?.auction?.neutralPrice ??
      summary.borrower.neutralPrice,
    debt: summary.borrower.debt ?? '0',
    collateral: summary.borrower.collateral ?? '0',
    pool: {
      id: summary.pool.address.toLowerCase(),
    },
  };
}

async function startFixtureSubgraphStub(params) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405);
        response.end('method not allowed');
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', async () => {
        const parsed = body ? JSON.parse(body) : {};
        const query = String(parsed.query ?? '');
        const variables = parsed.variables ?? {};
        const latestBlock = await requestJsonRpc(params.rpcUrl, 'eth_getBlockByNumber', [
          'latest',
          false,
        ]);
        const auction = getFixtureAuction(params.summary);
        let data;
        if (query.includes('_meta')) {
          data = {
            _meta: {
              block: {
                number: Number.parseInt(latestBlock.number, 16),
                timestamp: Number.parseInt(latestBlock.timestamp, 16),
              },
              deployment: 'fixture-local',
              hasIndexingErrors: false,
            },
          };
        } else if (query.includes('bucketTakes')) {
          data = { bucketTakes: [] };
        } else if (query.includes('loans')) {
          data = { loans: [] };
        } else if (query.includes('pool(')) {
          data = {
            pool: {
              hpb: 0,
              hpbIndex: 0,
              liquidationAuctions:
                variables.afterBorrower && variables.afterBorrower.length > 0
                  ? []
                  : [{ borrower: auction.borrower }],
            },
          };
        } else if (query.includes('liquidationAuctions')) {
          const after =
            variables.afterId ?? variables.afterBorrower ?? '';
          data = {
            liquidationAuctions:
              typeof after === 'string' && after.length > 0 ? [] : [auction],
          };
        } else {
          data = {};
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data }));
      });
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          errors: [
            {
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        })
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start fixture subgraph stub');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function buildDaemonConfig(params) {
  const uniswap = params.summary.uniswapV3ExternalTake;
  if (!uniswap) {
    throw new Error('Fixture summary missing uniswapV3ExternalTake');
  }
  return {
    network: {
      rpcUrl: params.rpcUrl,
      readRpcUrls: [params.rpcUrl],
      subgraph: {
        url: params.subgraphUrl,
        fallbackUrls: [`${params.subgraphUrl}/fallback`],
      },
      tokenAddresses: {
        weth: uniswap.routerConfig.wethAddress,
      },
    },
    signer: {
      keystore: params.keystorePath,
    },
    runtime: {
      logLevel: 'debug',
      delayBetweenRuns: 1,
      dryRun: params.dryRun,
    },
    ajna: BASE_AJNA_CONFIG,
    manual: {
      pools: [],
    },
    discovery: {
      enabled: true,
      dryRunNewPools: false,
      hydrateCooldownSec: 30,
      logSkips: true,
      allowPools: [params.summary.pool.address],
      denyPools: [],
      defaults: {
        take: {
          minCollateral: 0.01,
          liquiditySource: 2,
          marketPriceFactor: 0.98,
        },
      },
      take: {
        enabled: true,
        allowedExternalTakePaths: ['factory'],
        defaultFactoryLiquiditySource: 2,
        allowedLiquiditySources: [2],
        externalTakeRouteSelectionMode: 'maximize_profit',
        hybridGasQuoteFailureFallbackMode: 'disabled',
        maxGasCostNative: 1,
        validateRouteDeployments: true,
      },
    },
    dex: {
      oneInch: {
        routers: {
          8453: BASE_ONEINCH_ROUTER,
        },
      },
      uniswapV3: {
        router: uniswap.routerConfig,
      },
    },
    takers: {
      factory: uniswap.deployment.keeperTakerFactory,
      contracts: {
        UniswapV3: uniswap.deployment.uniswapV3Taker,
      },
    },
  };
}

function daemonChildEnv(params) {
  return withNoEgressGuard(
    baseChildEnv({
      ...(params.passwordFile
        ? { KEYSTORE_PASSWORD_FILE: params.passwordFile }
        : {}),
    }),
    {
      allowedHosts: params.allowedHosts,
      reportPath: params.egressReportPath,
    }
  );
}

async function readBlockNumber(rpcUrl) {
  const hex = await requestJsonRpc(rpcUrl, 'eth_blockNumber');
  return Number.parseInt(hex, 16);
}

async function warpLocalTakeWindow(rpcUrl) {
  await requestJsonRpc(rpcUrl, 'evm_increaseTime', [86_400]);
  await requestJsonRpc(rpcUrl, 'evm_mine', []);
}

async function countTransactionsFrom(params) {
  let count = 0;
  const hashes = [];
  const normalizedFrom = params.from.toLowerCase();
  for (
    let blockNumber = params.fromBlockExclusive + 1;
    blockNumber <= params.toBlockInclusive;
    blockNumber += 1
  ) {
    const block = await requestJsonRpc(params.rpcUrl, 'eth_getBlockByNumber', [
      `0x${blockNumber.toString(16)}`,
      true,
    ]);
    for (const tx of block?.transactions ?? []) {
      if (String(tx.from).toLowerCase() === normalizedFrom) {
        count += 1;
        hashes.push(tx.hash);
      }
    }
  }
  return { count, hashes };
}

function collateralRaw(stateReport) {
  const raw = stateReport.stateArtifact?.auctionBeforeTake?.collateral;
  return raw === undefined || raw === null ? 0n : BigInt(raw);
}

async function runStateOnlyHarness(params) {
  await runNodeScript(
    params.label,
    path.join(ROOT, 'scripts', 'run-fixture-keeper-harness.ts'),
    ['--summary', params.summaryPath, '--mode', 'discovery', '--state-only'],
    harnessEnv({
      rpcUrl: params.rpcUrl,
      outputPath: params.outputPath,
      allowedHosts: params.allowedHosts,
      egressReportPath: params.egressReportPath,
      configSmoke: false,
    }),
    params.logPath
  );
  return readJson(params.outputPath, params.label);
}

async function runDaemonSmoke(params) {
  const subgraph = await startFixtureSubgraphStub({
    summary: params.summary,
    rpcUrl: params.rpcUrl,
  });
  const password = `ajna-local-${Date.now()}`;
  const passwordPath = path.join(params.tempDir, 'daemon-keystore-password.txt');
  const wrongPasswordPath = path.join(
    params.tempDir,
    'daemon-keystore-password-wrong.txt'
  );
  const missingPasswordPath = path.join(
    params.tempDir,
    'daemon-keystore-password-missing.txt'
  );
  const keystorePath = path.join(params.tempDir, 'daemon-keeper-keystore.json');
  const wallet = new Wallet(HARDHAT_DEFAULT_KEEPER_KEY);
  fs.writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
  fs.writeFileSync(wrongPasswordPath, 'wrong-password\n', { mode: 0o600 });
  fs.writeFileSync(keystorePath, await wallet.encrypt(password), {
    mode: 0o600,
  });

  const dryRunConfigPath = path.join(params.tempDir, 'daemon-dry-run-config.json');
  const executionConfigPath = path.join(
    params.tempDir,
    'daemon-execution-config.json'
  );
  fs.writeFileSync(
    dryRunConfigPath,
    `${JSON.stringify(
      buildDaemonConfig({
        ...params,
        subgraphUrl: subgraph.url,
        keystorePath,
        dryRun: true,
      }),
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    executionConfigPath,
    `${JSON.stringify(
      buildDaemonConfig({
        ...params,
        subgraphUrl: subgraph.url,
        keystorePath,
        dryRun: false,
      }),
      null,
      2
    )}\n`
  );

  const command = (configPath) => [
    'npm',
    'start',
    '--',
    '--config',
    configPath,
    '--run-once',
  ];

  try {
    const missingPassword = await runCommandWithTimeout(
      'daemon missing password-file negative smoke',
      command(dryRunConfigPath),
      daemonChildEnv({
        allowedHosts: params.allowedHosts,
        egressReportPath: params.egressReportPath,
        passwordFile: missingPasswordPath,
      }),
      path.join(params.tempDir, 'daemon-missing-password.log'),
      60_000
    );
    const wrongPassword = await runCommandWithTimeout(
      'daemon wrong password negative smoke',
      command(dryRunConfigPath),
      daemonChildEnv({
        allowedHosts: params.allowedHosts,
        egressReportPath: params.egressReportPath,
        passwordFile: wrongPasswordPath,
      }),
      path.join(params.tempDir, 'daemon-wrong-password.log'),
      60_000
    );

    const dryRunSnapshot = await requestJsonRpc(params.rpcUrl, 'evm_snapshot');
    await warpLocalTakeWindow(params.rpcUrl);
    const dryRunFromBlock = await readBlockNumber(params.rpcUrl);
    const dryRun = await runCommandWithTimeout(
      'daemon run-once dry-run smoke',
      command(dryRunConfigPath),
      daemonChildEnv({
        allowedHosts: params.allowedHosts,
        egressReportPath: params.egressReportPath,
        passwordFile: passwordPath,
      }),
      path.join(params.tempDir, 'daemon-dry-run.log')
    );
    const dryRunToBlock = await readBlockNumber(params.rpcUrl);
    const dryRunTxs = await countTransactionsFrom({
      rpcUrl: params.rpcUrl,
      fromBlockExclusive: dryRunFromBlock,
      toBlockInclusive: dryRunToBlock,
      from: wallet.address,
    });
    await requestJsonRpc(params.rpcUrl, 'evm_revert', [dryRunSnapshot]);

    const executionSnapshot = await requestJsonRpc(params.rpcUrl, 'evm_snapshot');
    await warpLocalTakeWindow(params.rpcUrl);
    const beforeStatePath = path.join(params.tempDir, 'daemon-before-state.json');
    const afterStatePath = path.join(params.tempDir, 'daemon-after-state.json');
    const beforeState = await runStateOnlyHarness({
      label: 'daemon pre-execution state read',
      summaryPath: params.summaryPath,
      rpcUrl: params.rpcUrl,
      outputPath: beforeStatePath,
      allowedHosts: params.allowedHosts,
      egressReportPath: params.egressReportPath,
      logPath: path.join(params.tempDir, 'daemon-before-state.log'),
    });
    const executionFromBlock = await readBlockNumber(params.rpcUrl);
    const execution = await runCommandWithTimeout(
      'daemon run-once execution smoke',
      command(executionConfigPath),
      daemonChildEnv({
        allowedHosts: params.allowedHosts,
        egressReportPath: params.egressReportPath,
        passwordFile: passwordPath,
      }),
      path.join(params.tempDir, 'daemon-execution.log')
    );
    const executionToBlock = await readBlockNumber(params.rpcUrl);
    const executionTxs = await countTransactionsFrom({
      rpcUrl: params.rpcUrl,
      fromBlockExclusive: executionFromBlock,
      toBlockInclusive: executionToBlock,
      from: wallet.address,
    });
    const afterState = await runStateOnlyHarness({
      label: 'daemon post-execution state read',
      summaryPath: params.summaryPath,
      rpcUrl: params.rpcUrl,
      outputPath: afterStatePath,
      allowedHosts: params.allowedHosts,
      egressReportPath: params.egressReportPath,
      logPath: path.join(params.tempDir, 'daemon-after-state.log'),
    });
    await requestJsonRpc(params.rpcUrl, 'evm_revert', [executionSnapshot]);

    const beforeCollateral = collateralRaw(beforeState);
    const afterCollateral = collateralRaw(afterState);
    const artifact = {
      enabled: true,
      subgraphUrl: subgraph.url,
      configPaths: {
        dryRun: dryRunConfigPath,
        execution: executionConfigPath,
      },
      keystorePath,
      passwordSource: 'KEYSTORE_PASSWORD_FILE',
      keeperKeyEnvPresent: false,
      missingPasswordRejected: missingPassword.status === 'failed',
      wrongPasswordRejected: wrongPassword.status === 'failed',
      dryRunPassed: dryRun.status === 'passed',
      dryRunTransactionsFromKeeper: dryRunTxs.count,
      dryRunSubmittedNoTransactions: dryRunTxs.count === 0,
      executionPassed: execution.status === 'passed',
      executionTransactionsFromKeeper: executionTxs.count,
      executionTransactionHashes: executionTxs.hashes,
      localExecutionCollateralReduced: afterCollateral < beforeCollateral,
      beforeCollateral: beforeCollateral.toString(),
      afterCollateral: afterCollateral.toString(),
      logs: {
        missingPassword: missingPassword.logPath,
        wrongPassword: wrongPassword.logPath,
        dryRun: dryRun.logPath,
        execution: execution.logPath,
      },
      stateReports: {
        before: beforeStatePath,
        after: afterStatePath,
      },
    };
    for (const [field, value] of Object.entries({
      missingPasswordRejected: artifact.missingPasswordRejected,
      wrongPasswordRejected: artifact.wrongPasswordRejected,
      dryRunPassed: artifact.dryRunPassed,
      dryRunSubmittedNoTransactions: artifact.dryRunSubmittedNoTransactions,
      executionPassed: artifact.executionPassed,
      executionSubmittedTransaction: artifact.executionTransactionsFromKeeper > 0,
      localExecutionCollateralReduced: artifact.localExecutionCollateralReduced,
    })) {
      requireInvariant(value === true, `daemon smoke ${field}`);
    }
    return artifact;
  } finally {
    await subgraph.close();
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

function requireInvariant(condition, message) {
  if (!condition) {
    throw new Error(`Missing no-spend invariant: ${message}`);
  }
}

function assertFixtureSummary(summary) {
  requireInvariant(summary.network === 'base', 'fixture network is base');
  requireInvariant(
    typeof summary.rpcUrl === 'string' && isLocalhostUrl(summary.rpcUrl),
    'fixture rpcUrl is localhost'
  );
  requireInvariant(
    summary.stages?.createPool?.status === 'created' ||
      summary.stages?.createPool?.status === 'reused',
    'pool creation status recorded'
  );
  requireInvariant(
    summary.stages?.deployTokens?.quoteTokenSource === 'deployed' &&
      summary.stages?.deployTokens?.collateralTokenSource === 'deployed',
    'token deployment status recorded as deployed'
  );
  requireInvariant(
    summary.stages?.seedUniswap?.status === 'seeded',
    'Uniswap seeding status recorded as seeded'
  );
  requireInvariant(
    ['deployed', 'reused'].includes(
      summary.stages?.deployExternalTake?.mode
    ),
    'external-take factory/taker deployed or reused'
  );
  requireInvariant(
    ['kicked', 'already_active'].includes(summary.finalKick?.status),
    'final kick status is kicked or already_active'
  );
  requireInvariant(
    summary.uniswapV3ExternalTake?.routeShapeVerification?.status ===
      'passed',
    'route-shape verification passed'
  );
  requireInvariant(
    typeof summary.uniswapV3ExternalTake?.deployment?.keeperTakerFactory ===
      'string',
    'keeper taker factory address recorded'
  );
  requireInvariant(
    typeof summary.uniswapV3ExternalTake?.deployment?.uniswapV3Taker ===
      'string',
    'Uniswap V3 taker address recorded'
  );
}

function assertEnvArtifact(report, label) {
  requireInvariant(
    report.envArtifact?.rawSecretValuesRecorded === false,
    `${label} env artifact records no raw secret values`
  );
  requireInvariant(
    Array.isArray(report.envArtifact?.unexpectedSecretLikeEnvNames) &&
      report.envArtifact.unexpectedSecretLikeEnvNames.length === 0,
    `${label} harness child env contains only expected local secret labels`
  );
}

function assertRouteFee(report, expectedFeeTier, label) {
  requireInvariant(
    Number.isInteger(report.routeArtifact?.selectedFeeTier),
    `${label} routeArtifact selected fee tier`
  );
  if (expectedFeeTier !== undefined) {
    requireInvariant(
      report.routeArtifact.selectedFeeTier === expectedFeeTier,
      `${label} selected fee tier ${expectedFeeTier}`
    );
  }
}

function assertSuccessfulDryRunReport(report, options) {
  if (report.mode !== options.mode) {
    throw new Error(
      `Dry-run harness mode was ${report.mode}, expected ${options.mode}`
    );
  }
  if (options.mode === 'discovery') {
    const dryRunExternalTakes = sumDiscoveryStats(
      report,
      'dryRunExternalTakes'
    );
    const dryRunFactoryPathTakes = sumPathCounter(report, 'factory', 'dryRun');
    if (dryRunExternalTakes < 1 || dryRunFactoryPathTakes < 1) {
      throw new Error(
        `Dry-run did not reach the discovered external-take path. dryRunExternalTakes=${dryRunExternalTakes} factoryDryRuns=${dryRunFactoryPathTakes}`
      );
    }
  }
  requireInvariant(
    report.routeArtifact?.selectedPath === 'factory',
    'dry-run routeArtifact selected factory path'
  );
  requireInvariant(
    report.routeArtifact?.selectedLiquiditySource === 'UNISWAPV3',
    'dry-run routeArtifact selected UNISWAPV3'
  );
  assertRouteFee(report, options.expectedFeeTier, 'dry-run');
  requireInvariant(
    report.txArtifact?.transactions?.length === 0,
    'dry-run records no broadcast transactions'
  );
  requireInvariant(
    report.transportArtifact?.selectedWriteTransportMode === 'public_rpc',
    'dry-run selected transport mode recorded'
  );
  assertEnvArtifact(report, 'dry-run');
}

function assertSkipReport(report, options) {
  if (report.mode !== options.mode) {
    throw new Error(
      `Skip harness mode was ${report.mode}, expected ${options.mode}`
    );
  }
  const totalSkips =
    Number(report.skipArtifact?.evaluationSkips ?? 0) +
    Number(report.skipArtifact?.revalidationSkips ?? 0) +
    Number(report.skipArtifact?.executionSkips ?? 0);
  requireInvariant(
    report.takeExecuted === false,
    'skip scenario did not execute a take'
  );
  requireInvariant(
    report.txArtifact?.transactions?.length === 0,
    'skip scenario recorded no broadcast transactions'
  );
  requireInvariant(
    totalSkips > 0 || report.skipArtifact?.events?.length > 0,
    'skip scenario recorded a structured skip reason'
  );
  assertEnvArtifact(report, 'skip');
}

function assertExecutionReport(report, options) {
  if (report.mode !== options.mode) {
    throw new Error(
      `Execution harness mode was ${report.mode}, expected ${options.mode}`
    );
  }
  if (report.takeExecuted !== true || report.collateralReducedByTake !== true) {
    throw new Error(
      `Execution did not reduce auction collateral. takeExecuted=${report.takeExecuted} collateralReducedByTake=${report.collateralReducedByTake}`
    );
  }
  if (options.mode === 'discovery') {
    const executedExternalTakes = sumDiscoveryStats(
      report,
      'executedExternalTakes'
    );
    const executedFactoryPathTakes = sumPathCounter(
      report,
      'factory',
      'executed'
    );
    if (executedExternalTakes < 1 || executedFactoryPathTakes < 1) {
      throw new Error(
        `Execution did not record a factory external take. executedExternalTakes=${executedExternalTakes} factoryExecutions=${executedFactoryPathTakes}`
      );
    }
  }
  requireInvariant(
    report.routeArtifact?.selectedPath === 'factory',
    'execution routeArtifact selected factory path'
  );
  requireInvariant(
    report.routeArtifact?.selectedLiquiditySource === 'UNISWAPV3',
    'execution routeArtifact selected UNISWAPV3'
  );
  assertRouteFee(report, options.expectedFeeTier, 'execution');
  requireInvariant(
    options.mode !== 'discovery' ||
      (report.routeArtifact?.counters?.preBroadcastFailures === 0 &&
        report.routeArtifact?.counters?.postSubmissionFailures === 0),
    'execution records no factory pre-broadcast or post-submission failures'
  );
  requireInvariant(
    report.receiptArtifact?.transactionHash &&
      report.receiptArtifact?.status === 1,
    'execution receipt status is successful'
  );
  requireInvariant(
    Number(report.receiptArtifact?.gasUsed ?? 0) > 0,
    'execution receipt gas used recorded'
  );
  requireInvariant(
    report.balanceArtifact?.positiveDelta === true,
    'keeper quote-token balance delta is positive'
  );
  requireInvariant(
    report.stateArtifact?.collateralReduced === true,
    'auction collateral decreased after execution'
  );
  requireInvariant(
    report.stateArtifact?.debtReducedOrNoCollateralRemaining === true,
    'auction debt decreased, auction is inactive, or no collateral remains after execution'
  );
  requireInvariant(
    Array.isArray(report.approvalArtifact?.checks) &&
      report.approvalArtifact.checks.length > 0 &&
      report.approvalArtifact.checks.every((check) => check.resetToZero),
    'expected token approvals reset to zero'
  );
  requireInvariant(
    report.transportArtifact?.selectedWriteTransportMode === 'public_rpc',
    'execution selected transport mode recorded'
  );
  assertEnvArtifact(report, 'execution');
  if (options.mode === 'manual') {
    requireInvariant(
      report.manualArtifact?.selectedDeploymentFromManualConfig === true,
      'manual selected deployment comes from manual config'
    );
    requireInvariant(
      report.manualArtifact?.lifiNoBroadcastPolicyContextResolved === true,
      'manual LI.FI no-broadcast policy/context resolution recorded'
    );
  }
}

function assertConfigArtifact(report) {
  const artifact = report.configArtifact;
  requireInvariant(artifact?.enabled === true, 'config smoke artifact present');
  for (const [field, value] of Object.entries({
    malformedConfigRejected: artifact.malformedConfigRejected,
    validConfigLoaded: artifact.validConfigLoaded,
    configValidationPassed: artifact.configValidationPassed,
    autoDiscoverValidationPassed: artifact.autoDiscoverValidationPassed,
    routeDeploymentPreflightPassed: artifact.routeDeploymentPreflightPassed,
    chainConsistencyPreflightPassed: artifact.chainConsistencyPreflightPassed,
    discoveredTargetBuiltFromConfig: artifact.discoveredTargetBuiltFromConfig,
    expectedTargetFound: artifact.expectedTargetFound,
    wrongDeploymentPoolSkipped: artifact.wrongDeploymentPoolSkipped,
    hydrationCooldownRecorded: artifact.hydrationCooldownRecorded,
    hydrationCooldownPreventedRepeat:
      artifact.hydrationCooldownPreventedRepeat,
  })) {
    requireInvariant(value === true, `config smoke ${field}`);
  }
}

function buildStateIntegrityArtifact(params) {
  if (!params.dryRunReport || !params.executionReport) {
    return undefined;
  }
  const dryRunBefore = params.dryRunReport.stateArtifact?.auctionBeforeTake;
  const executionBefore =
    params.executionReport.stateArtifact?.auctionBeforeTake;
  const sameCollateral =
    String(dryRunBefore?.collateral ?? '') ===
    String(executionBefore?.collateral ?? '');
  return {
    snapshotRevertedBeforeExecution: true,
    dryRunBroadcastTransactions:
      params.dryRunReport.txArtifact?.transactions?.length ?? 0,
    auctionBeforeDryRun: dryRunBefore ?? null,
    auctionBeforeExecution: executionBefore ?? null,
    auctionCollateralRestoredAfterDryRun: sameCollateral,
    dynamicAuctionFieldsChangedAfterReplay:
      JSON.stringify(dryRunBefore ?? null) !==
      JSON.stringify(executionBefore ?? null),
    dryRunMutatedForkBeforeRevert:
      JSON.stringify(params.dryRunReport.stateArtifact?.auctionAfterTake ?? null) !==
      JSON.stringify(dryRunBefore ?? null),
  };
}

function fixtureEnv(params) {
  const optionalRepoEnv = {};
  for (const name of [
    'AJNA_AGENT_TOKEN_DEPLOYER_REPO',
    'AJNA_AGENT_AJNA_SKILLS_REPO',
  ]) {
    if (process.env[name]) {
      optionalRepoEnv[name] = process.env[name];
    }
  }
  const expectedFeeTierEnv =
    params.expectedFeeTier ??
    process.env.AJNA_AGENT_NO_SPEND_EXPECTED_FEE_TIER;

  const env = withNoEgressGuard(baseChildEnv({
    ...optionalRepoEnv,
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
    ...(expectedFeeTierEnv
      ? {
          AJNA_AGENT_UNISWAP_EXPECTED_EXECUTION_FEE_TIER:
            String(expectedFeeTierEnv),
        }
      : {}),
    AJNA_AGENT_UNISWAP_WETH_LIQUIDITY_RAW:
      process.env.AJNA_AGENT_NO_SPEND_UNISWAP_WETH_LIQUIDITY_RAW ??
      '1000000000000000000',
    AJNA_AGENT_UNISWAP_WETH_QUOTE_LIQUIDITY_RAW:
      process.env.AJNA_AGENT_NO_SPEND_UNISWAP_WETH_QUOTE_LIQUIDITY_RAW ??
      '3000000000000000000000',
  }), {
    allowedHosts: params.allowedHosts,
    reportPath: params.egressReportPath,
  });

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
  const scenarioEnv = {};
  for (const name of [
    'AJNA_AGENT_HARNESS_ALLOWED_EXTERNAL_TAKE_PATHS',
    'AJNA_AGENT_HARNESS_ALLOWED_LIQUIDITY_SOURCES',
    'AJNA_AGENT_HARNESS_ROUTE_SELECTION_MODE',
    'AJNA_AGENT_HARNESS_MAX_GAS_COST_NATIVE',
    'AJNA_AGENT_HARNESS_MIN_EXPECTED_PROFIT_QUOTE',
    'AJNA_AGENT_HARNESS_MAX_CONCURRENT_CANDIDATE_EVALUATIONS',
    'AJNA_AGENT_HARNESS_MAX_IN_FLIGHT_ROUTE_PROBES',
    'AJNA_AGENT_HARNESS_MAX_EXECUTIONS_PER_POOL_PER_RUN',
    'AJNA_AGENT_HARNESS_TAKE_ROUTE_QUOTE_BUDGET_PER_CANDIDATE',
    'AJNA_AGENT_HARNESS_TAKE_QUOTE_BUDGET_PER_RUN',
  ]) {
    if (process.env[name]) {
      scenarioEnv[name] = process.env[name];
    }
  }
  if (params.configSmoke) {
    scenarioEnv.AJNA_AGENT_HARNESS_CONFIG_SMOKE = '1';
  }
  return withNoEgressGuard(baseChildEnv({
    ...scenarioEnv,
    AJNA_AGENT_RPC_URL: params.rpcUrl,
    AJNA_RPC_URL_BASE: params.rpcUrl,
    AJNA_AGENT_KEEPER_KEY: HARDHAT_DEFAULT_KEEPER_KEY,
    AJNA_AGENT_HARNESS_OUTPUT_PATH: params.outputPath,
  }), {
    allowedHosts: params.allowedHosts,
    reportPath: params.egressReportPath,
  });
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
  const { forkRpcUrl, source: forkRpcSource } = resolveForkRpcUrl();
  const resolvedForkBlock = await resolveForkBlock({
    forkRpcUrl,
    requestedForkBlock: options.baseForkBlock,
  });
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
  const egressReportPath = path.join(tempDir, 'blocked-egress.jsonl');
  const validationReportPath = options.outputPath
    ? path.resolve(options.outputPath)
    : path.join(tempDir, 'no-spend-report.json');
  const allowedHosts = getAllowedHostList(rpcUrl, forkRpcUrl);
  const replayCommand = buildReplayCommand({
    resolvedForkBlockNumber: resolvedForkBlock.number,
  });

  process.stdout.write(
      `[no-spend] tempDir=${tempDir}\n` +
      `[no-spend] scenario=${options.scenarioName}\n` +
      `[no-spend] localRpc=${rpcUrl}\n` +
      `[no-spend] requestedBaseForkBlock=${options.baseForkBlock}\n` +
      `[no-spend] resolvedBaseForkBlock=${resolvedForkBlock.number}\n` +
      `[no-spend] resolvedBaseForkHash=${resolvedForkBlock.hash}\n`
  );

  const node = startHardhatNode({
    port,
    forkRpcUrl,
    resolvedForkBlockNumber: resolvedForkBlock.number,
    logPath: nodeLogPath,
    allowedHosts,
    egressReportPath,
  });
  let hardhatStopped = false;

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
      fixtureEnv({
        rpcUrl,
        keyFilePath,
        summaryPath,
        allowedHosts,
        egressReportPath,
        expectedFeeTier: options.expectedFeeTier,
      }),
      fixtureLogPath
    );
    const fixtureSummary = readJson(summaryPath, 'fixture summary');
    assertFixtureSummary(fixtureSummary);
    let daemonArtifact;
    if (options.runDaemonSmoke) {
      daemonArtifact = await runDaemonSmoke({
        summary: fixtureSummary,
        summaryPath,
        rpcUrl,
        tempDir,
        allowedHosts,
        egressReportPath,
      });
    }

    if (options.daemonSmokeOnly) {
      await stopHardhatNode();
      hardhatStopped = true;
      const validationReport = {
        status: 'passed',
        scenario: options.scenarioName,
        harnessMode: options.harnessMode,
        daemonSmokeOnly: true,
        command: ['npm', 'run', 'no-spend-validation'],
        replayCommand,
        requestedForkBlock: resolvedForkBlock.requested,
        resolvedForkBlockNumber: resolvedForkBlock.number,
        resolvedForkBlockHash: resolvedForkBlock.hash,
        forkRpc: redactUrlForReport(forkRpcUrl, forkRpcSource),
        localRpcUrl: rpcUrl,
        allowedEgressHosts: allowedHosts.split(','),
        egressReportPath,
        hardhatStopped,
        reports: {
          fixtureSummary: summaryPath,
        },
        logs: {
          fixture: fixtureLogPath,
          hardhat: nodeLogPath,
        },
        daemon: daemonArtifact,
      };
      fs.mkdirSync(path.dirname(validationReportPath), { recursive: true });
      fs.writeFileSync(
        validationReportPath,
        `${JSON.stringify(validationReport, null, 2)}\n`
      );
      process.stdout.write(
        `[no-spend] daemon smoke passed\n` +
          `[no-spend] validationReport=${validationReportPath}\n` +
          `[no-spend] fixtureSummary=${summaryPath}\n` +
          `[no-spend] fixtureLog=${fixtureLogPath}\n` +
          `[no-spend] hardhatLog=${nodeLogPath}\n`
      );
      return;
    }

    const snapshotId = await requestJsonRpc(rpcUrl, 'evm_snapshot');
    try {
      await runNodeScript(
        'running discovered-take dry-run harness',
        path.join(ROOT, 'scripts', 'run-fixture-keeper-harness.ts'),
        [
          '--summary',
          summaryPath,
          '--mode',
          options.harnessMode,
          '--hybrid-gas-quote-fallback',
          options.hybridGasQuoteFallback,
          '--dry-run',
          '--auto-warp-to-take',
        ],
        harnessEnv({
          rpcUrl,
          outputPath: dryRunReportPath,
          allowedHosts,
          egressReportPath,
          configSmoke:
            options.runConfigSmoke && options.harnessMode === 'discovery',
        }),
        dryRunLogPath
      );
      const dryRunReport = readJson(dryRunReportPath, 'dry-run report');
      if (options.expectedResult === 'skip') {
        assertSkipReport(dryRunReport, {
          mode: options.harnessMode,
        });
      } else {
        assertSuccessfulDryRunReport(dryRunReport, {
          mode: options.harnessMode,
          expectedFeeTier: options.expectedFeeTier,
        });
      }
      if (options.runConfigSmoke && options.harnessMode === 'discovery') {
        assertConfigArtifact(dryRunReport);
      }
    } finally {
      await requestJsonRpc(rpcUrl, 'evm_revert', [snapshotId]);
    }

    const dryRunReport = readJson(dryRunReportPath, 'dry-run report');
    let executionReport;
    if (!options.dryRunOnly && options.expectedResult === 'success') {
      await runNodeScript(
        'running discovered-take execution harness on local fork',
        path.join(ROOT, 'scripts', 'run-fixture-keeper-harness.ts'),
        [
          '--summary',
          summaryPath,
          '--mode',
          options.harnessMode,
          '--hybrid-gas-quote-fallback',
          options.hybridGasQuoteFallback,
          '--auto-warp-to-take',
        ],
        harnessEnv({
          rpcUrl,
          outputPath: executionReportPath,
          allowedHosts,
          egressReportPath,
          configSmoke: false,
        }),
        executionLogPath
      );
      executionReport = readJson(executionReportPath, 'execution report');
      assertExecutionReport(executionReport, {
        mode: options.harnessMode,
        expectedFeeTier: options.expectedFeeTier,
      });
    }

    await stopHardhatNode();
    hardhatStopped = true;
    const stateIntegrity = buildStateIntegrityArtifact({
      dryRunReport,
      executionReport,
    });
    if (stateIntegrity) {
      requireInvariant(
        stateIntegrity.dryRunBroadcastTransactions === 0,
        'dry-run state integrity: no dry-run broadcast transactions'
      );
      requireInvariant(
        stateIntegrity.auctionCollateralRestoredAfterDryRun === true,
        'dry-run state integrity: auction collateral restored before execution'
      );
    }

    const validationReport = {
      status: 'passed',
      scenario: options.scenarioName,
      harnessMode: options.harnessMode,
      expectedResult: options.expectedResult,
      dryRunOnly: options.dryRunOnly,
      hybridGasQuoteFallback: options.hybridGasQuoteFallback,
      command: ['npm', 'run', 'no-spend-validation'],
      replayCommand,
      requestedForkBlock: resolvedForkBlock.requested,
      resolvedForkBlockNumber: resolvedForkBlock.number,
      resolvedForkBlockHash: resolvedForkBlock.hash,
      forkRpc: redactUrlForReport(forkRpcUrl, forkRpcSource),
      localRpcUrl: rpcUrl,
      allowedEgressHosts: allowedHosts.split(','),
      egressReportPath,
      hardhatStopped,
      reports: {
        fixtureSummary: summaryPath,
        dryRun: dryRunReportPath,
        execution: executionReport ? executionReportPath : undefined,
      },
      logs: {
        fixture: fixtureLogPath,
        dryRun: dryRunLogPath,
        execution: executionReport ? executionLogPath : undefined,
        hardhat: nodeLogPath,
      },
      dryRun: {
        route: dryRunReport.routeArtifact,
        skip: dryRunReport.skipArtifact,
        config: dryRunReport.configArtifact,
        policy: dryRunReport.policyArtifact,
      },
      route: (executionReport ?? dryRunReport).routeArtifact,
      receipt: executionReport?.receiptArtifact,
      balance: executionReport?.balanceArtifact ?? dryRunReport.balanceArtifact,
      approval:
        executionReport?.approvalArtifact ?? dryRunReport.approvalArtifact,
      transport:
        executionReport?.transportArtifact ?? dryRunReport.transportArtifact,
      env: executionReport?.envArtifact ?? dryRunReport.envArtifact,
      stateIntegrity,
      daemon: daemonArtifact,
    };
    fs.mkdirSync(path.dirname(validationReportPath), { recursive: true });
    fs.writeFileSync(
      validationReportPath,
      `${JSON.stringify(validationReport, null, 2)}\n`
    );

    process.stdout.write(
      `[no-spend] validation passed\n` +
        `[no-spend] validationReport=${validationReportPath}\n` +
        `[no-spend] fixtureSummary=${summaryPath}\n` +
        `[no-spend] dryRunReport=${dryRunReportPath}\n` +
        `[no-spend] executionReport=${executionReportPath}\n` +
        `[no-spend] fixtureLog=${fixtureLogPath}\n` +
        `[no-spend] dryRunLog=${dryRunLogPath}\n` +
        `[no-spend] executionLog=${executionLogPath}\n` +
        `[no-spend] hardhatLog=${nodeLogPath}\n`
    );
  } finally {
    if (!hardhatStopped) {
      await stopHardhatNode();
    }
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
