import fs from 'fs';
import http from 'http';
import path from 'path';
import { Wallet } from 'ethers';
import {
  ROOT,
  baseChildEnv,
  readJson,
  requestJsonRpc,
  runCommandWithTimeout,
  runNodeScript,
} from './runtime.mjs';
import { withNoEgressGuard } from './egress.mjs';

const HARDHAT_DEFAULT_KEEPER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
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

function requireNoSpendInvariant(condition, message) {
  if (!condition) {
    throw new Error(`Missing no-spend invariant: ${message}`);
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
        const latestBlock = await requestJsonRpc(
          params.rpcUrl,
          'eth_getBlockByNumber',
          ['latest', false]
        );
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
          const after = variables.afterId ?? variables.afterBorrower ?? '';
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

export async function runDaemonSmoke(params) {
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
      executionSubmittedTransaction: artifact.executionTransactionsFromKeeper > 0,
      localExecutionCollateralReduced: artifact.localExecutionCollateralReduced,
    })) {
      requireNoSpendInvariant(value === true, `daemon smoke ${field}`);
    }
    return artifact;
  } finally {
    await subgraph.close();
  }
}
