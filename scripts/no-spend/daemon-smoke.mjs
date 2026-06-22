import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { Wallet, Contract, providers } from 'ethers';
import {
  ROOT,
  TS_NODE_BIN,
  baseChildEnv,
  readJson,
  requestJsonRpc,
  runCommandWithTimeout,
  runNodeScript,
} from './runtime.mjs';
import { withNoEgressGuard } from './egress.mjs';
import {
  getFixtureAuctions,
  buildFixtureSubgraphData,
} from './fixture-subgraph-stub.mjs';

// The take loop logs this line once per cycle (src/discovery/runtime.ts
// logDiscoveryCycleSummary). Counting it proves the persistent daemon actually
// looped; its discoveredTargets / targetSuccesses fields prove the keeper found
// the auction via the real subgraph enumeration and acted on it.
const DAEMON_TAKE_CYCLE_MARKER = 'Discovery take cycle summary:';
const DAEMON_SIGTERM_LOG = 'Received SIGTERM; shutting down keeper.';

const HARDHAT_DEFAULT_KEEPER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BASE_ONEINCH_ROUTER = '0x1111111254EEB25477B68fb85Ed929f73A960582';
// Sighash of MockLifiSwapTarget.mockSwap(address,address,address,uint256,uint256).
// The fixture allowlists each aggregator taker for {mockTarget, this selector},
// so the aggregator daemon's dex.lifi allowlist must match it for the on-chain
// route-deployment preflight to reconcile.
const MOCK_SWAP_SELECTOR = '0x79c6257b';
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

function requireNoSpendInvariant(condition, message) {
  if (!condition) {
    throw new Error(`Missing no-spend invariant: ${message}`);
  }
}

async function startFixtureSubgraphStub(params) {
  // Accept either a single `summary` (existing single-pool legs) or a
  // `summaries` array (multi-pool enumeration). The auction set is static, so
  // build it once; only `_meta` (live block) is recomputed per request.
  const summaries = params.summaries ?? [params.summary];
  const auctions = getFixtureAuctions(summaries);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405);
        response.end('method not allowed');
        return;
      }
      // Failover injection: when `failPrimary` is set, the PRIMARY endpoint (path
      // `/`) returns 503 so the keeper's subgraph reader fails over to the
      // configured fallbackUrls (path `/fallback`, served normally below). Drives
      // real in-daemon `fallbackUrls` failover end-to-end.
      const isFallbackEndpoint = (request.url ?? '').startsWith('/fallback');
      if (params.failPrimary && !isFallbackEndpoint) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            errors: [{ message: 'primary subgraph unavailable (failover test)' }],
          })
        );
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
        const latestBlock = await requestJsonRpc(
          params.rpcUrl,
          'eth_getBlockByNumber',
          ['latest', false]
        );
        const meta = {
          block: {
            number: Number.parseInt(latestBlock.number, 16),
            timestamp: Number.parseInt(latestBlock.timestamp, 16),
          },
          deployment: 'fixture-local',
          hasIndexingErrors: false,
        };
        const data = buildFixtureSubgraphData({
          query,
          variables,
          auctions,
          meta,
        });
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
  // Single-pool legs pass nothing and discovery ranges over just this pool.
  // The multi-pool leg passes `allowPools` (the discovered pools to enumerate)
  // and `manualPools` (full PoolConfig entries the manual loop owns — discovery
  // must SKIP these, proving manual-take precedence). `params.summary` still
  // supplies the SHARED deployment/router config, so the multi-pool fixture
  // must reuse one KeeperTakerRouter + taker set across every pool.
  const allowPools = params.allowPools ?? [params.summary.pool.address];
  const manualPools = params.manualPools ?? [];
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
      pools: manualPools,
    },
    discovery: {
      enabled: true,
      dryRunNewPools: false,
      hydrateCooldownSec: 30,
      logSkips: true,
      allowPools,
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
        allowedExternalTakePaths: ['direct_dex'],
        defaultDirectDexLiquiditySource: 2,
        allowedLiquiditySources: [2],
        externalTakeRouteSelectionMode: 'maximize_profit',
        hybridGasQuoteFailureFallbackMode: 'disabled',
        // Default 1 native token; a tiny override drives the gas-policy skip
        // (P1-3 gas-spike: every take is rejected native_gas_cost_above_cap).
        maxGasCostNative: params.maxGasCostNative ?? 1,
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
      // Schema field is `router` (the KeeperTakerRouter registry address); a
      // stale `factory` key is silently ignored and trips the take-settings
      // validation "takers.router required when liquiditySource is UNISWAPV3".
      router: uniswap.deployment.keeperTakerRouter,
      contracts: {
        UniswapV3: uniswap.deployment.uniswapV3Taker,
      },
    },
  };
}

// Per-provider descriptors for the calldata_aggregator daemon path. All share the
// same deployed MockLifiSwapTarget allowlist (the fixture allowlists every
// aggregator taker for the mock), so only the source/provider-id/taker key/dex
// key differ. 1inch is omitted (force-disabled / 401).
const AGGREGATOR_PROVIDERS = {
  lifi: {
    source: 5,
    providerId: 'lifi',
    takerKey: 'Lifi',
    contractKey: 'Lifi',
    dexKey: 'lifi',
  },
  sushi_aggregator: {
    source: 6,
    providerId: 'sushi_aggregator',
    takerKey: 'SushiAggregator',
    contractKey: 'SushiAggregator',
    dexKey: 'sushiAggregator',
  },
};

