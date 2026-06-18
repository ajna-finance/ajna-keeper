import { FungiblePool } from '@ajna-finance/sdk';
import { ethers } from 'ethers';
import type { DiscoveredTakeTargetStats } from '../../src/discovery/take-executor';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../../src/take/external-take/execution-plan';
import type {
  ExternalTakeQuoteEvaluation,
  TakeDecision,
} from '../../src/take/types';
import {
  LiquiditySource,
  formatLiquiditySource,
  type ExternalTakePathKind,
} from '../../src/config';
import type { ConfigArtifact } from './config-smoke';

const ERC20_ALLOWANCE_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
];

type LiquidationStatusSnapshot = {
  collateral: string;
  debtToCover?: string;
  price: string;
};

type FixtureSummary = {
  rpcUrl: string;
  pool: {
    address: string;
  };
  borrower: {
    owner: string;
  };
  liquidationCheck: {
    keeperKickEligibleByCurrentCode: boolean;
  };
  uniswapV3ExternalTake?: {
    routerConfig: {
      swapRouter02Address: string;
      defaultFeeTier: number;
    };
    expectedExecutionFeeTier?: number;
    deployment: {
      keeperTakerRouter: string;
      uniswapV3Taker: string;
      aggregatorTakers?: Array<{
        key: 'Lifi' | 'SushiAggregator' | 'OneInchAggregator';
        source: number;
        takerAddress: string;
        targetAddress: string;
      }>;
    };
  };
};

// Map a selected-source label (formatLiquiditySource output) to the
// aggregatorTakers descriptor key, so the route artifact can report the taker
// that actually executed instead of the hardcoded Uniswap one.
const AGGREGATOR_LABEL_TO_KEY: Record<string, string> = {
  LIFI: 'Lifi',
  SUSHI_AGGREGATOR: 'SushiAggregator',
  ONEINCH: 'OneInchAggregator',
};

export type HarnessReport = {
  mode: 'manual' | 'discovery';
  hybridGasQuoteFailureFallbackMode?: 'disabled' | 'direct_dex_first';
  summaryPath: string;
  rpcUrl: string;
  borrower: string;
  derivedKickReferencePrice: number;
  keeperKickEligibleBefore: boolean;
  keeperQuoteBalanceBefore: string;
  keeperQuoteBalanceAfter: string;
  kickExecuted: boolean;
  liquidationStatusAfterKick?: LiquidationStatusSnapshot;
  takeExecuted: boolean;
  liquidationStatusAfterTake?: LiquidationStatusSnapshot | null;
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

export type RouteDecisionEvent = {
  phase: 'attempt' | 'executed';
  approvedTake: boolean;
  approvedArbTake: boolean;
  executedTake?: boolean;
  executedArbTake?: boolean;
  borrower: string;
  route?: SerializedRouteEvaluation;
};

export type RouteSkipEvent = {
  stage: 'evaluation' | 'revalidation' | 'execution';
  borrower: string;
  poolAddress: string;
  reason: string;
  approvedTake?: boolean;
  approvedArbTake?: boolean;
  route?: SerializedRouteEvaluation;
};

export type RouteArtifact = {
  selectedPath?: string;
  selectedLiquiditySource?: string;
  selectedFeeTier?: number;
  expectedExecutionFeeTier?: number;
  factoryRegistryAddress?: string;
  selectedTakerAddress?: string;
  decisions: RouteDecisionEvent[];
  counters?: {
    approvedDirectDexPathTakes: number;
    dryRunDirectDexPathTakes: number;
    executedDirectDexPathTakes: number;
    approvedUniswapV3Takes: number;
    dryRunUniswapV3Takes: number;
    executedUniswapV3Takes: number;
    preBroadcastFailures: number;
    postSubmissionFailures: number;
  };
};

export type PolicyArtifact = {
  allowedExternalTakePaths: ExternalTakePathKind[];
  allowedLiquiditySources: string[];
  externalTakeRouteSelectionMode: 'maximize_profit' | 'direct_dex_first';
  hybridGasQuoteFailureFallbackMode?: 'disabled' | 'direct_dex_first';
  maxGasCostNative?: number;
  minExpectedProfitQuote?: number;
  maxConcurrentCandidateEvaluations: number;
  maxInFlightRouteProbes: number;
  maxExecutionsPerPoolPerRun: number;
  takeRouteQuoteBudgetPerCandidate?: number;
  takeQuoteBudgetPerRun?: number;
};

export type SkipArtifact = {
  events: RouteSkipEvent[];
  reasons: string[];
  evaluationSkips: number;
  revalidationSkips: number;
  executionSkips: number;
  gasPolicyRejects: number;
  profitFloorRejects: number;
  routeProbeAbandonedCount?: number;
};

export type ManualArtifact = {
  selectedDeploymentFromManualConfig: boolean;
  lifiNoBroadcastPolicyContextResolved: boolean;
  lifiNoBroadcastReason: string;
};

export type TransactionArtifact = {
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
    matchedDirectDexExecution: boolean;
  }>;
};

