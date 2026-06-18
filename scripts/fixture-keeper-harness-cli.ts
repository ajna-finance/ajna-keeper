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
import { handleSettlements } from '../src/settlement';
import { clearSharedSettlementScannerCache } from '../src/settlement/scanner';
import type { DiscoveryReadTransports } from '../src/read-transports';
import {
  LiquiditySource,
  PriceOriginSource,
  configureAjna,
  resolveCalldataAggregatorProviderForSource,
} from '../src/config';
import { getBalanceOfErc20, transferErc20 } from '../src/erc20';
import {
  installAggregatorQuoteInjector,
  type AggregatorQuoteInjector,
} from '../src/take/aggregator-calldata/quote-injection';
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
} from './no-spend/harness-report';

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
      keeperTakerRouter: string;
      uniswapV3Taker: string;
      // P0-2: LI.FI/Sushi/1inch takers + shared MockLifiSwapTarget, registered on
      // the same TakerRouter. P0-3 consumes these to drive the aggregator/hybrid path.
      aggregatorTakers?: Array<{
        key: 'Lifi' | 'SushiAggregator' | 'OneInchAggregator';
        source: number;
        takerAddress: string;
        targetAddress: string;
      }>;
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
  return `Usage: ts-node scripts/run-fixture-keeper-harness.ts --summary /path/to/fixture-summary.json [--mode manual|discovery] [--hybrid-gas-quote-fallback disabled|direct_dex_first] [--dry-run] [--state-only] [--auto-warp-to-take] [--take-warp-seconds N] [--max-take-warps N]\n\nRequired env:\n- AJNA_AGENT_KEEPER_KEY\n\nOptional env:\n- AJNA_AGENT_HARNESS_OUTPUT_PATH\n`;
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
  let hybridGasQuoteFailureFallbackMode: 'disabled' | 'direct_dex_first' =
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
      if (value !== 'disabled' && value !== 'direct_dex_first') {
        throw new Error(
          '--hybrid-gas-quote-fallback must be disabled or direct_dex_first'
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

// P0-2/P0-3: drive a real aggregator calldata-take no-spend. When
// AJNA_AGENT_HARNESS_AGGREGATOR_PROVIDER is set, point the take at the matching
// deployed aggregator taker, pre-fund the shared MockLifiSwapTarget with quote,
// and install the env-gated quote injector so the REAL probe/execution pipeline
// runs against the mock with zero live-API egress.
const AGGREGATOR_PROVIDER_SOURCES = {
  Lifi: LiquiditySource.LIFI,
  SushiAggregator: LiquiditySource.SUSHI_AGGREGATOR,
  OneInchAggregator: LiquiditySource.ONEINCH,
} as const;
type AggregatorProviderKey = keyof typeof AGGREGATOR_PROVIDER_SOURCES;

const MOCK_SWAP_ABI = [
  'function mockSwap(address tokenIn, address tokenOut, address recipient, uint256 amountIn, uint256 amountOut)',
];

interface AggregatorDriveContext {
  providerKey: AggregatorProviderKey;
  liquiditySource: LiquiditySource;
  takerAddress: string;
}

function aggregatorTakerConfigField(
  ctx: AggregatorDriveContext
): Record<string, string> {
  switch (ctx.liquiditySource) {
    case LiquiditySource.LIFI:
      return { lifiTaker: ctx.takerAddress };
    case LiquiditySource.SUSHI_AGGREGATOR:
      return { sushiAggregatorTaker: ctx.takerAddress };
    case LiquiditySource.ONEINCH:
      return { oneInchAggregatorTaker: ctx.takerAddress };
    default:
      return {};
  }
}

async function setupAggregatorInjection(params: {
  summary: FixtureSummary;
  pool: FungiblePool;
  keeper: Wallet;
}): Promise<AggregatorDriveContext | null> {
  const providerKey = process.env.AJNA_AGENT_HARNESS_AGGREGATOR_PROVIDER as
    | AggregatorProviderKey
    | undefined;
  if (!providerKey) {
    return null;
  }
  if (!(providerKey in AGGREGATOR_PROVIDER_SOURCES)) {
    throw new Error(
      `Unknown AJNA_AGENT_HARNESS_AGGREGATOR_PROVIDER="${providerKey}" (expected Lifi|SushiAggregator|OneInchAggregator)`
    );
  }
  const liquiditySource = AGGREGATOR_PROVIDER_SOURCES[providerKey];
  const entry = params.summary.uniswapV3ExternalTake?.deployment?.aggregatorTakers?.find(
    (taker) => taker.key === providerKey
  );
  if (!entry) {
    throw new Error(
      `Fixture summary missing aggregatorTakers entry for ${providerKey} (re-run fixture creation after the P0-2 deploy change)`
    );
  }
  const providerId = resolveCalldataAggregatorProviderForSource(liquiditySource);
  if (!providerId) {
    throw new Error(`No providerId for liquidity source ${liquiditySource}`);
  }

  const collateralAddress = params.pool.collateralAddress;
  const quoteAddress = params.pool.quoteAddress;

  // The mock pays a generous quote amount that clears BOTH the off-chain
  // approvedMinOutRaw floor and the on-chain quoteAmountDueCeiling. The take
  // only owes ~debt-scale quote (fixture debt ~10 quote); excess is harmless
  // kept profit (InsufficientQuoteReceived is a lower bound, so over-paying is
  // safe). Size from the keeper's ACTUAL quote balance (the fixture leaves the
  // keeper a buffer of the supply) and pre-fund the shared mock target: half
  // the balance funds it, each mock payout is a 20th (well above the debt scale
  // and within the buffer for several probe/execution payouts).
  const keeperQuoteBalance = await getBalanceOfErc20(params.keeper, quoteAddress);
  if (keeperQuoteBalance.lte(0)) {
    throw new Error(
      'Keeper holds no quote token to pre-fund the mock aggregator target'
    );
  }
  const premintAmount = keeperQuoteBalance.div(2);
  const mockAmountOut = keeperQuoteBalance.div(20);
  await transferErc20(
    params.keeper,
    quoteAddress,
    entry.targetAddress,
    premintAmount
  );

  const mockSwapInterface = new ethers.utils.Interface(MOCK_SWAP_ABI);
  const selector = mockSwapInterface.getSighash('mockSwap');

  // Enable the env-gated injector (install throws unless this is set). Only
  // reached because AGGREGATOR_PROVIDER is a harness-only env; production keeper
  // configs never set it, so the seam stays inert outside the harness.
  process.env.AJNA_AGENT_HARNESS_AGGREGATOR_QUOTE_MOCK = '1';
  const injector: AggregatorQuoteInjector = ({
    takerAddress,
    chainId,
    collateralInTokenDecimals,
  }) => {
    const callData = mockSwapInterface.encodeFunctionData('mockSwap', [
      collateralAddress,
      quoteAddress,
      takerAddress,
      collateralInTokenDecimals,
      mockAmountOut,
    ]);
    return {
      providerId,
      quotedAtMs: Date.now(),
      chainId,
      srcToken: collateralAddress,
      dstToken: quoteAddress,
      dstReceiver: takerAddress,
      amountInTokenUnits: collateralInTokenDecimals,
      quoteAmountRaw: mockAmountOut,
      routeMinOutRaw: mockAmountOut,
      transactionTarget: entry.targetAddress,
      approvalSpender: entry.targetAddress,
      callData,
      selector,
      txValue: '0',
      routeSummary: { providerId, tool: 'mock-aggregator', feeCosts: [] },
    };
  };
  installAggregatorQuoteInjector(injector);

  process.stdout.write(
    `[harness] aggregator injection active: provider=${providerKey} source=${liquiditySource} taker=${entry.takerAddress} target=${entry.targetAddress}\n`
  );
  return { providerKey, liquiditySource, takerAddress: entry.takerAddress };
}

async function buildDiscoveredTakeTarget(params: {
  pool: FungiblePool;
  summary: FixtureSummary;
  dryRun: boolean;
  liquidationStatus?: Awaited<ReturnType<typeof getLiquidationStatus>> | null;
  liquiditySource?: LiquiditySource;
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
      liquiditySource: params.liquiditySource ?? LiquiditySource.UNISWAPV3,
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
  hybridGasQuoteFailureFallbackMode: 'disabled' | 'direct_dex_first';
  policyArtifact: PolicyArtifact;
  liquidationStatus?: Awaited<ReturnType<typeof getLiquidationStatus>> | null;
  routeDecisionEvents: RouteDecisionEvent[];
  routeSkipEvents: RouteSkipEvent[];
  targetOverride?: ResolvedTakeTarget;
  aggregator?: AggregatorDriveContext | null;
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
    includeDirectDexQuoteProviders: true,
  });
  if (rpcCache && params.aggregator?.liquiditySource !== LiquiditySource.ONEINCH) {
    // Force-disable the live 1inch circuit so the default Uniswap/aggregator
    // path never reaches the 401-keyed 1inch API — UNLESS we are explicitly
    // driving a mock-1inch aggregator take (then the injector serves it).
    const cooldownUntilMs = Date.now() + 60 * 60 * 1000;
    rpcCache.providerCircuits ??= {};
    rpcCache.providerCircuits.oneinch = {
      route_quote: { failures: 99, cooldownUntilMs },
      gas_conversion: { failures: 99, cooldownUntilMs },
      swap_data: { failures: 99, cooldownUntilMs },
    };
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
        liquiditySource: params.aggregator?.liquiditySource,
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
          defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          allowedLiquiditySources: liquiditySourceLabelsToValues(
            params.policyArtifact.allowedLiquiditySources
          ),
          externalTakeRouteSelectionMode:
            params.policyArtifact.externalTakeRouteSelectionMode,
          hybridGasQuoteFailureFallbackMode:
            params.hybridGasQuoteFailureFallbackMode,
          maxGasCostNative: params.policyArtifact.maxGasCostNative,
          minExpectedProfitQuote: params.policyArtifact.minExpectedProfitQuote,
          oneInchQuoteTimeoutMs: 25,
          externalTakeProbeTimeoutMs: 1000,
          maxConcurrentCandidateEvaluations:
            params.policyArtifact.maxConcurrentCandidateEvaluations,
          maxInFlightRouteProbes: params.policyArtifact.maxInFlightRouteProbes,
          maxExecutionsPerPoolPerRun:
            params.policyArtifact.maxExecutionsPerPoolPerRun,
          takeRouteQuoteBudgetPerCandidate:
            params.policyArtifact.takeRouteQuoteBudgetPerCandidate,
          takeQuoteBudgetPerRun: params.policyArtifact.takeQuoteBudgetPerRun,
        },
      },
      keeperTakerRouter: uniswapV3ExternalTake.deployment.keeperTakerRouter,
      ...(params.aggregator
        ? aggregatorTakerConfigField(params.aggregator)
        : {}),
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

export async function main() {
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
  // P0-4: when set, drive the take loop to ZERO collateral with residual debt,
  // then run a real settlement stage and assert the auction clears. Gated so
  // take-only runs are byte-identical.
  const settlementStage =
    process.env.AJNA_AGENT_HARNESS_SETTLEMENT_STAGE === '1';
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
    // P0-4: minAuctionAge cannot be 0 (|| 3600-floored); use a small positive
    // value. The age gate compares wall-clock Date.now()-kickTime, satisfied by
    // real elapsed runtime (fork warping does not move Date.now()).
    settlement: {
      enabled: true,
      minAuctionAge: 1,
      maxBucketDepth: 50,
      maxIterations: 10,
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

    // P0-2/P0-3: when an aggregator provider is selected, pre-fund the mock
    // target + install the quote injector so the discovery take runs the real
    // aggregator taker against the mock. No-op (returns null) otherwise.
    const aggregatorContext =
      mode === 'discovery'
        ? await setupAggregatorInjection({ summary, pool, keeper })
        : null;

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
                      .keeperTakerRouter &&
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
          aggregator: aggregatorContext,
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
            keeperTakerRouter:
              summary.uniswapV3ExternalTake.deployment.keeperTakerRouter,
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

      // P0-4: needsSettlement requires collateral==0 && debt>0, and a single
      // partial take leaves residual collateral. When settling, keep
      // warping+re-taking until on-chain collateral reaches 0; otherwise stop at
      // the first reduction (existing take-only behavior).
      const collateralIsZero =
        liquidationStatusAfterTake === null ||
        ethers.BigNumber.from(liquidationStatusAfterTake.collateral).eq(0);
      const takeLoopGoalReached = settlementStage
        ? collateralIsZero
        : collateralReducedByTake;
      if (
        takeLoopGoalReached ||
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
        summary.uniswapV3ExternalTake.deployment.keeperTakerRouter,
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

    // P0-4: run a real settlement AFTER all take-artifact collection (settle is
    // irreversible and emits keeper txs; running it earlier would pollute the
    // take tx/approval/balance reads above).
    let settlementArtifact: HarnessReport['settlementArtifact'] | undefined;
    if (settlementStage) {
      const settleBorrower = summary.borrower.owner;
      const auctionBeforeSettle =
        await pool.contract.auctionInfo(settleBorrower);
      const kickTimeBefore = auctionBeforeSettle.kickTime_;
      const { locked: lockedBefore } = await pool.kickerInfo(keeper.address);
      const collateralZero =
        liquidationStatusAfterTake === null ||
        ethers.BigNumber.from(liquidationStatusAfterTake.collateral).eq(0);
      // Precondition: an ACTIVE auction (kickTime_ != 0 => residual debt) with
      // zero collateral. Fail loudly if not reached, else settlement finds
      // nothing and the test silently passes proving nothing.
      const collateralZeroDebtPositiveReached =
        !kickTimeBefore.eq(0) && collateralZero;
      if (!collateralZeroDebtPositiveReached) {
        throw new Error(
          `Settlement precondition not reached (need an active auction with zero collateral): ` +
            `kickTime_=${kickTimeBefore.toString()} collateral=${
              liquidationStatusAfterTake?.collateral ?? 'null'
            } (raise --max-take-warps or check the fixture debt/collateral economics)`
        );
      }
      // The age gate compares wall-clock Date.now()-kickTime (seconds).
      const auctionAgeSecondsAtCheck = Math.floor(
        Date.now() / 1000 - Number(kickTimeBefore.toString())
      );

      clearSharedSettlementScannerCache();
      await handleSettlements({
        pool,
        poolConfig: poolConfig as never,
        signer: keeper,
        config: {
          dryRun: false,
          subgraph: makeFixtureSubgraphReader(pool, settleBorrower, provider),
        },
      });

      const auctionAfterSettle = await pool.contract.auctionInfo(settleBorrower);
      const kickTimeAfter = auctionAfterSettle.kickTime_;
      const { locked: lockedAfter } = await pool.kickerInfo(keeper.address);
      settlementArtifact = {
        driven: true,
        collateralZeroDebtPositiveReached,
        kickTimeBefore: kickTimeBefore.toString(),
        kickTimeAfter: kickTimeAfter.toString(),
        kickTimeTransitionedToZero:
          !kickTimeBefore.eq(0) && kickTimeAfter.eq(0),
        lockedBefore: lockedBefore.toString(),
        lockedAfter: lockedAfter.toString(),
        bondsUnlocked: lockedAfter.eq(0),
        auctionAgeSecondsAtCheck,
        minAuctionAge: poolConfig.settlement.minAuctionAge,
      };
      process.stdout.write(
        `[harness] settlement: kickTime_ ${kickTimeBefore.toString()} -> ${kickTimeAfter.toString()}, locked ${lockedBefore.toString()} -> ${lockedAfter.toString()}\n`
      );
    }

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
                  summary.uniswapV3ExternalTake.deployment.keeperTakerRouter &&
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
      settlementArtifact,
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

export function handleMainError(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(handleMainError);
}
