#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import {
  ROOT,
  assertLocalRpcUrl,
  baseChildEnv,
  getAllowedHostList,
  getFreePort,
  isLocalhostUrl,
  readJson,
  readTail,
  redactUrlForReport,
  requestJsonRpc,
  resolveForkBlock,
  resolveForkRpcUrl,
  runNodeScript,
} from './no-spend/runtime.mjs';
import {
  assertEgressReport,
  runNoEgressRequirePositiveControl,
  withNoEgressGuard,
} from './no-spend/egress.mjs';
import { runDaemonSmoke } from './no-spend/daemon-smoke.mjs';
import {
  buildReplayCommand,
  buildStateIntegrityArtifact,
} from './no-spend/report-artifacts.mjs';

const HARDHAT_DEFAULT_KEEPER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HARDHAT_BIN = path.join(
  ROOT,
  'node_modules',
  'hardhat',
  'internal',
  'cli',
  'bootstrap.js'
);
const DEFAULT_RPC_TIMEOUT_MS = 120_000;
// Pin to a known-warm Base block instead of `latest`. Forking at the moving tip
// leaves Alchemy's upstream state cache cold, so the first `eth_estimateGas`
// during fixture creation triggers a slow lazy-state fetch and times out. 30M is
// the same block `hardhat.config.ts` defaults the Base fork to (and that the
// base-fork integration tests use), so the Ajna ERC20PoolFactory + Uniswap V3
// infra the synthetic fixture needs is present and the state is warm/cacheable.
// Override with --base-fork-block / BASE_FORK_BLOCK / AJNA_AGENT_NO_SPEND_BASE_FORK_BLOCK.
const DEFAULT_BASE_FORK_BLOCK = '30000000';
// Hard ceiling for the fixture-creation child (runNodeScript otherwise resolves
// only on `close`, so a hung cold call would block indefinitely). This is a
// backstop against a true hang, not a perf target: the FIRST run against a
// never-fetched pinned block pays the full upstream lazy-state cost (observed
// multiple minutes) before Alchemy caches it; warm subsequent runs finish in
// ~1 min. The default is generous so a cold first run completes; override via
// AJNA_AGENT_NO_SPEND_FIXTURE_TIMEOUT_MS in a colder/CI environment.
const FIXTURE_CREATION_TIMEOUT_MS = Number(
  process.env.AJNA_AGENT_NO_SPEND_FIXTURE_TIMEOUT_MS ?? 600_000
);

let hardhatNode;