export type ReceiptArtifact = {
  transactionHash: string;
  status: number | null;
  gasUsed: string;
  blockNumber: number;
  to: string | null;
  from: string;
};

export type BalanceArtifact = {
  quoteToken: string;
  keeper: string;
  before: string;
  after: string;
  delta: string;
  positiveDelta: boolean;
};

export type ApprovalArtifact = {
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

export type TransportArtifact = {
  readRpcEndpointClass: 'localhost';
  subgraphEndpointClass: 'fixture_override';
  selectedWriteTransportMode: 'public_rpc';
  noEgressGuardEnabled: boolean;
};

export type EnvArtifact = {
  allowedSecretSources: string[];
  rawSecretValuesRecorded: false;
  envNamesWithSecretLikeLabels: string[];
  expectedLocalSecretEnvNames: string[];
  unexpectedSecretLikeEnvNames: string[];
};

export type StateArtifact = {
  auctionBeforeTake: LiquidationStatusSnapshot | null;
  auctionAfterTake: LiquidationStatusSnapshot | null;
  collateralReduced: boolean;
  debtReducedOrNoCollateralRemaining: boolean;
  blockBeforeTake: number;
  blockAfterTake: number;
};

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
    if (value === 'calldata_aggregator') {
      return 'calldata_aggregator';
    }
    if (value !== 'direct_dex') {
      throw new Error(
        'AJNA_AGENT_HARNESS_ALLOWED_EXTERNAL_TAKE_PATHS must contain only direct_dex or calldata_aggregator'
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
    throw new Error(
      'SushiSwap (source id 3) is deprecated and unsupported as an active liquidity source'
    );
  }
  if (value === 'CURVE' || value === '4') {
    return LiquiditySource.CURVE;
  }
  if (value === 'LIFI' || value === 'LI.FI' || value === '5') {
    return LiquiditySource.LIFI;
  }
  if (
    value === 'SUSHI_AGGREGATOR' ||
    value === 'SUSHIAGGREGATOR' ||
    value === '6'
  ) {
    return LiquiditySource.SUSHI_AGGREGATOR;
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

function optionalRouteSelectionMode(): 'maximize_profit' | 'direct_dex_first' {
  const raw = process.env.AJNA_AGENT_HARNESS_ROUTE_SELECTION_MODE;
  if (raw === undefined || raw.trim().length === 0) {
    return 'maximize_profit';
  }
  if (raw !== 'maximize_profit' && raw !== 'direct_dex_first') {
    throw new Error(
      'AJNA_AGENT_HARNESS_ROUTE_SELECTION_MODE must be maximize_profit or direct_dex_first'
    );
  }
  return raw;
}

export function buildPolicyArtifact(params: {
  hybridGasQuoteFailureFallbackMode: 'disabled' | 'direct_dex_first';
}): PolicyArtifact {
  return {
    allowedExternalTakePaths: optionalExternalTakePathsEnv([
      'calldata_aggregator',
      'direct_dex',
    ]),
    allowedLiquiditySources: optionalLiquiditySourcesEnv([
      LiquiditySource.UNISWAPV3,
    ]).map(formatLiquiditySource),
    externalTakeRouteSelectionMode: optionalRouteSelectionMode(),
    hybridGasQuoteFailureFallbackMode: params.hybridGasQuoteFailureFallbackMode,
    maxGasCostNative:
      optionalNumberEnv('AJNA_AGENT_HARNESS_MAX_GAS_COST_NATIVE') ?? 1,
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

export function liquiditySourceLabelsToValues(
  labels: string[]
): LiquiditySource[] {
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

export function serializeDecisionEvent(
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

export function serializeSkipEvent(params: {
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
  pathName: 'direct_dex' | 'calldata_aggregator',
  field:
    | 'approved'
    | 'dryRun'
    | 'executed'
    | 'preBroadcastFailures'
    | 'postSubmissionFailures'
): number {
  return stats.reduce((sum, entry) => {
    return sum + Number(entry.externalTakeByPath?.[pathName]?.[field] ?? 0);
  }, 0);
}

export function buildRouteArtifact(params: {
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
      (params.mode === 'manual' ? 'direct_dex' : undefined),
    selectedLiquiditySource:
      lastRouteEvent?.route?.selectedLiquiditySource ??
      (params.mode === 'manual' ? expectedSource : undefined),
    selectedFeeTier:
      lastRouteEvent?.route?.selectedFeeTier ??
      uniswapV3ExternalTake?.expectedExecutionFeeTier ??
      uniswapV3ExternalTake?.routerConfig.defaultFeeTier,
    expectedExecutionFeeTier: uniswapV3ExternalTake?.expectedExecutionFeeTier,
    factoryRegistryAddress:
      uniswapV3ExternalTake?.deployment.keeperTakerRouter,
    // Derive the executed taker from the selected source: for an aggregator
    // winner, resolve its taker from aggregatorTakers; otherwise the Uniswap
    // taker (the shared TakerRouter, factoryRegistryAddress, is correct as-is).
    selectedTakerAddress: (() => {
      const label = lastRouteEvent?.route?.selectedLiquiditySource;
      const aggregatorKey = label ? AGGREGATOR_LABEL_TO_KEY[label] : undefined;
      const aggregatorTaker = aggregatorKey
        ? uniswapV3ExternalTake?.deployment.aggregatorTakers?.find(
            (taker) => taker.key === aggregatorKey
          )
        : undefined;
      return (
        aggregatorTaker?.takerAddress ??
        uniswapV3ExternalTake?.deployment.uniswapV3Taker
      );
    })(),
    decisions: params.routeDecisionEvents,
    counters:
      params.mode === 'discovery'
        ? {
            approvedDirectDexPathTakes: sumDiscoveryPathCounter(
              params.discoveryStats,
              'direct_dex',
              'approved'
            ),
            dryRunDirectDexPathTakes: sumDiscoveryPathCounter(
              params.discoveryStats,
              'direct_dex',
              'dryRun'
            ),
            executedDirectDexPathTakes: sumDiscoveryPathCounter(
              params.discoveryStats,
              'direct_dex',
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
              'direct_dex',
              'preBroadcastFailures'
            ),
            postSubmissionFailures: sumDiscoveryPathCounter(
              params.discoveryStats,
              'direct_dex',
              'postSubmissionFailures'
            ),
          }
        : undefined,
  };
}

export function buildSkipArtifact(params: {
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

export async function readApprovalChecks(params: {
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

export async function finalizeApprovalChecks(params: {
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

export async function collectTransactionArtifact(params: {
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
      const matchedDirectDexExecution =
        tx.from.toLowerCase() === keeperAddress &&
        tx.to?.toLowerCase() === factoryAddress;
      if (tx.from.toLowerCase() !== keeperAddress && !matchedDirectDexExecution) {
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
        matchedDirectDexExecution,
      };
      transactions.push(artifact);
      if (matchedDirectDexExecution && selectedReceipt === null) {
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

export function buildBalanceArtifact(params: {
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

export function hasDebtReducedOrNoCollateralRemaining(params: {
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

export function buildTransportArtifact(): TransportArtifact {
  return {
    readRpcEndpointClass: 'localhost',
    subgraphEndpointClass: 'fixture_override',
    selectedWriteTransportMode: 'public_rpc',
    noEgressGuardEnabled: process.env.AJNA_NO_EGRESS_GUARD_ENABLED === '1',
  };
}

export function buildEnvArtifact(): EnvArtifact {
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
