#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import { AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { Wallet, ethers } from 'ethers';
import { handleDiscoveredTakeTarget } from '../src/discovery/handlers';
import { createDiscoveryRpcCache } from '../src/discovery/rpc-cache';
import {
  buildDiscoveredTakeTargets as buildConfigDiscoveredTakeTargets,
  clearSharedDiscoveryScans,
  ensurePoolLoaded,
  normalizeAddress,
} from '../src/discovery/targets';
import { validateExternalTakeRouteDeployments } from '../src/discovery/route-preflight';
import type { DiscoveredTakeTargetStats } from '../src/discovery/take-executor';
import type { ResolvedTakeTarget } from '../src/discovery/targets';
import { handleKicks } from '../src/kick';
import { assertSubgraphChainConsistency } from '../src/run';
import { handleTakes } from '../src/take';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../src/take/external-take/execution-plan';
import type {
  ExternalTakeQuoteEvaluation,
  TakeDecision,
} from '../src/take/types';
import type {
  DiscoveryReadTransports,
  SubgraphReader,
} from '../src/read-transports';
import subgraphModule, {
  GetLiquidationResponse,
  GetLoanResponse,
} from '../src/subgraph';
import {
  LiquiditySource,
  PriceOriginSource,
  configureAjna,
  formatLiquiditySource,
  assertIsValidConfig,
  validateAutoDiscoverConfig,
  type ExternalTakePathKind,
  type KeeperConfig,
} from '../src/config';
import { getBalanceOfErc20 } from '../src/erc20';
import type { ChainwideLiquidationAuction } from '../src/subgraph';

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

type HarnessReport = {
  mode: 'manual' | 'discovery';
  hybridGasQuoteFailureFallbackMode?: 'disabled' | 'factory_first';
  summaryPath: string;
  rpcUrl: string;
  borrower: string;
  derivedKickReferencePrice: number;
  keeperKickEligibleBefore: boolean;
  keeperQuoteBalanceBefore: string;
  keeperQuoteBalanceAfter: string;
  kickExecuted: boolean;
  liquidationStatusAfterKick?: {
    collateral: string;
    debtToCover?: string;
    price: string;
  };
  takeExecuted: boolean;
  liquidationStatusAfterTake?: {
    collateral: string;
    debtToCover?: string;
    price: string;
  } | null;
  collateralReducedByTake: boolean;
  takeWarpCount: number;
  takeWarpSecondsPerStep: number;
  takeAttempts: number;
  discoveryStats?: DiscoveredTakeTargetStats[];
  routeArtifact: RouteArtifact;
  txArtifact: TransactionArtifact;
  receiptArtifact: ReceiptArtifact | null;
  balanceArtifact: BalanceArtifact;
  approvalArtifact: ApprovalArtifact;
  transportArtifact: TransportArtifact;
  envArtifact: EnvArtifact;
  stateArtifact: StateArtifact;
  policyArtifact: PolicyArtifact;
  skipArtifact: SkipArtifact;
  configArtifact?: ConfigArtifact;
  manualArtifact?: ManualArtifact;
};

type SerializedRouteEvaluation = {
  path?: string;
  selectedLiquiditySource?: string;
  selectedFeeTier?: number;
  quoteAmountRaw?: string;
  routeMinOutRaw?: string;
  profitMinOutRaw?: string;
  routeExecutionFloorRaw?: string;
  approvedMinOutRaw?: string;
  expectedNetProfitQuoteRaw?: string;
  expectedSubsidyQuoteRaw?: string;
  reason?: string;
};

type RouteDecisionEvent = {
  phase: 'attempt' | 'executed';
  approvedTake: boolean;
  approvedArbTake: boolean;
  executedTake?: boolean;
  executedArbTake?: boolean;
  borrower: string;
  route?: SerializedRouteEvaluation;
};

type RouteSkipEvent = {
  stage: 'evaluation' | 'revalidation' | 'execution';
  borrower: string;
  poolAddress: string;
  reason: string;
  approvedTake?: boolean;
  approvedArbTake?: boolean;
  route?: SerializedRouteEvaluation;
};

type RouteArtifact = {
  selectedPath?: string;
  selectedLiquiditySource?: string;
  selectedFeeTier?: number;
  expectedExecutionFeeTier?: number;
  factoryRegistryAddress?: string;
  selectedTakerAddress?: string;
  decisions: RouteDecisionEvent[];
  counters?: {
    approvedFactoryPathTakes: number;
    dryRunFactoryPathTakes: number;
    executedFactoryPathTakes: number;
    approvedUniswapV3Takes: number;
    dryRunUniswapV3Takes: number;
    executedUniswapV3Takes: number;
    preBroadcastFailures: number;
    postSubmissionFailures: number;
  };
};

type PolicyArtifact = {
  allowedExternalTakePaths: ExternalTakePathKind[];
  allowedLiquiditySources: string[];
  externalTakeRouteSelectionMode: 'maximize_profit' | 'factory_first';
  hybridGasQuoteFailureFallbackMode?: 'disabled' | 'factory_first';
  maxGasCostNative?: number;
  minExpectedProfitQuote?: number;
  maxConcurrentCandidateEvaluations: number;
  maxInFlightRouteProbes: number;
  maxExecutionsPerPoolPerRun: number;
  takeRouteQuoteBudgetPerCandidate?: number;
  takeQuoteBudgetPerRun?: number;
};