// Build the provider-specific dex block. The three allowlists point at the shared
// mock target (+ mockSwap selector) so the route-deployment preflight reconciles
// against the taker's on-chain allowlist. LI.FI carries extra production-policy
// fields (feeCostPolicy/allowExchanges) that Sushi does not.
function buildAggregatorDexConfig(providerKey, mockTarget) {
  const allowlists = {
    callTargetAllowlist: { 8453: [mockTarget] },
    approvalSpenderAllowlist: { 8453: [mockTarget] },
    selectorAllowlist: { 8453: { [mockTarget]: [MOCK_SWAP_SELECTOR] } },
  };
  if (providerKey === 'lifi') {
    return {
      lifi: {
        mode: 'production',
        defaultSlippage: 0.005,
        feeCostPolicy: 'included_only',
        allowExchanges: ['sushiswap', 'nordstern', 'fly'],
        ...allowlists,
      },
    };
  }
  return {
    sushiAggregator: { mode: 'production', defaultSlippage: 0.005, ...allowlists },
  };
}

// Aggregator daemon config (LI.FI or Sushi). Distinct from buildDaemonConfig in
// three ways: the take path is calldata_aggregator (not direct_dex), the taker is
// the deployed provider taker, and the dex block is a production-mode config whose
// allowlist points at the deployed MockLifiSwapTarget (+ mockSwap selector) — so
// the startup route-deployment preflight reconciles the config allowlist against
// the taker's on-chain allowlist (which the fixture set to the same mock target).
// The env-gated quote injector (installed by daemon-harness-entry.ts) supplies
// the actual quote at take time; validation/preflight still run for real.
function buildAggregatorDaemonConfig(params) {
  const providerKey = params.provider ?? 'lifi';
  const provider = AGGREGATOR_PROVIDERS[providerKey];
  if (!provider) {
    throw new Error(`Unknown aggregator provider: ${providerKey}`);
  }
  const uniswap = params.summary.uniswapV3ExternalTake;
  const deployment = uniswap?.deployment;
  const taker = (deployment?.aggregatorTakers ?? []).find(
    (entry) => entry.key === provider.takerKey
  );
  if (!taker) {
    throw new Error(
      `Fixture summary missing the ${provider.takerKey} aggregator taker (re-run the fixture with external-take deployment)`
    );
  }
  const mockTarget = taker.targetAddress;
  const allowPools = params.allowPools ?? [params.summary.pool.address];
  return {
    network: {
      rpcUrl: params.rpcUrl,
      readRpcUrls: [params.rpcUrl],
      subgraph: {
        url: params.subgraphUrl,
        fallbackUrls: [`${params.subgraphUrl}/fallback`],
      },
      tokenAddresses: { weth: uniswap.routerConfig.wethAddress },
    },
    signer: { keystore: params.keystorePath },
    runtime: { logLevel: 'debug', delayBetweenRuns: 1, dryRun: params.dryRun },
    ajna: BASE_AJNA_CONFIG,
    manual: { pools: [] },
    discovery: {
      enabled: true,
      dryRunNewPools: false,
      hydrateCooldownSec: 30,
      logSkips: true,
      allowPools,
      denyPools: [],
      defaults: {
        take: {
          minCollateral: 0.0001,
          liquiditySource: provider.source,
          marketPriceFactor: 0.99,
        },
      },
      take: {
        enabled: true,
        allowedExternalTakePaths: ['calldata_aggregator'],
        allowedCalldataAggregatorProviders: [provider.providerId],
        externalTakeRouteSelectionMode: 'maximize_profit',
        hybridGasQuoteFailureFallbackMode: 'disabled',
        maxGasCostNative: params.maxGasCostNative ?? 1,
        validateRouteDeployments: true,
        // Required for the calldata_aggregator path (keyed by LiquiditySource).
        dexGasOverrides: { [provider.source]: '900000' },
      },
    },
    dex: buildAggregatorDexConfig(providerKey, mockTarget),
    takers: {
      router: deployment.keeperTakerRouter,
      contracts: { [provider.contractKey]: taker.takerAddress },
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

function harnessEnv(params) {
  return withNoEgressGuard(
    baseChildEnv({
      AJNA_AGENT_RPC_URL: params.rpcUrl,
      AJNA_RPC_URL_BASE: params.rpcUrl,
      AJNA_AGENT_KEEPER_KEY: HARDHAT_DEFAULT_KEEPER_KEY,
      AJNA_AGENT_HARNESS_OUTPUT_PATH: params.outputPath,
    }),
    {
      allowedHosts: params.allowedHosts,
      reportPath: params.egressReportPath,
    }
  );
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
    }),
    params.logPath
  );
  return readJson(params.outputPath, params.label);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Common encrypted-keystore + password file both daemon scenarios need. The
// real entrypoint requires config.signer.keystore + KEYSTORE_PASSWORD_FILE, so
// driving it faithfully means decrypting a real keystore (not a raw key env).
async function setupDaemonKeystore(tempDir) {
  const password = `ajna-local-${Date.now()}`;
  const passwordPath = path.join(tempDir, 'daemon-keystore-password.txt');
  const keystorePath = path.join(tempDir, 'daemon-keeper-keystore.json');
  const wallet = new Wallet(HARDHAT_DEFAULT_KEEPER_KEY);
  fs.writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
  fs.writeFileSync(keystorePath, await wallet.encrypt(password), {
    mode: 0o600,
  });
  return { password, passwordPath, keystorePath, wallet };
}

// Parse every per-cycle take summary line into a field map. Each occurrence is
// one completed take cycle; the fields (discoveredTargets, targetSuccesses, ...)
// let the caller assert real discovery + action without log-line guessing.
function parseTakeCycleSummaries(logText) {
  const summaries = [];
  const re = new RegExp(`${DAEMON_TAKE_CYCLE_MARKER} ([^\\n]*)`, 'g');
  let match;
  while ((match = re.exec(logText)) !== null) {
    const fields = {};
    for (const pair of match[1].trim().split(/\s+/)) {
      const eq = pair.indexOf('=');
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    summaries.push(fields);
  }
  return summaries;
}

// Spawn the REAL keeper entrypoint as a PERSISTENT daemon (NO --run-once), watch
// it loop via the on-chain tx count + per-cycle log marker until `isDone`, then
// SIGTERM it and assert a graceful exit within the grace window. ts-node is
// spawned directly (not `npm start`) so SIGTERM reaches the keeper process and
// its installProcessSafetyHandlers handler actually runs (surfaced-defects #3).
async function spawnPersistentDaemon(params) {
  const logStream = fs.createWriteStream(params.logPath);
  // Default to the production entry; the aggregator leg spawns the harness entry
  // (which installs the env-gated quote injector) with extra args instead.
  const scriptPath = params.scriptPath ?? 'src/index.ts';
  const child = spawn(
    process.execPath,
    [
      TS_NODE_BIN,
      scriptPath,
      '--config',
      params.configPath,
      ...(params.extraArgs ?? []),
    ],
    { cwd: ROOT, env: params.env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let logText = '';
  const capture = (chunk) => {
    logText += chunk.toString();
    logStream.write(chunk);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  let exit = null;
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });

  // Watch loop: poll the keeper tx count + cycle count until the done-condition
  // holds (or the watch budget elapses). `stablePolls` tracks consecutive polls
  // with no new keeper tx — the idempotency signal (looped without re-acting).
  const startedAt = Date.now();
  let txCount = 0;
  let txHashes = [];
  let prevTxCount = -1;
  let stablePolls = 0;
  let reachedDone = false;
  while (Date.now() - startedAt < params.maxWatchMs && exit === null) {
    await sleep(params.pollIntervalMs);
    const cycles = parseTakeCycleSummaries(logText).length;
    const toBlock = await readBlockNumber(params.rpcUrl);
    const txs = await countTransactionsFrom({
      rpcUrl: params.rpcUrl,
      fromBlockExclusive: params.startBlock,
      toBlockInclusive: toBlock,
      from: params.keeperAddress,
    });
    stablePolls = txs.count === prevTxCount ? stablePolls + 1 : 0;
    prevTxCount = txs.count;
    txCount = txs.count;
    txHashes = txs.hashes;
    if (params.isDone({ cycles, txCount, stablePolls })) {
      reachedDone = true;
      break;
    }
  }

  // SIGTERM teardown; require graceful exit within grace, else SIGKILL.
  const shutdownStartedAt = Date.now();
  let shutdownClean = false;
  if (exit === null) {
    child.kill('SIGTERM');
    while (Date.now() - shutdownStartedAt < params.graceMs && exit === null) {
      await sleep(200);
    }
    if (exit === null) {
      child.kill('SIGKILL');
    } else {
      shutdownClean = true;
    }
  }
  logStream.end();
  const summaries = parseTakeCycleSummaries(logText);
  return {
    cyclesObserved: summaries.length,
    summaries,
    txCount,
    txHashes,
    reachedDone,
    stablePolls,
    exit,
    shutdownClean,
    sigtermHandled: logText.includes(DAEMON_SIGTERM_LOG),
    shutdownMs: Date.now() - shutdownStartedAt,
    logPath: params.logPath,
  };
}

export async function runDaemonSmoke(params) {
  const subgraph = await startFixtureSubgraphStub({
    summary: params.summary,
    rpcUrl: params.rpcUrl,
  });
  const { passwordPath, keystorePath, wallet } = await setupDaemonKeystore(
    params.tempDir
  );
  const wrongPasswordPath = path.join(
    params.tempDir,
    'daemon-keystore-password-wrong.txt'
  );
  const missingPasswordPath = path.join(
    params.tempDir,
    'daemon-keystore-password-missing.txt'
  );
  fs.writeFileSync(wrongPasswordPath, 'wrong-password\n', { mode: 0o600 });

  const dryRunConfigPath = path.join(
    params.tempDir,
    'daemon-dry-run-config.json'
  );
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

  const command = (configPath, liveOk = false) => [
    'npm',
    'start',
    '--',
    '--config',
    configPath,
    '--run-once',
    ...(liveOk ? ['--run-once-live-ok'] : []),
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

    const executionSnapshot = await requestJsonRpc(
      params.rpcUrl,
      'evm_snapshot'
    );
    await warpLocalTakeWindow(params.rpcUrl);
    const beforeStatePath = path.join(
      params.tempDir,
      'daemon-before-state.json'
    );
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
      command(executionConfigPath, true),
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
      coveredCycles: ['take', 'settlement'],
      excludedDaemonCycles: ['kick', 'collectBond', 'collectLpRewards'],
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
      executionSubmittedTransaction:
        artifact.executionTransactionsFromKeeper > 0,
      localExecutionCollateralReduced: artifact.localExecutionCollateralReduced,
    })) {
      requireNoSpendInvariant(value === true, `daemon smoke ${field}`);
    }
    return artifact;
  } finally {
    await subgraph.close();
  }
}

