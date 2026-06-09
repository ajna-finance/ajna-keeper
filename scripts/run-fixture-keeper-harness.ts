#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import { AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { Wallet, ethers } from 'ethers';
import { handleDiscoveredTakeTarget } from '../src/discovery/handlers';
import { createDiscoveryRpcCache } from '../src/discovery/rpc-cache';
import type { DiscoveredTakeTargetStats } from '../src/discovery/take-executor';
import type { ResolvedTakeTarget } from '../src/discovery/targets';
import { handleKicks } from '../src/kick';
import { handleTakes } from '../src/take';
import type { DiscoveryReadTransports } from '../src/read-transports';
import {
  LiquiditySource,
  PriceOriginSource,
  configureAjna,
} from '../src/config';
import { getBalanceOfErc20 } from '../src/erc20';
import { isBenignNoLiquidationError } from './no-spend-harness-helpers';
import {
  BASE_AJNA_CONFIG,
  BASE_ONEINCH_ROUTER,
  FIXTURE_SUBGRAPH_SENTINEL_URL,
} from './no-spend/fixture-constants';
import {
  makeFixtureSubgraphReader,
  makeGetLiquidationsFromFixture,
  makeGetLoansFromFixture,
  overrideGetLiquidations,
  overrideGetLoans,
} from './no-spend/fixture-subgraph';
import {
  runConfigLoadedDiscoverySmoke,
  type ConfigArtifact,
} from './no-spend/config-smoke';
import {
  buildBalanceArtifact,
  buildEnvArtifact,
  buildPolicyArtifact,
  buildRouteArtifact,
  buildSkipArtifact,
  buildTransportArtifact,
  collectTransactionArtifact,
  finalizeApprovalChecks,
  hasDebtReducedOrNoCollateralRemaining,
  liquiditySourceLabelsToValues,
  readApprovalChecks,
  serializeDecisionEvent,
  serializeSkipEvent,
  type HarnessReport,
  type PolicyArtifact,
  type RouteDecisionEvent,
  type RouteSkipEvent,
} from './no-spend/harness-artifacts';

type LiquidationStatusSnapshot = {
  collateral: string;
  debtToCover?: string;
  price: string;
};

type FixtureSummary = {
  rpcUrl: string;
  tempDir?: string;
  pool: {
    address: string;
  };
  borrower: {
    owner: string;
    debt?: string;
    collateral?: string;
    neutralPrice: string;
    thresholdPrice: string;
  };
  liquidationCheck: {
    keeperKickEligibleByCurrentCode: boolean;
  };
  uniswapV3ExternalTake?: {
    routerConfig: {
      swapRouter02Address: string;
      poolFactoryAddress: string;
      quoterV2Address: string;
      wethAddress: string;
      defaultFeeTier: number;
      candidateFeeTiers?: number[];
      defaultSlippage: number;
    };
    expectedExecutionFeeTier?: number;
    deployment: {
      keeperTakerFactory: string;
      uniswapV3Taker: string;
    };
  };
  finalKick?: {
    auction?: {
      kickTime?: string;
      neutralPrice?: string;
    };
  };
};

function usage() {
  return `Usage: ts-node scripts/run-fixture-keeper-harness.ts --summary /path/to/fixture-summary.json [--mode manual|discovery] [--hybrid-gas-quote-fallback disabled|factory_first] [--dry-run] [--state-only] [--auto-warp-to-take] [--take-warp-seconds N] [--max-take-warps N]\n\nRequired env:\n- AJNA_AGENT_KEEPER_KEY\n\nOptional env:\n- AJNA_AGENT_HARNESS_OUTPUT_PATH\n`;
}

// Defaults calibrated against the verified 1-day/3-day local-fixture
// profile described in AUTONOMOUS_AGENT_LIQUIDATION_GUIDE.md. 86400s (1
// day) per warp × 3 warps gives a ~3-day window, long enough for the
// auction to cross the take-price threshold on a standard Ajna pool
// without overshooting so far that the fixture's neutral-price
// snapshot becomes stale.
const DEFAULT_TAKE_WARP_SECONDS = 86_400;
const DEFAULT_MAX_TAKE_WARPS = 3;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLocalRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  return (
    code === 'SERVER_ERROR' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    message.includes('ECONNRESET') ||
    message.includes('ECONNREFUSED') ||
    message.includes('missing response') ||
    message.includes('socket hang up')
  );
}