type SkipArtifact = {
  events: RouteSkipEvent[];
  reasons: string[];
  evaluationSkips: number;
  revalidationSkips: number;
  executionSkips: number;
  gasPolicyRejects: number;
  profitFloorRejects: number;
  routeProbeAbandonedCount?: number;
};

type ConfigArtifact = {
  enabled: true;
  configPath: string;
  malformedConfigRejected: boolean;
  validConfigLoaded: boolean;
  configValidationPassed: boolean;
  autoDiscoverValidationPassed: boolean;
  routeDeploymentPreflightPassed: boolean;
  chainConsistencyPreflightPassed: boolean;
  discoveredTargetBuiltFromConfig: boolean;
  expectedTargetFound: boolean;
  wrongDeploymentPoolSkipped: boolean;
  hydrationCooldownRecorded: boolean;
  hydrationCooldownPreventedRepeat: boolean;
  invalidPoolRouteApprovalAttempted: boolean;
  selectedChoices: {
    allowedExternalTakePaths?: string[];
    allowedLiquiditySources?: string[];
    externalTakeRouteSelectionMode?: string;
    hybridGasQuoteFailureFallbackMode?: string;
    keeperTakerFactory?: string;
    uniswapV3Taker?: string;
    readRpcUrls?: string[];
    subgraphFallbackUrls?: string[];
    dryRunNewPools?: boolean;
    allowPools?: string[];
    denyPools?: string[];
    hotAuctionCandidateTtlMs?: number;
  };
};

type ManualArtifact = {
  selectedDeploymentFromManualConfig: boolean;
  lifiNoBroadcastPolicyContextResolved: boolean;
  lifiNoBroadcastReason: string;
};

type TransactionArtifact = {
  fromBlockExclusive: number;
  toBlockInclusive: number;
  selectedTransportMode: 'public_rpc';
  transactions: Array<{
    hash: string;
    from: string;
    to: string | null;
    nonce: number;
    blockNumber?: number;
    selector?: string;
    value: string;
    matchedFactoryExecution: boolean;
  }>;
};

type ReceiptArtifact = {
  transactionHash: string;
  status: number | null;
  gasUsed: string;
  blockNumber: number;
  to: string | null;
  from: string;
};

type BalanceArtifact = {
  quoteToken: string;
  keeper: string;
  before: string;
  after: string;
  delta: string;
  positiveDelta: boolean;
};

type ApprovalArtifact = {
  checks: Array<{
    token: string;
    owner: string;
    spender: string;
    before: string;
    after: string;
    resetToZero: boolean;
    label: string;
  }>;
};

type TransportArtifact = {
  readRpcEndpointClass: 'localhost';
  subgraphEndpointClass: 'fixture_override';
  selectedWriteTransportMode: 'public_rpc';
  noEgressGuardEnabled: boolean;
};

type EnvArtifact = {
  allowedSecretSources: string[];
  rawSecretValuesRecorded: false;
  envNamesWithSecretLikeLabels: string[];
  expectedLocalSecretEnvNames: string[];
  unexpectedSecretLikeEnvNames: string[];
};

type StateArtifact = {
  auctionBeforeTake: LiquidationStatusSnapshot | null;
  auctionAfterTake: LiquidationStatusSnapshot | null;
  collateralReduced: boolean;
  debtReducedOrNoCollateralRemaining: boolean;
  blockBeforeTake: number;
  blockAfterTake: number;
};

// This harness targets a Base fork by design — the addresses below are
// Ajna's Base mainnet deployment. If Ajna redeploys on Base, these need to
// be updated alongside the fixture script's BASE_AJNA_ERC20_POOL_FACTORY.
// The `erc20PoolFactory` value must match
// scripts/create-liquidatable-ajna-fixture.ts::BASE_AJNA_ERC20_POOL_FACTORY.
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

const BASE_ONEINCH_ROUTER = '0x1111111254EEB25477B68fb85Ed929f73A960582';

// Sentinel URL for the subgraph in harness mode. The subgraph calls that
// matter (getLoans, getLiquidations) are monkey-patched to read directly
// from the pool contract. If something bypasses the override and hits the
// network, the `.invalid` TLD (IANA-reserved, RFC 6761) guarantees DNS
// failure so we see a loud error rather than a silent real-subgraph call.
const FIXTURE_SUBGRAPH_SENTINEL_URL =
  'http://fixture-subgraph.override.invalid';

function overrideGetLoans(fn: typeof subgraphModule.getLoans): () => void {
  const originalGetLoans = subgraphModule.getLoans;
  subgraphModule.getLoans = fn;
  return () => {
    subgraphModule.getLoans = originalGetLoans;
  };
}

function overrideGetLiquidations(
  fn: typeof subgraphModule.getLiquidations
): () => void {
  const originalGetLiquidations = subgraphModule.getLiquidations;
  subgraphModule.getLiquidations = fn;
  return () => {
    subgraphModule.getLiquidations = originalGetLiquidations;
  };
}