// P1-3: the PERSISTENT-daemon lifecycle scenario — the fidelity complement to
// runDaemonSmoke's bounded --run-once. Launches the REAL long-lived keeper (no
// --run-once) against the fixture, proves it loops multiple cycles, genuinely
// DISCOVERS the auction via the real subgraph enumeration and acts, does NOT
// re-act on the already-cleared auction across later cycles (idempotency), and
// shuts down cleanly on SIGTERM. A dry-run leg proves repeated cycles broadcast
// nothing. This is what turns "is it a real running keeper?" from no into yes.
export async function runDaemonLifecycle(params) {
  const subgraph = await startFixtureSubgraphStub({
    summary: params.summary,
    rpcUrl: params.rpcUrl,
  });
  try {
    const { passwordPath, keystorePath, wallet } = await setupDaemonKeystore(
      params.tempDir
    );
    const writeConfig = (dryRun, name, extra = {}) => {
      const configPath = path.join(params.tempDir, name);
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          buildDaemonConfig({
            ...params,
            subgraphUrl: subgraph.url,
            keystorePath,
            dryRun,
            ...extra,
          }),
          null,
          2
        )}\n`
      );
      return configPath;
    };
    const executionConfigPath = writeConfig(
      false,
      'daemon-lifecycle-execution-config.json'
    );
    const dryRunConfigPath = writeConfig(
      true,
      'daemon-lifecycle-dry-run-config.json'
    );
    // Gas-spike leg: a tiny gas-cost cap so the gas policy rejects every take.
    const gasSpikeConfigPath = writeConfig(
      false,
      'daemon-lifecycle-gas-spike-config.json',
      { maxGasCostNative: 0.000000001 }
    );
    const env = daemonChildEnv({
      allowedHosts: params.allowedHosts,
      egressReportPath: params.egressReportPath,
      passwordFile: passwordPath,
    });

    // EXECUTION leg: discovers + takes, then loops past its action without
    // re-taking (tx count stabilizes), then we SIGTERM it.
    const executionSnapshot = await requestJsonRpc(params.rpcUrl, 'evm_snapshot');
    await warpLocalTakeWindow(params.rpcUrl);
    const executionStartBlock = await readBlockNumber(params.rpcUrl);
    const execution = await spawnPersistentDaemon({
      configPath: executionConfigPath,
      env,
      logPath: path.join(params.tempDir, 'daemon-lifecycle-execution.log'),
      rpcUrl: params.rpcUrl,
      keeperAddress: wallet.address,
      startBlock: executionStartBlock,
      pollIntervalMs: 1_500,
      maxWatchMs: 120_000,
      graceMs: 20_000,
      // Done once it has looped >=2 cycles, taken at least once, and the keeper
      // tx count has held steady across >=2 consecutive polls (idempotent: it
      // re-entered the loop after acting without submitting a duplicate take).
      isDone: (s) => s.cycles >= 2 && s.txCount >= 1 && s.stablePolls >= 2,
    });
    await requestJsonRpc(params.rpcUrl, 'evm_revert', [executionSnapshot]);

    // DRY-RUN leg: loops >=2 cycles and broadcasts nothing.
    const dryRunSnapshot = await requestJsonRpc(params.rpcUrl, 'evm_snapshot');
    await warpLocalTakeWindow(params.rpcUrl);
    const dryRunStartBlock = await readBlockNumber(params.rpcUrl);
    const dryRun = await spawnPersistentDaemon({
      configPath: dryRunConfigPath,
      env,
      logPath: path.join(params.tempDir, 'daemon-lifecycle-dry-run.log'),
      rpcUrl: params.rpcUrl,
      keeperAddress: wallet.address,
      startBlock: dryRunStartBlock,
      pollIntervalMs: 1_500,
      maxWatchMs: 45_000,
      graceMs: 20_000,
      isDone: (s) => s.cycles >= 2,
    });
    await requestJsonRpc(params.rpcUrl, 'evm_revert', [dryRunSnapshot]);

    // GAS-SPIKE leg (P1-3): with a tiny maxGasCostNative the keeper still
    // discovers the auction every cycle but the gas policy rejects every take,
    // so it loops >=2 cycles and broadcasts NOTHING (no overspend), then exits
    // cleanly on SIGTERM. The discovered-but-no-tx pair is the meaningful skip
    // (not a vacuous "found nothing" zero-tx).
    const gasSnapshot = await requestJsonRpc(params.rpcUrl, 'evm_snapshot');
    await warpLocalTakeWindow(params.rpcUrl);
    const gasStartBlock = await readBlockNumber(params.rpcUrl);
    const gasSpike = await spawnPersistentDaemon({
      configPath: gasSpikeConfigPath,
      env,
      logPath: path.join(params.tempDir, 'daemon-lifecycle-gas-spike.log'),
      rpcUrl: params.rpcUrl,
      keeperAddress: wallet.address,
      startBlock: gasStartBlock,
      pollIntervalMs: 1_500,
      maxWatchMs: 60_000,
      graceMs: 20_000,
      isDone: (s) => s.cycles >= 2,
    });
    await requestJsonRpc(params.rpcUrl, 'evm_revert', [gasSnapshot]);

    const artifact = {
      enabled: true,
      subgraphUrl: subgraph.url,
      execution: {
        cyclesObserved: execution.cyclesObserved,
        loopedMultipleCycles: execution.cyclesObserved >= 2,
        discoveredViaSubgraph: execution.summaries.some(
          (s) => Number(s.discoveredTargets ?? 0) >= 1
        ),
        takeExecuted:
          execution.txCount >= 1 &&
          execution.summaries.some((s) => Number(s.targetSuccesses ?? 0) >= 1),
        takeTxCount: execution.txCount,
        takeTxHashes: execution.txHashes,
        // The auction was actioned once and NOT re-actioned on later cycles.
        idempotentNoDuplicateTake: execution.reachedDone,
        shutdownCleanOnSigterm:
          execution.shutdownClean && execution.sigtermHandled,
        sigtermHandlerRan: execution.sigtermHandled,
        exit: execution.exit,
      },
      dryRun: {
        cyclesObserved: dryRun.cyclesObserved,
        loopedMultipleCycles: dryRun.cyclesObserved >= 2,
        transactionsFromKeeper: dryRun.txCount,
        submittedNoTransactions: dryRun.txCount === 0,
        shutdownCleanOnSigterm: dryRun.shutdownClean && dryRun.sigtermHandled,
        exit: dryRun.exit,
      },
      gasSpike: {
        cyclesObserved: gasSpike.cyclesObserved,
        loopedMultipleCycles: gasSpike.cyclesObserved >= 2,
        // Found the auction but did NOT take it — the gas policy skip, not a
        // vacuous "nothing to do" zero-tx.
        discoveredViaSubgraph: gasSpike.summaries.some(
          (s) => Number(s.discoveredTargets ?? 0) >= 1
        ),
        takeTxCount: gasSpike.txCount,
        submittedNoTransactions: gasSpike.txCount === 0,
        shutdownCleanOnSigterm:
          gasSpike.shutdownClean && gasSpike.sigtermHandled,
        exit: gasSpike.exit,
      },
      logs: {
        execution: execution.logPath,
        dryRun: dryRun.logPath,
        gasSpike: gasSpike.logPath,
      },
    };

    for (const [field, value] of Object.entries({
      executionLoopedMultipleCycles: artifact.execution.loopedMultipleCycles,
      executionDiscoveredViaSubgraph: artifact.execution.discoveredViaSubgraph,
      executionTakeExecuted: artifact.execution.takeExecuted,
      executionIdempotentNoDuplicateTake:
        artifact.execution.idempotentNoDuplicateTake,
      executionShutdownCleanOnSigterm:
        artifact.execution.shutdownCleanOnSigterm,
      dryRunLoopedMultipleCycles: artifact.dryRun.loopedMultipleCycles,
      dryRunSubmittedNoTransactions: artifact.dryRun.submittedNoTransactions,
      dryRunShutdownCleanOnSigterm: artifact.dryRun.shutdownCleanOnSigterm,
      gasSpikeLoopedMultipleCycles: artifact.gasSpike.loopedMultipleCycles,
      gasSpikeDiscoveredViaSubgraph: artifact.gasSpike.discoveredViaSubgraph,
      gasSpikeSubmittedNoTransactions: artifact.gasSpike.submittedNoTransactions,
      gasSpikeShutdownCleanOnSigterm: artifact.gasSpike.shutdownCleanOnSigterm,
    })) {
      requireNoSpendInvariant(value === true, `daemon lifecycle ${field}`);
    }
    return artifact;
  } finally {
    await subgraph.close();
  }
}

// Build a manual-take PoolConfig entry for the precedence pool. A POOL-reference
// price derives the market price from the pool's own LUP on the fork (no
// external API, no spend) — the same family of price the discovery defaults
// resolve. The take settings mirror the discovery `direct_dex` path so the
// manual loop and discovery exercise the same shared takers/dex config.
// Fork-validated (manual pool taken via the manual loop; see
// docs/multi-pool-enumeration-scenario.md).
function buildManualPoolConfig(summary) {
  return {
    address: summary.pool.address,
    price: { source: 'pool', reference: 'lup' },
    take: {
      liquiditySource: 2, // UNISWAPV3
      marketPriceFactor: 0.98,
      minCollateral: 0.01,
      allowedExternalTakePaths: ['direct_dex'],
      defaultDirectDexLiquiditySource: 2,
      allowedLiquiditySources: [2],
      externalTakeRouteSelectionMode: 'maximize_profit',
      hybridGasQuoteFailureFallbackMode: 'disabled',
    },
  };
}

/**
 * Multi-pool enumeration scenario (the fidelity complement to the single-auction
 * lifecycle leg). Proves the REAL persistent keeper enumerates auctions across
 * SEVERAL pools via the real chainwide subgraph query, ranks/acts on all of the
 * DISCOVERED pools, and that a pool placed under `manual.pools` is handled by the
 * manual loop and SKIPPED by discovery (manual-take precedence).
 *
 * Inputs (params):
 *   - discoveredSummaries: fixture summaries for pools discovery should take
 *   - manualSummary:       one fixture summary for the manual-precedence pool
 *   - rpcUrl, tempDir, allowedHosts, egressReportPath
 *
 * PREREQUISITE: all summaries MUST share ONE deployed KeeperTakerRouter + taker
 * set + dex router, because the keeper config has a single `takers`/`dex` block.
 * The fixture multiplication driver (buildMultipoolFixtures) deploys once and
 * reuses those addresses across every pool. discoveredSummaries[0] supplies the
 * shared deployment/router config here. Fork-validated for direct_dex (see
 * docs/multi-pool-enumeration-scenario.md).
 */
export async function runDaemonMultipool(params) {
  const discoveredSummaries = params.discoveredSummaries ?? [];
  const manualSummary = params.manualSummary;
  if (discoveredSummaries.length < 1 || !manualSummary) {
    throw new Error(
      'runDaemonMultipool requires >=1 discoveredSummaries and a manualSummary'
    );
  }
  const discoveredCount = discoveredSummaries.length;
  const totalAuctions = discoveredCount + 1; // discovered + the manual pool
  // The chainwide enumeration is a real query of ALL unsettled auctions, so the
  // stub serves every pool's auction (including the manual one). Discovery then
  // SKIPS the manual pool; the manual loop owns it.
  const allSummaries = [...discoveredSummaries, manualSummary];

  const subgraph = await startFixtureSubgraphStub({
    summaries: allSummaries,
    rpcUrl: params.rpcUrl,
  });
  try {
    const { passwordPath, keystorePath, wallet } = await setupDaemonKeystore(
      params.tempDir
    );
    const configPath = path.join(
      params.tempDir,
      'daemon-multipool-execution-config.json'
    );
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        buildDaemonConfig({
          summary: discoveredSummaries[0], // shared deployment/router/weth
          rpcUrl: params.rpcUrl,
          subgraphUrl: subgraph.url,
          keystorePath,
          dryRun: false,
          allowPools: discoveredSummaries.map((s) => s.pool.address),
          manualPools: [buildManualPoolConfig(manualSummary)],
        }),
        null,
        2
      )}\n`
    );
    const env = daemonChildEnv({
      allowedHosts: params.allowedHosts,
      egressReportPath: params.egressReportPath,
      passwordFile: passwordPath,
    });

    const snapshot = await requestJsonRpc(params.rpcUrl, 'evm_snapshot');
    await warpLocalTakeWindow(params.rpcUrl);
    const startBlock = await readBlockNumber(params.rpcUrl);
    const execution = await spawnPersistentDaemon({
      configPath,
      env,
      logPath: path.join(params.tempDir, 'daemon-multipool-execution.log'),
      rpcUrl: params.rpcUrl,
      keeperAddress: wallet.address,
      startBlock,
      pollIntervalMs: 1_500,
      maxWatchMs: 180_000,
      graceMs: 20_000,
      // Done once it has looped >=2 cycles, taken at least the discovered pools,
      // and the tx count has stabilized (idempotent re-entry without re-taking).
      isDone: (s) =>
        s.cycles >= 2 && s.txCount >= discoveredCount && s.stablePolls >= 2,
    });
    await requestJsonRpc(params.rpcUrl, 'evm_revert', [snapshot]);

    const num = (value) => Number(value ?? 0);
    const artifact = {
      enabled: true,
      subgraphUrl: subgraph.url,
      discoveredPoolCount: discoveredCount,
      manualPool: manualSummary.pool.address,
      cyclesObserved: execution.cyclesObserved,
      loopedMultipleCycles: execution.cyclesObserved >= 2,
      // Real enumeration saw EVERY pool's auction (discovered + manual), not one.
      enumeratedAllPools: execution.summaries.some(
        (s) => num(s.auctionCount) >= totalAuctions
      ),
      // Discovery produced a target for each discovered pool...
      discoveredAllPools: execution.summaries.some(
        (s) => num(s.discoveredTargets) >= discoveredCount
      ),
      // ...the manual pool was a MANUAL target (handled by the manual loop)...
      manualPoolHandledByManualLoop: execution.summaries.some(
        (s) => num(s.manualTargets) >= 1
      ),
      // ...and NEVER leaked into discovery (precedence): discoveredTargets never
      // exceeds the discovered-pool count in any cycle.
      manualPrecedenceHeld: execution.summaries.every(
        (s) => num(s.discoveredTargets) <= discoveredCount
      ),
      allDiscoveredTaken:
        execution.txCount >= discoveredCount &&
        execution.summaries.some((s) => num(s.targetSuccesses) >= discoveredCount),
      takeTxCount: execution.txCount,
      idempotentNoDuplicateTake: execution.reachedDone,
      shutdownCleanOnSigterm:
        execution.shutdownClean && execution.sigtermHandled,
      exit: execution.exit,
      logPath: execution.logPath,
    };

    for (const [field, value] of Object.entries({
      multipoolLoopedMultipleCycles: artifact.loopedMultipleCycles,
      multipoolEnumeratedAllPools: artifact.enumeratedAllPools,
      multipoolDiscoveredAllPools: artifact.discoveredAllPools,
      multipoolManualHandledByManualLoop: artifact.manualPoolHandledByManualLoop,
      multipoolManualPrecedenceHeld: artifact.manualPrecedenceHeld,
      multipoolAllDiscoveredTaken: artifact.allDiscoveredTaken,
      multipoolIdempotentNoDuplicateTake: artifact.idempotentNoDuplicateTake,
      multipoolShutdownCleanOnSigterm: artifact.shutdownCleanOnSigterm,
    })) {
      requireNoSpendInvariant(value === true, `daemon multipool ${field}`);
    }
    return artifact;
  } finally {
    await subgraph.close();
  }
}