async function sendLocalEvmControl(
  provider: ethers.providers.JsonRpcProvider,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await provider.send(method, params);
    } catch (error) {
      lastError = error;
      if (!isRetryableLocalRpcError(error) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

function parseArgs(argv: string[]) {
  let summaryPath: string | undefined;
  let mode: 'manual' | 'discovery' = 'manual';
  let hybridGasQuoteFailureFallbackMode: 'disabled' | 'factory_first' =
    'disabled';
  let dryRun = false;
  let stateOnly = false;
  let autoWarpToTake = false;
  let takeWarpSeconds = DEFAULT_TAKE_WARP_SECONDS;
  let maxTakeWarps = DEFAULT_MAX_TAKE_WARPS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary') {
      summaryPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--mode') {
      const value = argv[i + 1];
      if (value !== 'manual' && value !== 'discovery') {
        throw new Error('--mode must be manual or discovery');
      }
      mode = value;
      i += 1;
      continue;
    }
    if (arg === '--hybrid-gas-quote-fallback') {
      const value = argv[i + 1];
      if (value !== 'disabled' && value !== 'factory_first') {
        throw new Error(
          '--hybrid-gas-quote-fallback must be disabled or factory_first'
        );
      }
      hybridGasQuoteFailureFallbackMode = value;
      i += 1;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--state-only') {
      stateOnly = true;
      continue;
    }
    if (arg === '--auto-warp-to-take') {
      autoWarpToTake = true;
      continue;
    }
    if (arg === '--take-warp-seconds') {
      takeWarpSeconds = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--max-take-warps') {
      maxTakeWarps = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
  }

  if (!summaryPath) {
    throw new Error('Missing --summary /path/to/fixture-summary.json');
  }
  if (!Number.isFinite(takeWarpSeconds) || takeWarpSeconds < 0) {
    throw new Error('--take-warp-seconds must be a non-negative number');
  }
  if (!Number.isFinite(maxTakeWarps) || maxTakeWarps < 0) {
    throw new Error('--max-take-warps must be a non-negative number');
  }

  return {
    summaryPath: path.resolve(summaryPath),
    mode,
    hybridGasQuoteFailureFallbackMode,
    dryRun,
    stateOnly,
    autoWarpToTake,
    takeWarpSeconds,
    maxTakeWarps,
  };
}

function scrubUnexpectedHarnessSecretEnv(): void {
  const allowed = new Set(['AJNA_AGENT_KEEPER_KEY']);
  for (const name of Object.keys(process.env)) {
    if (/KEY|TOKEN|PASSWORD|SECRET/i.test(name) && !allowed.has(name)) {
      delete process.env[name];
    }
  }
}

async function getLiquidationStatus(
  pool: FungiblePool,
  borrower: string
): Promise<LiquidationStatusSnapshot> {
  const liquidation = await pool.getLiquidation(borrower);
  const status = await liquidation.getStatus();
  const maybeDebtToCover = (status as any).debtToCover;
  const result: LiquidationStatusSnapshot = {
    collateral: status.collateral.toString(),
    price: status.price.toString(),
  };
  if (maybeDebtToCover !== undefined) {
    result.debtToCover = maybeDebtToCover.toString();
  }
  return result;
}

async function tryGetLiquidationStatus(
  pool: FungiblePool,
  borrower: string,
  context: string
): Promise<Awaited<ReturnType<typeof getLiquidationStatus>> | undefined> {
  try {
    return await getLiquidationStatus(pool, borrower);
  } catch (error) {
    if (isBenignNoLiquidationError(error)) return undefined;
    process.stderr.write(
      `[harness] ${context}: getLiquidationStatus failed with a non-benign error; ` +
        `surfacing the raw error. Underlying: ${
          error instanceof Error ? error.message : String(error)
        }\n`
    );
    throw error;
  }
}

async function buildDiscoveredTakeTarget(params: {
  pool: FungiblePool;
  summary: FixtureSummary;
  dryRun: boolean;
  liquidationStatus?: Awaited<ReturnType<typeof getLiquidationStatus>> | null;
}): Promise<ResolvedTakeTarget> {
  const { pool, summary, dryRun, liquidationStatus } = params;
  const debt = liquidationStatus?.debtToCover ?? summary.borrower.debt ?? '0';
  const collateral =
    liquidationStatus?.collateral ?? summary.borrower.collateral ?? '0';
  const kickTime = Number(summary.finalKick?.auction?.kickTime ?? 0);

  return {
    source: 'discovered',
    poolAddress: summary.pool.address,
    name: 'Local Fixture Pool',
    dryRun,
    take: {
      minCollateral: 0.01,
      liquiditySource: LiquiditySource.UNISWAPV3,
      marketPriceFactor: 0.98,
    },
    candidates: [
      {
        poolAddress: pool.poolAddress,
        borrower: summary.borrower.owner,
        kickTime: Number.isFinite(kickTime) ? kickTime : 0,
        debtRemaining: debt,
        collateralRemaining: collateral,
        neutralPrice:
          summary.finalKick?.auction?.neutralPrice ??
          summary.borrower.neutralPrice,
        debt,
        collateral,
        heuristicScore: 0,
      },
    ],
  };
}

async function runDiscoveredTakeAttempt(params: {
  pool: FungiblePool;
  summary: FixtureSummary;
  keeper: Wallet;
  provider: ethers.providers.JsonRpcProvider;
  dryRun: boolean;
  hybridGasQuoteFailureFallbackMode: 'disabled' | 'factory_first';
  policyArtifact: PolicyArtifact;
  liquidationStatus?: Awaited<ReturnType<typeof getLiquidationStatus>> | null;
  routeDecisionEvents: RouteDecisionEvent[];
  routeSkipEvents: RouteSkipEvent[];
  targetOverride?: ResolvedTakeTarget;
}): Promise<{
  stats: DiscoveredTakeTargetStats;
  rpcCacheStats?: Record<string, unknown>;
}> {
  const { pool, summary, keeper, provider } = params;
  const uniswapV3ExternalTake = summary.uniswapV3ExternalTake;
  if (!uniswapV3ExternalTake) {
    throw new Error('Fixture summary missing uniswapV3ExternalTake');
  }

  const readRpc = {
    getGasPrice() {
      return provider.getGasPrice();
    },
  };
  const transports: DiscoveryReadTransports = {
    subgraph: makeFixtureSubgraphReader(pool, summary.borrower.owner),
    readRpc,
  };
  const rpcCache = await createDiscoveryRpcCache({
    signer: keeper,
    readRpc,
    includeFactoryQuoteProviders: true,
  });
  if (rpcCache) {
    const cooldownUntilMs = Date.now() + 60 * 60 * 1000;
    rpcCache.oneInchQuoteCircuits = {
      route_quote: { failures: 99, cooldownUntilMs },
      gas_conversion: { failures: 99, cooldownUntilMs },
      swap_data: { failures: 99, cooldownUntilMs },
    };
    rpcCache.oneInchQuoteCircuit = rpcCache.oneInchQuoteCircuits.route_quote;
  }

  const stats = await handleDiscoveredTakeTarget({
    pool,
    signer: keeper,
    target:
      params.targetOverride ??
      (await buildDiscoveredTakeTarget({
        pool,
        summary,
        dryRun: params.dryRun,
        liquidationStatus: params.liquidationStatus,
      })),
    transports,
    rpcCache,
    config: {
      dryRun: params.dryRun,
      autoDiscover: {
        enabled: true,
        logSkips: true,
        take: {
          enabled: true,
          allowedExternalTakePaths:
            params.policyArtifact.allowedExternalTakePaths,
          defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          allowedLiquiditySources: liquiditySourceLabelsToValues(
            params.policyArtifact.allowedLiquiditySources
          ),
          externalTakeRouteSelectionMode:
            params.policyArtifact.externalTakeRouteSelectionMode,
          hybridGasQuoteFailureFallbackMode:
            params.hybridGasQuoteFailureFallbackMode,
          maxGasCostNative: params.policyArtifact.maxGasCostNative,
          minExpectedProfitQuote:
            params.policyArtifact.minExpectedProfitQuote,
          oneInchQuoteTimeoutMs: 25,
          externalTakeProbeTimeoutMs: 1000,
          maxConcurrentCandidateEvaluations:
            params.policyArtifact.maxConcurrentCandidateEvaluations,
          maxInFlightRouteProbes:
            params.policyArtifact.maxInFlightRouteProbes,
          maxExecutionsPerPoolPerRun:
            params.policyArtifact.maxExecutionsPerPoolPerRun,
          takeRouteQuoteBudgetPerCandidate:
            params.policyArtifact.takeRouteQuoteBudgetPerCandidate,
          takeQuoteBudgetPerRun: params.policyArtifact.takeQuoteBudgetPerRun,
        },
      },
      keeperTaker: uniswapV3ExternalTake.deployment.uniswapV3Taker,
      keeperTakerFactory: uniswapV3ExternalTake.deployment.keeperTakerFactory,
      uniswapV3RouterOverrides: uniswapV3ExternalTake.routerConfig,
      tokenAddresses: {
        weth: uniswapV3ExternalTake.routerConfig.wethAddress,
      },
      oneInchRouters: {
        8453: BASE_ONEINCH_ROUTER,
      },
      oneInchDefaultSlippage:
        uniswapV3ExternalTake.routerConfig.defaultSlippage,
    },
    onExecutionAttempt: (decision) => {
      params.routeDecisionEvents.push(
        serializeDecisionEvent('attempt', decision)
      );
    },
    onExecuted: ({ decision, executedTake, executedArbTake }) => {
      params.routeDecisionEvents.push(
        serializeDecisionEvent('executed', decision, {
          executedTake,
          executedArbTake,
        })
      );
    },
    onSkip: ({ candidate, stage, reason, decision }) => {
      params.routeSkipEvents.push(
        serializeSkipEvent({
          stage,
          reason,
          poolAddress: candidate.poolAddress,
          borrower: candidate.borrower,
          decision,
        })
      );
    },
  });
  return {
    stats,
    rpcCacheStats: rpcCache?.stats as Record<string, unknown> | undefined,
  };
}

async function main() {
  const {
    summaryPath,
    mode,
    hybridGasQuoteFailureFallbackMode,
    dryRun,
    stateOnly,
    autoWarpToTake,
    takeWarpSeconds,
    maxTakeWarps,
  } = parseArgs(process.argv.slice(2));
  const keeperKey = process.env.AJNA_AGENT_KEEPER_KEY;
  if (!keeperKey) {
    throw new Error('Missing AJNA_AGENT_KEEPER_KEY');
  }
  scrubUnexpectedHarnessSecretEnv();

  const summary = JSON.parse(
    fs.readFileSync(summaryPath, 'utf8')
  ) as FixtureSummary;
  if (!summary.uniswapV3ExternalTake) {
    throw new Error(
      'Fixture summary does not include uniswapV3ExternalTake. Run the fixture with --with-uniswap-v3-external-take first.'
    );
  }

  configureAjna(BASE_AJNA_CONFIG as any);
  const provider = new ethers.providers.JsonRpcProvider(summary.rpcUrl);
  const keeper = new Wallet(keeperKey, provider);
  const ajna = new AjnaSDK(provider);
  const pool = (await ajna.fungiblePoolFactory.getPoolByAddress(
    summary.pool.address
  )) as FungiblePool;

  const derivedKickReferencePrice = Math.max(
    Number(ethers.utils.formatUnits(summary.borrower.neutralPrice, 18)) * 0.9,
    0.000001
  );

  const poolConfig = {
    name: 'Local Fixture Pool',
    address: summary.pool.address,
    price: {
      source: PriceOriginSource.FIXED,
      value: derivedKickReferencePrice,
    },
    kick: {
      enabled: true,
      minDebt: 0.001,
      priceFactor: 0.99,
    },
    take: {
      minCollateral: 0.01,
      liquiditySource: LiquiditySource.UNISWAPV3,
      marketPriceFactor: 0.98,
    },
  } as const;

  const undoLoans = overrideGetLoans(
    makeGetLoansFromFixture(pool, summary.borrower.owner)
  );
  const undoLiquidations = overrideGetLiquidations(
    makeGetLiquidationsFromFixture(pool, summary.borrower.owner)
  );

  try {
    const keeperQuoteBalanceBefore = await getBalanceOfErc20(
      keeper,
      pool.quoteAddress
    );

    const liquidationStatusBeforeKick = await tryGetLiquidationStatus(
      pool,
      summary.borrower.owner,
      'pre-kick status read'
    );
    const policyArtifact = buildPolicyArtifact({
      hybridGasQuoteFailureFallbackMode,
    });

    if (stateOnly) {
      const blockNumber = await provider.getBlockNumber();
      const approvalChecksBefore = await readApprovalChecks({
        provider,
        pool,
        summary,
      });
      const approvalArtifact = await finalizeApprovalChecks({
        provider,
        checks: approvalChecksBefore,
      });
      const routeArtifact = buildRouteArtifact({
        summary,
        mode,
        discoveryStats: [],
        routeDecisionEvents: [],
      });
      const report: HarnessReport = {
        mode,
        hybridGasQuoteFailureFallbackMode:
          mode === 'discovery' ? hybridGasQuoteFailureFallbackMode : undefined,
        summaryPath,
        rpcUrl: summary.rpcUrl,
        borrower: summary.borrower.owner,
        derivedKickReferencePrice,
        keeperKickEligibleBefore:
          summary.liquidationCheck.keeperKickEligibleByCurrentCode,
        keeperQuoteBalanceBefore: keeperQuoteBalanceBefore.toString(),
        keeperQuoteBalanceAfter: keeperQuoteBalanceBefore.toString(),
        kickExecuted: false,
        liquidationStatusAfterKick: liquidationStatusBeforeKick,
        takeExecuted: false,
        liquidationStatusAfterTake: liquidationStatusBeforeKick ?? null,
        collateralReducedByTake: false,
        takeWarpCount: 0,
        takeWarpSecondsPerStep: takeWarpSeconds,
        takeAttempts: 0,
        discoveryStats: mode === 'discovery' ? [] : undefined,
        routeArtifact,
        txArtifact: {
          fromBlockExclusive: blockNumber,
          toBlockInclusive: blockNumber,
          selectedTransportMode: 'public_rpc',
          transactions: [],
        },
        receiptArtifact: null,
        balanceArtifact: buildBalanceArtifact({
          quoteToken: pool.quoteAddress,
          keeper: keeper.address,
          before: keeperQuoteBalanceBefore,
          after: keeperQuoteBalanceBefore,
        }),
        approvalArtifact,
        transportArtifact: buildTransportArtifact(),
        envArtifact: buildEnvArtifact(),
        policyArtifact,
        skipArtifact: buildSkipArtifact({
          discoveryStats: [],
          routeSkipEvents: [],
        }),
        manualArtifact:
          mode === 'manual'
            ? {
                selectedDeploymentFromManualConfig:
                  routeArtifact.factoryRegistryAddress ===
                    summary.uniswapV3ExternalTake.deployment
                      .keeperTakerFactory &&
                  routeArtifact.selectedTakerAddress ===
                    summary.uniswapV3ExternalTake.deployment.uniswapV3Taker,
                lifiNoBroadcastPolicyContextResolved: true,
                lifiNoBroadcastReason:
                  'manual LI.FI canary policy config was built for no-broadcast local validation; fixture mock tokens intentionally do not claim a live LI.FI route',
              }
            : undefined,
        stateArtifact: {
          auctionBeforeTake: liquidationStatusBeforeKick ?? null,
          auctionAfterTake: liquidationStatusBeforeKick ?? null,
          collateralReduced: false,
          debtReducedOrNoCollateralRemaining: false,
          blockBeforeTake: blockNumber,
          blockAfterTake: blockNumber,
        },
      };
      const outputPath = process.env.AJNA_AGENT_HARNESS_OUTPUT_PATH;
      if (outputPath) {
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    await handleKicks({
      pool,
      poolConfig,
      signer: keeper,
      config: {
        dryRun,
        coinGeckoApiKey: '',
        subgraphUrl: FIXTURE_SUBGRAPH_SENTINEL_URL,
        tokenAddresses: {
          weth: summary.uniswapV3ExternalTake.routerConfig.wethAddress,
        },
        ethRpcUrl: summary.rpcUrl,
      },
      chainId: 8453,
    });

    const liquidationStatusAfterKick = await tryGetLiquidationStatus(
      pool,
      summary.borrower.owner,
      'post-kick status read'
    );

    const collateralBeforeTake = liquidationStatusAfterKick?.collateral;
    const blockBeforeTake = await provider.getBlockNumber();
    const approvalChecksBefore = await readApprovalChecks({
      provider,
      pool,
      summary,
    });

    let takeWarpCount = 0;
    let takeAttempts = 0;
    let liquidationStatusAfterTake: HarnessReport['liquidationStatusAfterTake'] =
      liquidationStatusAfterKick ?? null;
    let collateralReducedByTake = false;
    const discoveryStats: DiscoveredTakeTargetStats[] = [];
    const routeDecisionEvents: RouteDecisionEvent[] = [];
    const routeSkipEvents: RouteSkipEvent[] = [];
    let lastRpcCacheStats: Record<string, unknown> | undefined;
    let configArtifact: ConfigArtifact | undefined;
    let configTargetOverride: ResolvedTakeTarget | undefined;
    if (
      mode === 'discovery' &&
      dryRun &&
      process.env.AJNA_AGENT_HARNESS_CONFIG_SMOKE === '1'
    ) {
      const configSmoke = await runConfigLoadedDiscoverySmoke({
        ajna,
        provider,
        pool,
        summary,
        dryRun,
      });
      configArtifact = configSmoke.artifact;
      configTargetOverride = configSmoke.target;
    }

    while (true) {
      takeAttempts += 1;
      if (mode === 'discovery') {
        const attempt = await runDiscoveredTakeAttempt({
            pool,
            summary,
            keeper,
            provider,
            dryRun,
            hybridGasQuoteFailureFallbackMode,
            policyArtifact,
            liquidationStatus: liquidationStatusAfterTake,
            routeDecisionEvents,
            routeSkipEvents,
            targetOverride: configTargetOverride,
          });
        discoveryStats.push(attempt.stats);
        lastRpcCacheStats = attempt.rpcCacheStats;
      } else {
        await handleTakes({
          signer: keeper,
          pool,
          poolConfig,
          config: {
            dryRun,
            subgraphUrl: FIXTURE_SUBGRAPH_SENTINEL_URL,
            keeperTakerFactory:
              summary.uniswapV3ExternalTake.deployment.keeperTakerFactory,
            takerContracts: {
              UniswapV3:
                summary.uniswapV3ExternalTake.deployment.uniswapV3Taker,
            },
            uniswapV3RouterOverrides:
              summary.uniswapV3ExternalTake.routerConfig,
          },
        });
      }

      // Callers downstream distinguish `null` ("no auction right now")
      // from a defined status, so normalize the benign-undefined case
      // from `tryGetLiquidationStatus` back to `null`. Non-benign errors
      // propagate and halt the harness loudly.
      const postTakeStatus = await tryGetLiquidationStatus(
        pool,
        summary.borrower.owner,
        'post-take status read'
      );
      liquidationStatusAfterTake = postTakeStatus ?? null;

      collateralReducedByTake =
        collateralBeforeTake !== undefined &&
        liquidationStatusAfterTake !== null
          ? ethers.BigNumber.from(liquidationStatusAfterTake.collateral).lt(
              ethers.BigNumber.from(collateralBeforeTake)
            )
          : collateralBeforeTake !== undefined &&
            liquidationStatusAfterTake === null;

      if (
        collateralReducedByTake ||
        !autoWarpToTake ||
        takeWarpCount >= maxTakeWarps
      ) {
        break;
      }
      if (liquidationStatusAfterTake === null) {
        break;
      }
      await sendLocalEvmControl(provider, 'evm_increaseTime', [
        takeWarpSeconds,
      ]);
      await sendLocalEvmControl(provider, 'evm_mine', []);
      takeWarpCount += 1;
    }

    const keeperQuoteBalanceAfter = await getBalanceOfErc20(
      keeper,
      pool.quoteAddress
    );
    const blockAfterTake = await provider.getBlockNumber();
    const routeArtifact = buildRouteArtifact({
      summary,
      mode,
      discoveryStats,
      routeDecisionEvents,
    });
    const { txArtifact, receiptArtifact } = await collectTransactionArtifact({
      provider,
      fromBlockExclusive: blockBeforeTake,
      factoryAddress:
        summary.uniswapV3ExternalTake.deployment.keeperTakerFactory,
      keeperAddress: keeper.address,
    });
    const approvalArtifact = await finalizeApprovalChecks({
      provider,
      checks: approvalChecksBefore,
    });
    const balanceArtifact = buildBalanceArtifact({
      quoteToken: pool.quoteAddress,
      keeper: keeper.address,
      before: keeperQuoteBalanceBefore,
      after: keeperQuoteBalanceAfter,
    });

    const report: HarnessReport = {
      mode,
      hybridGasQuoteFailureFallbackMode:
        mode === 'discovery' ? hybridGasQuoteFailureFallbackMode : undefined,
      summaryPath,
      rpcUrl: summary.rpcUrl,
      borrower: summary.borrower.owner,
      derivedKickReferencePrice,
      keeperKickEligibleBefore:
        summary.liquidationCheck.keeperKickEligibleByCurrentCode,
      keeperQuoteBalanceBefore: keeperQuoteBalanceBefore.toString(),
      keeperQuoteBalanceAfter: keeperQuoteBalanceAfter.toString(),
      kickExecuted:
        liquidationStatusBeforeKick?.collateral !== '0' &&
        liquidationStatusBeforeKick !== undefined
          ? false
          : liquidationStatusAfterKick !== undefined &&
            liquidationStatusAfterKick.collateral !== '0',
      liquidationStatusAfterKick,
      takeExecuted: collateralReducedByTake,
      liquidationStatusAfterTake,
      collateralReducedByTake,
      takeWarpCount,
      takeWarpSecondsPerStep: takeWarpSeconds,
      takeAttempts,
      discoveryStats: mode === 'discovery' ? discoveryStats : undefined,
      routeArtifact,
      txArtifact,
      receiptArtifact,
      balanceArtifact,
      approvalArtifact,
      transportArtifact: buildTransportArtifact(),
      envArtifact: buildEnvArtifact(),
      policyArtifact,
      skipArtifact: buildSkipArtifact({
        discoveryStats,
        routeSkipEvents,
        rpcCacheStats: lastRpcCacheStats,
      }),
      configArtifact,
      manualArtifact:
        mode === 'manual'
          ? {
              selectedDeploymentFromManualConfig:
                routeArtifact.factoryRegistryAddress ===
                  summary.uniswapV3ExternalTake.deployment.keeperTakerFactory &&
                routeArtifact.selectedTakerAddress ===
                  summary.uniswapV3ExternalTake.deployment.uniswapV3Taker,
              lifiNoBroadcastPolicyContextResolved: true,
              lifiNoBroadcastReason:
                'manual LI.FI canary policy config was built for no-broadcast local validation; fixture mock tokens intentionally do not claim a live LI.FI route',
            }
          : undefined,
      stateArtifact: {
        auctionBeforeTake: liquidationStatusAfterKick ?? null,
        auctionAfterTake: liquidationStatusAfterTake,
        collateralReduced: collateralReducedByTake,
        debtReducedOrNoCollateralRemaining:
          hasDebtReducedOrNoCollateralRemaining({
          before: liquidationStatusAfterKick,
          after: liquidationStatusAfterTake,
        }),
        blockBeforeTake,
        blockAfterTake,
      },
    };

    const outputPath = process.env.AJNA_AGENT_HARNESS_OUTPUT_PATH;
    if (outputPath) {
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    undoLiquidations();
    undoLoans();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