function makeGetLoansFromFixture(
  pool: FungiblePool,
  borrower: string
): typeof subgraphModule.getLoans {
  return async (): Promise<GetLoanResponse> => {
    const loan = await pool.getLoan(borrower);
    if ((loan as any).isKicked) {
      return { loans: [] };
    }
    return {
      loans: [
        {
          borrower,
          thresholdPrice: Number(loan.thresholdPrice.toString()) / 1e18,
        },
      ],
    };
  };
}

function makeGetLiquidationsFromFixture(
  pool: FungiblePool,
  borrower: string
): typeof subgraphModule.getLiquidations {
  return async (
    _subgraphUrl: string,
    _poolAddress: string,
    minCollateral: number
  ): Promise<GetLiquidationResponse> => {
    const { hpb, hpbIndex } = await pool.getPrices();
    try {
      const liquidation = await pool.getLiquidation(borrower);
      const status = await liquidation.getStatus();
      const collateral = Number(status.collateral.toString()) / 1e18;
      return {
        pool: {
          hpb: Number(hpb.toString()) / 1e18,
          hpbIndex,
          liquidationAuctions: collateral > minCollateral ? [{ borrower }] : [],
        },
      };
    } catch (error) {
      // Same discipline as `tryGetLiquidationStatus`: benign "no auction"
      // collapses to an empty list, but real RPC failures surface. If this
      // ever silently returned [] for an RPC timeout, the harness would
      // report "no liquidation to take" and pass the test incorrectly.
      if (!isBenignNoLiquidationError(error)) {
        throw error;
      }
      return {
        pool: {
          hpb: Number(hpb.toString()) / 1e18,
          hpbIndex,
          liquidationAuctions: [],
        },
      };
    }
  };
}

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
const ERC20_ALLOWANCE_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
];

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

function optionalNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function optionalPositiveIntegerEnv(name: string, fallback: number): number {
  const value = optionalNumberEnv(name);
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalExternalTakePathsEnv(
  fallback: ExternalTakePathKind[]
): ExternalTakePathKind[] {
  const raw = process.env.AJNA_AGENT_HARNESS_ALLOWED_EXTERNAL_TAKE_PATHS;
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  return raw.split(',').map((part) => {
    const value = part.trim().toLowerCase();
    if (value !== 'oneinch' && value !== 'factory' && value !== 'lifi') {
      throw new Error(
        'AJNA_AGENT_HARNESS_ALLOWED_EXTERNAL_TAKE_PATHS must contain only oneinch, factory, or lifi'
      );
    }
    return value;
  });
}

function parseLiquiditySourceLabel(raw: string): LiquiditySource {
  const value = raw.trim().toUpperCase();
  if (value === 'UNISWAPV3' || value === 'UNISWAP_V3' || value === '2') {
    return LiquiditySource.UNISWAPV3;
  }
  if (value === 'ONEINCH' || value === 'ONE_INCH' || value === '1') {
    return LiquiditySource.ONEINCH;
  }
  if (value === 'SUSHISWAP' || value === 'SUSHI' || value === '3') {
    return LiquiditySource.SUSHISWAP;
  }
  if (value === 'CURVE' || value === '4') {
    return LiquiditySource.CURVE;
  }
  if (value === 'LIFI' || value === 'LI.FI' || value === '5') {
    return LiquiditySource.LIFI;
  }
  throw new Error(
    `Unsupported AJNA_AGENT_HARNESS_ALLOWED_LIQUIDITY_SOURCES entry: ${raw}`
  );
}

function optionalLiquiditySourcesEnv(
  fallback: LiquiditySource[]
): LiquiditySource[] {
  const raw = process.env.AJNA_AGENT_HARNESS_ALLOWED_LIQUIDITY_SOURCES;
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseLiquiditySourceLabel);
}

function optionalRouteSelectionMode(): 'maximize_profit' | 'factory_first' {
  const raw = process.env.AJNA_AGENT_HARNESS_ROUTE_SELECTION_MODE;
  if (raw === undefined || raw.trim().length === 0) {
    return 'maximize_profit';
  }
  if (raw !== 'maximize_profit' && raw !== 'factory_first') {
    throw new Error(
      'AJNA_AGENT_HARNESS_ROUTE_SELECTION_MODE must be maximize_profit or factory_first'
    );
  }
  return raw;
}

function buildPolicyArtifact(params: {
  hybridGasQuoteFailureFallbackMode: 'disabled' | 'factory_first';
}): PolicyArtifact {
  return {
    allowedExternalTakePaths: optionalExternalTakePathsEnv([
      'oneinch',
      'factory',
    ]),
    allowedLiquiditySources: optionalLiquiditySourcesEnv([
      LiquiditySource.UNISWAPV3,
    ]).map(formatLiquiditySource),
    externalTakeRouteSelectionMode: optionalRouteSelectionMode(),
    hybridGasQuoteFailureFallbackMode: params.hybridGasQuoteFailureFallbackMode,
    maxGasCostNative: optionalNumberEnv(
      'AJNA_AGENT_HARNESS_MAX_GAS_COST_NATIVE'
    ) ?? 1,
    minExpectedProfitQuote: optionalNumberEnv(
      'AJNA_AGENT_HARNESS_MIN_EXPECTED_PROFIT_QUOTE'
    ),
    maxConcurrentCandidateEvaluations: optionalPositiveIntegerEnv(
      'AJNA_AGENT_HARNESS_MAX_CONCURRENT_CANDIDATE_EVALUATIONS',
      1
    ),
    maxInFlightRouteProbes: optionalPositiveIntegerEnv(
      'AJNA_AGENT_HARNESS_MAX_IN_FLIGHT_ROUTE_PROBES',
      3
    ),
    maxExecutionsPerPoolPerRun: optionalPositiveIntegerEnv(
      'AJNA_AGENT_HARNESS_MAX_EXECUTIONS_PER_POOL_PER_RUN',
      1
    ),
    takeRouteQuoteBudgetPerCandidate: optionalNumberEnv(
      'AJNA_AGENT_HARNESS_TAKE_ROUTE_QUOTE_BUDGET_PER_CANDIDATE'
    ),
    takeQuoteBudgetPerRun: optionalNumberEnv(
      'AJNA_AGENT_HARNESS_TAKE_QUOTE_BUDGET_PER_RUN'
    ),
  };
}