function usage() {
  return `Usage: node scripts/run-no-spend-validation.mjs [--port N] [--base-fork-block N|latest] [--scenario NAME] [--mode discovery|manual] [--expect success|skip] [--dry-run-only] [--hybrid-gas-quote-fallback disabled|direct_dex_first] [--run-config-smoke] [--run-daemon-smoke] [--daemon-smoke-only] [--expected-fee-tier N] [--output /path/report.json]

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
      'direct_dex_first',
    runConfigSmoke: process.env.AJNA_AGENT_NO_SPEND_CONFIG_SMOKE === '1',
    runDaemonSmoke: process.env.AJNA_AGENT_NO_SPEND_DAEMON_SMOKE === '1',
    daemonSmokeOnly: process.env.AJNA_AGENT_NO_SPEND_DAEMON_SMOKE_ONLY === '1',
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
    (!/^\d+$/.test(options.baseForkBlock) || Number(options.baseForkBlock) <= 0)
  ) {
    throw new Error('--base-fork-block must be a positive integer or latest');
  }
  if (options.harnessMode !== 'discovery' && options.harnessMode !== 'manual') {
    throw new Error('--mode must be discovery or manual');
  }
  if (
    options.expectedResult !== 'success' &&
    options.expectedResult !== 'skip'
  ) {
    throw new Error('--expect must be success or skip');
  }
  if (
    options.hybridGasQuoteFallback !== 'disabled' &&
    options.hybridGasQuoteFallback !== 'direct_dex_first'
  ) {
    throw new Error(
      '--hybrid-gas-quote-fallback must be disabled or direct_dex_first'
    );
  }
  if (
    options.expectedFeeTier !== undefined &&
    (!Number.isInteger(options.expectedFeeTier) || options.expectedFeeTier <= 0)
  ) {
    throw new Error('--expected-fee-tier must be a positive integer');
  }
  if (options.dryRunOnly && options.expectedResult === 'success') {
    throw new Error('--dry-run-only requires --expect skip');
  }

  return options;
}

function startHardhatNode(params) {
  const logStream = fs.createWriteStream(params.logPath, { flags: 'a' });
  const nodeEnv = withNoEgressGuard(
    baseChildEnv({
      FORK_NETWORK: 'base',
      HARDHAT_CHAIN_ID: '8453',
      BASE_FORK_BLOCK: String(params.resolvedForkBlockNumber),
      AJNA_AGENT_RPC_URL: params.forkRpcUrl,
      AJNA_RPC_URL_BASE: params.forkRpcUrl,
      BASE_RPC_URL: params.forkRpcUrl,
    }),
    {
      allowedHosts: params.allowedHosts,
      reportPath: params.egressReportPath,
    }
  );

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
      const chainId = await requestJsonRpc(
        params.rpcUrl,
        'eth_chainId',
        [],
        1_000
      );
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
    ['deployed', 'reused'].includes(summary.stages?.deployExternalTake?.mode),
    'external-take router/taker deployed or reused'
  );
  requireInvariant(
    ['kicked', 'already_active'].includes(summary.finalKick?.status),
    'final kick status is kicked or already_active'
  );
  requireInvariant(
    summary.uniswapV3ExternalTake?.routeShapeVerification?.status === 'passed',
    'route-shape verification passed'
  );
  requireInvariant(
    typeof summary.uniswapV3ExternalTake?.deployment?.keeperTakerRouter ===
      'string',
    'keeper taker router address recorded'
  );
  requireInvariant(
    typeof summary.uniswapV3ExternalTake?.deployment?.uniswapV3Taker ===
      'string',
    'Uniswap V3 taker address recorded'
  );
}

function assertEnvArtifact(report, label) {
  requireInvariant(
    report.transportArtifact?.noEgressGuardEnabled === true,
    `${label} no-egress guard env marker recorded`
  );
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
    const dryRunDirectDexPathTakes = sumPathCounter(
      report,
      'direct_dex',
      'dryRun'
    );
    if (dryRunExternalTakes < 1 || dryRunDirectDexPathTakes < 1) {
      throw new Error(
        `Dry-run did not reach the discovered external-take path. dryRunExternalTakes=${dryRunExternalTakes} directDexDryRuns=${dryRunDirectDexPathTakes}`
      );
    }
  }
  requireInvariant(
    report.routeArtifact?.selectedPath === 'direct_dex',
    'dry-run routeArtifact selected direct_dex path'
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
    const executedDirectDexPathTakes = sumPathCounter(
      report,
      'direct_dex',
      'executed'
    );
    if (executedExternalTakes < 1 || executedDirectDexPathTakes < 1) {
      throw new Error(
        `Execution did not record a direct DEX external take. executedExternalTakes=${executedExternalTakes} directDexExecutions=${executedDirectDexPathTakes}`
      );
    }
  }
  requireInvariant(
    report.routeArtifact?.selectedPath === 'direct_dex',
    'execution routeArtifact selected direct_dex path'
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
    'execution records no direct DEX pre-broadcast or post-submission failures'
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
    executionConfigReturnedTakerContracts:
      artifact.executionConfigReturnedTakerContracts,
    manualDirectDexResolvedThroughExecutionConfig:
      artifact.manualDirectDexResolvedThroughExecutionConfig,
    wrongDeploymentPoolSkipped: artifact.wrongDeploymentPoolSkipped,
    hydrationCooldownRecorded: artifact.hydrationCooldownRecorded,
    hydrationCooldownPreventedRepeat: artifact.hydrationCooldownPreventedRepeat,
  })) {
    requireInvariant(value === true, `config smoke ${field}`);
  }
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
    params.expectedFeeTier ?? process.env.AJNA_AGENT_NO_SPEND_EXPECTED_FEE_TIER;

  const env = withNoEgressGuard(
    baseChildEnv({
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
    }),
    {
      allowedHosts: params.allowedHosts,
      reportPath: params.egressReportPath,
    }
  );

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
  return withNoEgressGuard(
    baseChildEnv({
      ...scenarioEnv,
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
  const { forkRpcUrl, source: forkRpcSource } = resolveForkRpcUrl({
    rejectLocalhost: true,
  });
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

  const egressPositiveControl = await runNoEgressRequirePositiveControl({
    tempDir,
    allowedHosts,
  });

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
      fixtureLogPath,
      FIXTURE_CREATION_TIMEOUT_MS
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
      const egress = assertEgressReport(egressReportPath, 'daemon smoke');
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
        egress,
        egressPositiveControl,
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
    const egress = assertEgressReport(egressReportPath, 'no-spend validation');
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
      egress,
      egressPositiveControl,
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
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`
  );
  process.exitCode = 1;
});