const FUND_ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

/**
 * Aggregator-in-daemon scenario: proves the REAL persistent keeper takes via the
 * calldata_aggregator (LI.FI) path — not direct_dex — when spawned from the
 * harness daemon entry (which installs the env-gated quote injector). Production
 * src/index.ts never installs the injector, so this is the only way a spawned
 * daemon can exercise the aggregator path; the seam stays inert in production.
 *
 * Funding lives here (not in the entry) because the quote-rich account is the
 * fixture keeper, not the daemon keystore wallet: we fund the MockLifiSwapTarget
 * with quote and size the per-take payout, then pass the payout to the entry via
 * AJNA_AGENT_HARNESS_AGGREGATOR_PAYOUT_RAW.
 */
export async function runDaemonAggregator(params) {
  // Single-pool (params.summary) or multipool (params.summaries, all sharing one
  // deployment). Multipool joins the two flagship scenarios: the real daemon
  // enumerates SEVERAL pools and takes each via the calldata_aggregator path.
  // params.provider selects LI.FI (default) or Sushi.
  const providerKey = params.provider ?? 'lifi';
  const provider = AGGREGATOR_PROVIDERS[providerKey];
  if (!provider) {
    throw new Error(`Unknown aggregator provider: ${providerKey}`);
  }
  const summaries = params.summaries ?? [params.summary];
  const primary = summaries[0];
  const expectedTakes = summaries.length;
  const deployment = primary.uniswapV3ExternalTake?.deployment;
  const aggTaker = (deployment?.aggregatorTakers ?? []).find(
    (taker) => taker.key === provider.takerKey
  );
  if (!aggTaker) {
    throw new Error(
      `runDaemonAggregator requires a fixture with the ${provider.takerKey} aggregator taker deployed`
    );
  }

  // Fund the shared MockLifiSwapTarget with EACH pool's quote token (multipool
  // pools deploy distinct quote tokens), from the fixture keeper. Size the
  // per-take payout from the primary pool's balance (fixtures share a profile,
  // so one value exceeds every pool's amount-due; mirrors the harness tiering).
  const rpcProvider = new providers.JsonRpcProvider(params.rpcUrl);
  const keeper = new Wallet(HARDHAT_DEFAULT_KEEPER_KEY, rpcProvider);
  const targets = Array.from(
    new Set(
      (deployment.aggregatorTakers ?? []).map((taker) => taker.targetAddress)
    )
  );
  let primaryQuoteBalance;
  for (let i = 0; i < summaries.length; i += 1) {
    const quote = new Contract(
      summaries[i].quoteToken.deployedAddress,
      FUND_ERC20_ABI,
      keeper
    );
    const balance = await quote.balanceOf(keeper.address);
    if (i === 0) primaryQuoteBalance = balance;
    for (const target of targets) {
      await (
        await quote.transfer(target, balance.mul(9).div(10).div(targets.length))
      ).wait();
    }
  }
  const payoutRaw = primaryQuoteBalance.div(20).toString();

  const subgraph = await startFixtureSubgraphStub({
    summaries,
    rpcUrl: params.rpcUrl,
  });
  try {
    const { passwordPath, keystorePath, wallet } = await setupDaemonKeystore(
      params.tempDir
    );
    const configPath = path.join(
      params.tempDir,
      'daemon-aggregator-execution-config.json'
    );
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        buildAggregatorDaemonConfig({
          summary: primary,
          provider: providerKey,
          allowPools: summaries.map((s) => s.pool.address),
          rpcUrl: params.rpcUrl,
          subgraphUrl: subgraph.url,
          keystorePath,
          dryRun: false,
        }),
        null,
        2
      )}\n`
    );
    const env = {
      ...daemonChildEnv({
        allowedHosts: params.allowedHosts,
        egressReportPath: params.egressReportPath,
        passwordFile: passwordPath,
      }),
      AJNA_AGENT_HARNESS_AGGREGATOR_PAYOUT_RAW: payoutRaw,
    };

    const snapshot = await requestJsonRpc(params.rpcUrl, 'evm_snapshot');
    await warpLocalTakeWindow(params.rpcUrl);
    const startBlock = await readBlockNumber(params.rpcUrl);
    const execution = await spawnPersistentDaemon({
      // Spawn the HARNESS entry (installs the injector), not src/index.ts.
      scriptPath: 'scripts/no-spend/daemon-harness-entry.ts',
      extraArgs: ['--fixture-summary', params.summaryPath],
      configPath,
      env,
      logPath: path.join(params.tempDir, 'daemon-aggregator-execution.log'),
      rpcUrl: params.rpcUrl,
      keeperAddress: wallet.address,
      startBlock,
      pollIntervalMs: 1_500,
      maxWatchMs: expectedTakes > 1 ? 240_000 : 150_000,
      graceMs: 20_000,
      isDone: (s) =>
        s.cycles >= 2 && s.txCount >= expectedTakes && s.stablePolls >= 2,
    });
    await requestJsonRpc(params.rpcUrl, 'evm_revert', [snapshot]);

    const num = (value) => Number(value ?? 0);
    const artifact = {
      enabled: true,
      subgraphUrl: subgraph.url,
      provider: providerKey,
      poolCount: expectedTakes,
      mockTarget: aggTaker.targetAddress,
      taker: aggTaker.takerAddress,
      payoutRaw,
      cyclesObserved: execution.cyclesObserved,
      loopedMultipleCycles: execution.cyclesObserved >= 2,
      // Every allowed pool was discovered via the real chainwide enumeration...
      discoveredAllPools: execution.summaries.some(
        (s) => num(s.discoveredTargets) >= expectedTakes
      ),
      // ...and taken. The config allows ONLY calldata_aggregator, so every
      // success IS an aggregator take — proving the LI.FI path across N pools.
      tookAllViaAggregator:
        execution.txCount >= expectedTakes &&
        execution.summaries.some((s) => num(s.targetSuccesses) >= expectedTakes),
      takeTxCount: execution.txCount,
      idempotentNoDuplicateTake: execution.reachedDone,
      shutdownCleanOnSigterm:
        execution.shutdownClean && execution.sigtermHandled,
      exit: execution.exit,
      logPath: execution.logPath,
    };

    for (const [field, value] of Object.entries({
      aggregatorLoopedMultipleCycles: artifact.loopedMultipleCycles,
      aggregatorDiscoveredAllPools: artifact.discoveredAllPools,
      aggregatorTookAllViaAggregator: artifact.tookAllViaAggregator,
      aggregatorIdempotentNoDuplicateTake: artifact.idempotentNoDuplicateTake,
      aggregatorShutdownCleanOnSigterm: artifact.shutdownCleanOnSigterm,
    })) {
      requireNoSpendInvariant(value === true, `daemon aggregator ${field}`);
    }
    return artifact;
  } finally {
    await subgraph.close();
  }
}

/**
 * Subgraph-failover-in-daemon scenario: the PRIMARY subgraph endpoint is down
 * (the stub 503s the primary path), so the real persistent keeper must fail over
 * to the configured fallbackUrls and keep discovering + taking. Closes the
 * "fallbackUrls failover is only unit-tested" gap end-to-end. Functional proof:
 * with the primary permanently 503, discovery could only have succeeded via the
 * fallback; corroborated by the `subgraph failover:` log marker.
 */
export async function runDaemonFailover(params) {
  const subgraph = await startFixtureSubgraphStub({
    summary: params.summary,
    rpcUrl: params.rpcUrl,
    failPrimary: true,
  });
  try {
    const { passwordPath, keystorePath, wallet } = await setupDaemonKeystore(
      params.tempDir
    );
    const configPath = path.join(
      params.tempDir,
      'daemon-failover-execution-config.json'
    );
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        buildDaemonConfig({
          summary: params.summary,
          rpcUrl: params.rpcUrl,
          subgraphUrl: subgraph.url,
          keystorePath,
          dryRun: false,
        }),
        null,
        2
      )}\n`
    );
    const env = daemonChildEnv({
      allowedHosts: params.allowedHosts,
      egressReportPath: params.egressReportPath,
      passwordFile: passwordPath,
    });

    const snapshot = await requestJsonRpc(params.rpcUrl, 'evm_snapshot');
    await warpLocalTakeWindow(params.rpcUrl);
    const startBlock = await readBlockNumber(params.rpcUrl);
    const execution = await spawnPersistentDaemon({
      configPath,
      env,
      logPath: path.join(params.tempDir, 'daemon-failover-execution.log'),
      rpcUrl: params.rpcUrl,
      keeperAddress: wallet.address,
      startBlock,
      pollIntervalMs: 1_500,
      maxWatchMs: 150_000,
      graceMs: 20_000,
      isDone: (s) => s.cycles >= 2 && s.txCount >= 1 && s.stablePolls >= 2,
    });
    await requestJsonRpc(params.rpcUrl, 'evm_revert', [snapshot]);

    const num = (value) => Number(value ?? 0);
    // Corroborating proof that the keeper actually failed over (the primary is
    // permanently down, so discovery succeeding already implies the fallback).
    const logText = fs.readFileSync(execution.logPath, 'utf8');
    const usedFallbackEndpoint = logText.includes('subgraph failover:');

    const artifact = {
      enabled: true,
      subgraphUrl: subgraph.url,
      cyclesObserved: execution.cyclesObserved,
      loopedMultipleCycles: execution.cyclesObserved >= 2,
      usedFallbackEndpoint,
      // Discovered + took DESPITE the primary subgraph being permanently 503.
      discoveredViaFallback: execution.summaries.some(
        (s) => num(s.discoveredTargets) >= 1
      ),
      tookViaFallback:
        execution.txCount >= 1 &&
        execution.summaries.some((s) => num(s.targetSuccesses) >= 1),
      takeTxCount: execution.txCount,
      idempotentNoDuplicateTake: execution.reachedDone,
      shutdownCleanOnSigterm:
        execution.shutdownClean && execution.sigtermHandled,
      exit: execution.exit,
      logPath: execution.logPath,
    };

    for (const [field, value] of Object.entries({
      failoverLoopedMultipleCycles: artifact.loopedMultipleCycles,
      failoverUsedFallbackEndpoint: artifact.usedFallbackEndpoint,
      failoverDiscoveredViaFallback: artifact.discoveredViaFallback,
      failoverTookViaFallback: artifact.tookViaFallback,
      failoverIdempotentNoDuplicateTake: artifact.idempotentNoDuplicateTake,
      failoverShutdownCleanOnSigterm: artifact.shutdownCleanOnSigterm,
    })) {
      requireNoSpendInvariant(value === true, `daemon failover ${field}`);
    }
    return artifact;
  } finally {
    await subgraph.close();
  }
}