function liquiditySourceLabelsToValues(labels: string[]): LiquiditySource[] {
  return labels.map(parseLiquiditySourceLabel);
}

function bnString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (ethers.BigNumber.isBigNumber(value)) {
    return value.toString();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function serializeRouteEvaluation(
  evaluation: ExternalTakeQuoteEvaluation | undefined
): SerializedRouteEvaluation | undefined {
  if (!evaluation) {
    return undefined;
  }
  return {
    path: evaluation.externalTakePath,
    selectedLiquiditySource: formatLiquiditySource(
      evaluation.selectedLiquiditySource
    ),
    selectedFeeTier: evaluation.selectedFeeTier,
    quoteAmountRaw: bnString(evaluation.quoteAmountRaw),
    routeMinOutRaw: bnString(evaluation.routeMinOutRaw),
    profitMinOutRaw: bnString(evaluation.profitMinOutRaw),
    routeExecutionFloorRaw: bnString(evaluation.routeExecutionFloorRaw),
    approvedMinOutRaw: bnString(evaluation.approvedMinOutRaw),
    expectedNetProfitQuoteRaw: bnString(
      evaluation.routeProfitability?.expectedNetProfitQuoteRaw
    ),
    expectedSubsidyQuoteRaw: bnString(
      evaluation.routeProfitability?.expectedSubsidyQuoteRaw
    ),
    reason: evaluation.reason,
  };
}

function serializeDecisionEvent(
  phase: RouteDecisionEvent['phase'],
  decision: TakeDecision,
  executed?: Pick<RouteDecisionEvent, 'executedTake' | 'executedArbTake'>
): RouteDecisionEvent {
  const route = decision.approvedTake
    ? serializeRouteEvaluation(
        getExternalTakeExecutionPlanPrimaryEvaluation(
          decision.externalTakeExecutionPlan
        )
      )
    : undefined;
  return {
    phase,
    approvedTake: decision.approvedTake,
    approvedArbTake: decision.approvedArbTake,
    borrower: decision.borrower,
    route,
    ...executed,
  };
}

function serializeSkipEvent(params: {
  stage: RouteSkipEvent['stage'];
  reason: string;
  poolAddress: string;
  borrower: string;
  decision?: TakeDecision;
}): RouteSkipEvent {
  const route = params.decision?.approvedTake
    ? serializeRouteEvaluation(
        getExternalTakeExecutionPlanPrimaryEvaluation(
          params.decision.externalTakeExecutionPlan
        )
      )
    : undefined;
  return {
    stage: params.stage,
    borrower: params.borrower,
    poolAddress: params.poolAddress,
    reason: params.reason,
    approvedTake: params.decision?.approvedTake,
    approvedArbTake: params.decision?.approvedArbTake,
    route,
  };
}

function sumDiscoveryCounter(
  stats: DiscoveredTakeTargetStats[],
  field: keyof DiscoveredTakeTargetStats
): number {
  return stats.reduce((sum, entry) => {
    const value = entry[field];
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);
}

function sumDiscoveryPathCounter(
  stats: DiscoveredTakeTargetStats[],
  pathName: 'factory' | 'oneinch' | 'lifi',
  field: 'approved' | 'dryRun' | 'executed' | 'preBroadcastFailures' | 'postSubmissionFailures'
): number {
  return stats.reduce((sum, entry) => {
    return sum + Number(entry.externalTakeByPath?.[pathName]?.[field] ?? 0);
  }, 0);
}

function buildRouteArtifact(params: {
  summary: FixtureSummary;
  mode: 'manual' | 'discovery';
  discoveryStats: DiscoveredTakeTargetStats[];
  routeDecisionEvents: RouteDecisionEvent[];
}): RouteArtifact {
  const lastRouteEvent = [...params.routeDecisionEvents]
    .reverse()
    .find((event) => event.route?.selectedLiquiditySource);
  const uniswapV3ExternalTake = params.summary.uniswapV3ExternalTake;
  const expectedSource = formatLiquiditySource(LiquiditySource.UNISWAPV3);
  return {
    selectedPath:
      lastRouteEvent?.route?.path ??
      (params.mode === 'manual' ? 'factory' : undefined),
    selectedLiquiditySource:
      lastRouteEvent?.route?.selectedLiquiditySource ??
      (params.mode === 'manual' ? expectedSource : undefined),
    selectedFeeTier:
      lastRouteEvent?.route?.selectedFeeTier ??
      uniswapV3ExternalTake?.expectedExecutionFeeTier ??
      uniswapV3ExternalTake?.routerConfig.defaultFeeTier,
    expectedExecutionFeeTier: uniswapV3ExternalTake?.expectedExecutionFeeTier,
    factoryRegistryAddress: uniswapV3ExternalTake?.deployment.keeperTakerFactory,
    selectedTakerAddress: uniswapV3ExternalTake?.deployment.uniswapV3Taker,
    decisions: params.routeDecisionEvents,
    counters:
      params.mode === 'discovery'
        ? {
            approvedFactoryPathTakes: sumDiscoveryPathCounter(
              params.discoveryStats,
              'factory',
              'approved'
            ),
            dryRunFactoryPathTakes: sumDiscoveryPathCounter(
              params.discoveryStats,
              'factory',
              'dryRun'
            ),
            executedFactoryPathTakes: sumDiscoveryPathCounter(
              params.discoveryStats,
              'factory',
              'executed'
            ),
            approvedUniswapV3Takes: sumDiscoveryCounter(
              params.discoveryStats,
              'approvedUniswapV3TakeDecisions'
            ),
            dryRunUniswapV3Takes: sumDiscoveryCounter(
              params.discoveryStats,
              'dryRunUniswapV3Takes'
            ),
            executedUniswapV3Takes: sumDiscoveryCounter(
              params.discoveryStats,
              'executedUniswapV3Takes'
            ),
            preBroadcastFailures: sumDiscoveryPathCounter(
              params.discoveryStats,
              'factory',
              'preBroadcastFailures'
            ),
            postSubmissionFailures: sumDiscoveryPathCounter(
              params.discoveryStats,
              'factory',
              'postSubmissionFailures'
            ),
          }
        : undefined,
  };
}

function buildSkipArtifact(params: {
  discoveryStats: DiscoveredTakeTargetStats[];
  routeSkipEvents: RouteSkipEvent[];
  rpcCacheStats?: Record<string, unknown>;
}): SkipArtifact {
  return {
    events: params.routeSkipEvents,
    reasons: Array.from(
      new Set(params.routeSkipEvents.map((event) => event.reason))
    ),
    evaluationSkips: sumDiscoveryCounter(
      params.discoveryStats,
      'evaluationSkips'
    ),
    revalidationSkips: sumDiscoveryCounter(
      params.discoveryStats,
      'revalidationSkips'
    ),
    executionSkips: sumDiscoveryCounter(
      params.discoveryStats,
      'executionSkips'
    ),
    gasPolicyRejects: sumDiscoveryCounter(
      params.discoveryStats,
      'gasPolicyRejects'
    ),
    profitFloorRejects: sumDiscoveryCounter(
      params.discoveryStats,
      'profitFloorRejects'
    ),
    routeProbeAbandonedCount:
      typeof params.rpcCacheStats?.routeProbeAbandonedCount === 'number'
        ? params.rpcCacheStats.routeProbeAbandonedCount
        : undefined,
  };
}

async function readAllowance(params: {
  provider: ethers.providers.Provider;
  token: string;
  owner: string;
  spender: string;
}): Promise<string> {
  const token = new ethers.Contract(
    params.token,
    ERC20_ALLOWANCE_ABI,
    params.provider
  );
  const allowance = await token.allowance(params.owner, params.spender);
  return allowance.toString();
}

async function readApprovalChecks(params: {
  provider: ethers.providers.Provider;
  pool: FungiblePool;
  summary: FixtureSummary;
}): Promise<ApprovalArtifact['checks']> {
  const uniswap = params.summary.uniswapV3ExternalTake;
  if (!uniswap) {
    return [];
  }
  const taker = uniswap.deployment.uniswapV3Taker;
  const checks = [
    {
      token: params.pool.quoteAddress,
      owner: taker,
      spender: params.pool.poolAddress,
      label: 'uniswap-v3-taker quote-token pool allowance',
    },
    {
      token: params.pool.collateralAddress,
      owner: taker,
      spender: uniswap.routerConfig.swapRouter02Address,
      label: 'uniswap-v3-taker collateral-token router allowance',
    },
  ];
  return await Promise.all(
    checks.map(async (check) => ({
      ...check,
      before: await readAllowance({
        provider: params.provider,
        token: check.token,
        owner: check.owner,
        spender: check.spender,
      }),
      after: 'unread',
      resetToZero: false,
    }))
  );
}

async function finalizeApprovalChecks(params: {
  provider: ethers.providers.Provider;
  checks: ApprovalArtifact['checks'];
}): Promise<ApprovalArtifact> {
  const checks = await Promise.all(
    params.checks.map(async (check) => {
      const after = await readAllowance({
        provider: params.provider,
        token: check.token,
        owner: check.owner,
        spender: check.spender,
      });
      return {
        ...check,
        after,
        resetToZero: after === '0',
      };
    })
  );
  return { checks };
}

async function collectTransactionArtifact(params: {
  provider: ethers.providers.JsonRpcProvider;
  fromBlockExclusive: number;
  factoryAddress?: string;
  keeperAddress: string;
}): Promise<{
  txArtifact: TransactionArtifact;
  receiptArtifact: ReceiptArtifact | null;
}> {
  const toBlockInclusive = await params.provider.getBlockNumber();
  const factoryAddress = params.factoryAddress?.toLowerCase();
  const keeperAddress = params.keeperAddress.toLowerCase();
  const transactions: TransactionArtifact['transactions'] = [];
  let selectedReceipt: ReceiptArtifact | null = null;

  for (
    let blockNumber = params.fromBlockExclusive + 1;
    blockNumber <= toBlockInclusive;
    blockNumber += 1
  ) {
    const block = await params.provider.getBlockWithTransactions(blockNumber);
    for (const tx of block.transactions) {
      const matchedFactoryExecution =
        tx.from.toLowerCase() === keeperAddress &&
        tx.to?.toLowerCase() === factoryAddress;
      if (tx.from.toLowerCase() !== keeperAddress && !matchedFactoryExecution) {
        continue;
      }
      const artifact = {
        hash: tx.hash,
        from: tx.from,
        to: tx.to ?? null,
        nonce: tx.nonce,
        blockNumber: tx.blockNumber ?? blockNumber,
        selector:
          typeof tx.data === 'string' && tx.data.length >= 10
            ? tx.data.slice(0, 10)
            : undefined,
        value: tx.value.toString(),
        matchedFactoryExecution,
      };
      transactions.push(artifact);
      if (matchedFactoryExecution && selectedReceipt === null) {
        const receipt = await params.provider.getTransactionReceipt(tx.hash);
        selectedReceipt = receipt
          ? {
              transactionHash: receipt.transactionHash,
              status: receipt.status ?? null,
              gasUsed: receipt.gasUsed.toString(),
              blockNumber: receipt.blockNumber,
              to: receipt.to ?? null,
              from: receipt.from,
            }
          : null;
      }
    }
  }

  return {
    txArtifact: {
      fromBlockExclusive: params.fromBlockExclusive,
      toBlockInclusive,
      selectedTransportMode: 'public_rpc',
      transactions,
    },
    receiptArtifact: selectedReceipt,
  };
}

function buildBalanceArtifact(params: {
  quoteToken: string;
  keeper: string;
  before: ethers.BigNumber;
  after: ethers.BigNumber;
}): BalanceArtifact {
  const delta = params.after.sub(params.before);
  return {
    quoteToken: params.quoteToken,
    keeper: params.keeper,
    before: params.before.toString(),
    after: params.after.toString(),
    delta: delta.toString(),
    positiveDelta: delta.gt(0),
  };
}

function hasDebtReducedOrNoCollateralRemaining(params: {
  before: LiquidationStatusSnapshot | null | undefined;
  after: LiquidationStatusSnapshot | null | undefined;
}): boolean {
  if (!params.before) {
    return false;
  }
  if (!params.after) {
    return true;
  }
  if (ethers.BigNumber.from(params.after.collateral).eq(0)) {
    return true;
  }
  if (!params.before.debtToCover || !params.after.debtToCover) {
    return true;
  }
  return ethers.BigNumber.from(params.after.debtToCover).lt(
    ethers.BigNumber.from(params.before.debtToCover)
  );
}

function buildTransportArtifact(): TransportArtifact {
  return {
    readRpcEndpointClass: 'localhost',
    subgraphEndpointClass: 'fixture_override',
    selectedWriteTransportMode: 'public_rpc',
    noEgressGuardEnabled: process.env.AJNA_NO_EGRESS_GUARD_ENABLED === '1',
  };
}

function buildEnvArtifact(): EnvArtifact {
  const expectedLocalSecretEnvNames = ['AJNA_AGENT_KEEPER_KEY'];
  const envNamesWithSecretLikeLabels = Object.keys(process.env)
    .filter((name) => /KEY|TOKEN|PASSWORD|SECRET/i.test(name))
    .sort();
  return {
    allowedSecretSources: ['generated_hardhat_test_key'],
    rawSecretValuesRecorded: false,
    envNamesWithSecretLikeLabels,
    expectedLocalSecretEnvNames,
    unexpectedSecretLikeEnvNames: envNamesWithSecretLikeLabels.filter(
      (name) => !expectedLocalSecretEnvNames.includes(name)
    ),
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

/**
 * Heuristic: does this error mean "no liquidation auction exists for this
 * borrower right now" (legitimate state to observe) versus a real RPC /
 * chain failure (should be surfaced, not swallowed)?
 *
 * The Ajna SDK's `pool.getLiquidation(...)` throws when no auction row is
 * found. Ethers provider errors (`CALL_EXCEPTION`, `SERVER_ERROR`,
 * `NETWORK_ERROR`, `TIMEOUT`) indicate real problems that silently
 * swallowing would hide. We treat anything lacking one of those ethers
 * error codes as the benign "no auction" case and return undefined.
 */
function isBenignNoLiquidationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const code = (error as { code?: string }).code;
  if (typeof code === 'string') {
    const hardFailureCodes = new Set([
      'CALL_EXCEPTION',
      'SERVER_ERROR',
      'NETWORK_ERROR',
      'TIMEOUT',
    ]);
    if (hardFailureCodes.has(code)) return false;
  }
  return true;
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

function makeFixtureSubgraphReader(
  pool: FungiblePool,
  borrower: string,
  provider?: ethers.providers.Provider
): SubgraphReader {
  const getLoans = makeGetLoansFromFixture(pool, borrower);
  const getLiquidations = makeGetLiquidationsFromFixture(pool, borrower);
  const getChainwideAuction = async (): Promise<ChainwideLiquidationAuction[]> => {
    try {
      const liquidation = await pool.getLiquidation(borrower);
      const status = await liquidation.getStatus();
      if (!status.collateral.gt(0)) {
        return [];
      }
      const debtToCover = (status as any).debtToCover;
      return [
        {
          id: `${pool.poolAddress.toLowerCase()}-${borrower.toLowerCase()}`,
          borrower,
          kickTime: '0',
          debtRemaining: debtToCover?.toString?.() ?? '0',
          collateralRemaining: status.collateral.toString(),
          neutralPrice: '0',
          debt: debtToCover?.toString?.() ?? '0',
          collateral: status.collateral.toString(),
          pool: {
            id: pool.poolAddress.toLowerCase(),
          },
        },
      ];
    } catch (error) {
      if (!isBenignNoLiquidationError(error)) {
        throw error;
      }
      return [];
    }
  };
  return {
    cacheKey: `fixture:${pool.poolAddress}:${borrower.toLowerCase()}`,
    getLoans(poolAddress) {
      return getLoans(FIXTURE_SUBGRAPH_SENTINEL_URL, poolAddress);
    },
    getLiquidations(poolAddress, minCollateral) {
      return getLiquidations(
        FIXTURE_SUBGRAPH_SENTINEL_URL,
        poolAddress,
        minCollateral
      );
    },
    async getHighestMeaningfulBucket() {
      return { buckets: [] } as any;
    },
    async getUnsettledAuctions() {
      return { liquidationAuctions: [] } as any;
    },
    async getChainwideLiquidationAuctions() {
      return { liquidationAuctions: await getChainwideAuction() };
    },
    async getBucketTakeLPAwards() {
      return { bucketTakeLPAwards: [] } as any;
    },
    async getSubgraphMeta() {
      if (provider) {
        const block = await provider.getBlock('latest');
        return {
          block: {
            number: block.number,
            timestamp: block.timestamp,
          },
          deployment: 'fixture-local',
          hasIndexingErrors: false,
        } as any;
      }
      return {
        block: {
          number: 0,
          timestamp: Math.floor(Date.now() / 1000),
        },
      } as any;
    },
  };
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

function getHarnessOutputDir(summary: FixtureSummary): string {
  const outputPath = process.env.AJNA_AGENT_HARNESS_OUTPUT_PATH;
  if (outputPath) {
    return path.dirname(path.resolve(outputPath));
  }
  return summary.tempDir ?? process.cwd();
}

function buildFixtureConfig(params: {
  summary: FixtureSummary;
  rpcUrl: string;
  configPath: string;
  dryRun: boolean;
  manualPools?: KeeperConfig['manual']['pools'];
  discoveryDefaults?: KeeperConfig['discovery'];
}): KeeperConfig {
  const uniswap = params.summary.uniswapV3ExternalTake;
  if (!uniswap) {
    throw new Error('Fixture summary missing uniswapV3ExternalTake');
  }
  return {
    network: {
      rpcUrl: params.rpcUrl,
      readRpcUrls: [params.rpcUrl],
      subgraph: {
        url: FIXTURE_SUBGRAPH_SENTINEL_URL,
        fallbackUrls: [`${FIXTURE_SUBGRAPH_SENTINEL_URL}/fallback`],
      },
      tokenAddresses: {
        weth: uniswap.routerConfig.wethAddress,
      },
    },
    signer: {
      keystore: path.join(path.dirname(params.configPath), 'keeper.json'),
    },
    runtime: {
      logLevel: 'debug',
      delayBetweenRuns: 1,
      dryRun: params.dryRun,
    },
    ajna: BASE_AJNA_CONFIG as any,
    manual: {
      pools: params.manualPools ?? [],
    },
    discovery:
      params.discoveryDefaults ?? {
        enabled: true,
        dryRunNewPools: false,
        hydrateCooldownSec: 30,
        logSkips: true,
        allowPools: [params.summary.pool.address],
        denyPools: [],
        defaults: {
          take: {
            minCollateral: 0.01,
            liquiditySource: LiquiditySource.UNISWAPV3,
            marketPriceFactor: 0.98,
          },
        },
        take: {
          enabled: true,
          allowedExternalTakePaths: ['oneinch', 'factory'],
          defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
          externalTakeRouteSelectionMode: 'maximize_profit',
          hybridGasQuoteFailureFallbackMode: 'factory_first',
          maxGasCostNative: 1,
          validateRouteDeployments: true,
          hotAuctionCandidateTtlMs: 1_000,
        },
      },
    dex: {
      oneInch: {
        routers: {
          8453: BASE_ONEINCH_ROUTER,
        },
      },
      lifi: {
        mode: 'canary',
        apiBaseUrl: 'http://fixture-lifi.invalid',
        allowExchanges: ['uniswap'],
      },
      uniswapV3: {
        router: uniswap.routerConfig,
      },
    },
    takers: {
      oneInch: uniswap.deployment.uniswapV3Taker,
      factory: uniswap.deployment.keeperTakerFactory,
      contracts: {
        UniswapV3: uniswap.deployment.uniswapV3Taker,
      },
    },
  };
}

async function runConfigLoadedDiscoverySmoke(params: {
  ajna: AjnaSDK;
  provider: ethers.providers.JsonRpcProvider;
  pool: FungiblePool;
  summary: FixtureSummary;
  dryRun: boolean;
}): Promise<{ artifact: ConfigArtifact; target: ResolvedTakeTarget }> {
  const outputDir = getHarnessOutputDir(params.summary);
  const configPath = path.join(outputDir, 'fixture-keeper-config.json');
  const config = buildFixtureConfig({
    summary: params.summary,
    rpcUrl: params.summary.rpcUrl,
    configPath,
    dryRun: params.dryRun,
  });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  let malformedConfigRejected = false;
  try {
    assertIsValidConfig({
      ...config,
      network: undefined,
    } as any);
  } catch {
    malformedConfigRejected = true;
  }

  const loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assertIsValidConfig(loaded);
  validateAutoDiscoverConfig(loaded, 8453);
  await validateExternalTakeRouteDeployments({
    config: loaded,
    provider: params.provider,
    chainId: 8453,
    requirements: [{ path: 'factory', source: LiquiditySource.UNISWAPV3 }],
  });

  const subgraph = makeFixtureSubgraphReader(
    params.pool,
    params.summary.borrower.owner,
    params.provider
  );
  await assertSubgraphChainConsistency({
    subgraph,
    provider: params.provider,
    chainId: 8453,
  });

  clearSharedDiscoveryScans();
  const targets = await buildConfigDiscoveredTakeTargets(
    loaded,
    undefined,
    subgraph,
    { chainId: 8453 }
  );
  const normalizedExpectedPool = normalizeAddress(params.summary.pool.address);
  const target = targets.find(
    (candidate) => normalizeAddress(candidate.poolAddress) === normalizedExpectedPool
  );
  if (!target) {
    throw new Error(
      `Config-loaded discovery did not construct target for ${params.summary.pool.address}`
    );
  }
  const expectedTargetFound = target.candidates.some(
    (candidate) =>
      candidate.borrower.toLowerCase() ===
      params.summary.borrower.owner.toLowerCase()
  );
  if (!expectedTargetFound) {
    throw new Error(
      `Config-loaded discovery target did not include borrower ${params.summary.borrower.owner}`
    );
  }

  const hydrationCooldowns = new Map<string, number>();
  const invalidPoolAddress = Wallet.createRandom().address;
  const invalidPool = await ensurePoolLoaded({
    ajna: params.ajna,
    poolMap: new Map(),
    poolAddress: invalidPoolAddress,
    config: loaded,
    hydrationCooldowns,
  });
  const hydrationCooldownRecorded = hydrationCooldowns.has(
    normalizeAddress(invalidPoolAddress)
  );
  const invalidPoolSecondAttempt = await ensurePoolLoaded({
    ajna: params.ajna,
    poolMap: new Map(),
    poolAddress: invalidPoolAddress,
    config: loaded,
    hydrationCooldowns,
  });

  return {
    target,
    artifact: {
      enabled: true,
      configPath,
      malformedConfigRejected,
      validConfigLoaded: true,
      configValidationPassed: true,
      autoDiscoverValidationPassed: true,
      routeDeploymentPreflightPassed: true,
      chainConsistencyPreflightPassed: true,
      discoveredTargetBuiltFromConfig: true,
      expectedTargetFound,
      wrongDeploymentPoolSkipped: invalidPool === undefined,
      hydrationCooldownRecorded,
      hydrationCooldownPreventedRepeat:
        invalidPoolSecondAttempt === undefined && hydrationCooldownRecorded,
      invalidPoolRouteApprovalAttempted: false,
      selectedChoices: {
        allowedExternalTakePaths:
          loaded.discovery?.take && typeof loaded.discovery.take === 'object'
            ? loaded.discovery.take.allowedExternalTakePaths
            : undefined,
        allowedLiquiditySources:
          loaded.discovery?.take && typeof loaded.discovery.take === 'object'
            ? loaded.discovery.take.allowedLiquiditySources?.map(
                formatLiquiditySource
              )
            : undefined,
        externalTakeRouteSelectionMode:
          loaded.discovery?.take && typeof loaded.discovery.take === 'object'
            ? loaded.discovery.take.externalTakeRouteSelectionMode
            : undefined,
        hybridGasQuoteFailureFallbackMode:
          loaded.discovery?.take && typeof loaded.discovery.take === 'object'
            ? loaded.discovery.take.hybridGasQuoteFailureFallbackMode
            : undefined,
        keeperTakerFactory: loaded.takers?.factory,
        uniswapV3Taker: loaded.takers?.contracts?.UniswapV3,
        readRpcUrls: loaded.network.readRpcUrls,
        subgraphFallbackUrls: loaded.network.subgraph.fallbackUrls,
        dryRunNewPools: loaded.discovery?.dryRunNewPools,
        allowPools: loaded.discovery?.allowPools,
        denyPools: loaded.discovery?.denyPools,
        hotAuctionCandidateTtlMs:
          loaded.discovery?.take && typeof loaded.discovery.take === 'object'
            ? loaded.discovery.take.hotAuctionCandidateTtlMs
            : undefined,
      },
    },
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
