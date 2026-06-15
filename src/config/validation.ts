import {
  ExternalTakeRouteSelectionMode,
  ExternalTakeTransportPolicy,
  ExternalTakePathKind,
  CalldataAggregatorProviderId,
  HybridGasQuoteFailureFallbackMode,
  KeeperConfig,
  LiquiditySource,
  PostAuctionDex,
  SettlementConfig,
  TakeSettings,
  TakeWriteTransportMode,
  UniswapV3RouterOverrides,
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
  getManualPools,
  hasExternalTakeSettings,
  hasNonEmptyObject,
} from './schema';
import {
  EXTERNAL_TAKE_ROUTE_SELECTION_MODES,
  HYBRID_GAS_QUOTE_FAILURE_FALLBACK_MODES,
  isDirectDexDynamicSource,
  normalizeExternalTakeRouteSelectionMode,
  resolveExternalTakePolicy,
  resolveHybridGasQuoteFallbackPolicy,
} from './route-policy';
import type { RawExternalTakePolicyInputs } from './route-policy';
import {
  formatSupportedExternalTakeLiquiditySources,
  formatSupportedExternalTakePaths,
  getAggregatorProviderIdentity,
  getExternalTakeTakerContractKeyForSource,
  getExternalTakePathDefaultSource,
  getExternalTakePathDescriptor,
  getExternalTakePathDescriptors,
  isExternalTakeLiquiditySource,
  resolveExternalTakePathFromSource,
} from './external-take-descriptors';
import type { ExternalTakeLiquiditySource } from './external-take-descriptors';
import {
  formatLiquiditySource,
  getLiquiditySourceConfig,
  getMissingUniswapV3FactoryRouteConfigFields,
  hasConfiguredWrappedNativeAddress,
  isValidFactoryFeeTier,
  resolveConfiguredGasQuoteLiquiditySource,
  STANDARD_V3_FEE_TIERS,
} from './liquidity-source';
import { logger } from '../logging';
import { ethers } from 'ethers';
import { MARKET_FACTOR_SCALE } from '../constants';
import { LIFI_POLICY_BOUNDS, assertValidLifiDexConfig } from './lifi-policy';
import { validateSushiAggregatorDexRequirements } from './sushi-aggregator-policy';

const EXTERNAL_TAKE_TRANSPORT_POLICIES = new Set<ExternalTakeTransportPolicy>([
  'allow_public',
  'prefer_private_or_relay',
  'require_private_or_relay',
]);
const MAX_CANDIDATE_FEE_TIERS = 8;
const MIN_DEX_GAS_OVERRIDE = BigInt(100_000);
const MAX_DEX_GAS_OVERRIDE = BigInt(2_000_000);
const MAX_MIN_PROFIT_NATIVE_WEI = BigInt('1000000000000000000000000000');
const STANDARD_V3_FEE_TIER_SET: ReadonlySet<number> = new Set(
  STANDARD_V3_FEE_TIERS
);
const VALIDATION_BOUNDS = {
  minL2GasCostBufferBps: 10_000,
  maxL2GasCostBufferBps: 30_000,
  minMarketPriceFactor: 1 / MARKET_FACTOR_SCALE,
  maxMarketPriceFactor: 2,
  // Keep drift tolerance bounded to operationally sane values; 5000 = 50%.
  maxGasPriceDriftToleranceBps: 5_000,
  maxCurveExecutionDelayMs: 60_000,
  maxOneInchQuoteTimeoutMs: 10_000,
  maxExternalTakeProbeTimeoutMs: 10_000,
  maxConcurrentCandidateEvaluations: 4,
  maxExecutionsPerPoolPerRun: 10,
  maxInFlightRouteProbes: 16,
  maxOneInchAggregationExecutorAllowlistEntries: 64,
  maxLifiQuoteTimeoutMs: LIFI_POLICY_BOUNDS.maxQuoteTimeoutMs,
};

function validateQuoteDenominatedGasPolicy(
  config: KeeperConfig,
  fieldName: string,
  chainId?: number
): void {
  const liquiditySourceConfig = getLiquiditySourceConfig(config);
  if (
    resolveConfiguredGasQuoteLiquiditySource(liquiditySourceConfig, chainId) ===
    undefined
  ) {
    throw new Error(
      `${fieldName} requires a configured native-to-quote liquidity source`
    );
  }
  if (!hasConfiguredWrappedNativeAddress(liquiditySourceConfig)) {
    throw new Error(
      `${fieldName} requires a configured wrapped native token address`
    );
  }
}

function validateDecimalStringBigInt(value: unknown, fieldName: string): void {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(
      `${fieldName} must be a non-negative decimal integer string`
    );
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requirePositive(value: unknown, message: string): void {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new Error(message);
  }
}

function requireNonNegative(value: unknown, message: string): void {
  if (!isFiniteNumber(value) || value < 0) {
    throw new Error(message);
  }
}

function requireOptionalPositive(value: unknown, message: string): void {
  if (value !== undefined) {
    requirePositive(value, message);
  }
}

function requireOptionalPositiveInteger(value: unknown, message: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
  ) {
    throw new Error(message);
  }
}

function requireOptionalNonNegative(value: unknown, message: string): void {
  if (value !== undefined) {
    requireNonNegative(value, message);
  }
}

function requireOptionalPercentage(value: unknown, message: string): void {
  if (
    value !== undefined &&
    (!isFiniteNumber(value) || value < 0 || value > 100)
  ) {
    throw new Error(message);
  }
}

function requireOptionalBoolean(value: unknown, message: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(message);
  }
}

function requireOptionalIntegerRange(
  value: unknown,
  min: number,
  max: number,
  message: string
): void {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(message);
  }
}

function validateDefaultFeeTier(
  defaultFeeTier: number | undefined,
  fieldName: string
): void {
  if (defaultFeeTier !== undefined && !isValidFactoryFeeTier(defaultFeeTier)) {
    throw new Error(
      `${fieldName}: defaultFeeTier must be a positive uint24 fee tier`
    );
  }
}

function validateCandidateFeeTiers(
  tiers: number[] | undefined,
  defaultFeeTier: number | undefined,
  fieldName: string
): void {
  validateDefaultFeeTier(defaultFeeTier, fieldName);

  if (tiers === undefined) {
    return;
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error(
      `${fieldName}: candidateFeeTiers must be a non-empty array`
    );
  }
  if (tiers.length > MAX_CANDIDATE_FEE_TIERS) {
    throw new Error(
      `${fieldName}: candidateFeeTiers cannot contain more than ${MAX_CANDIDATE_FEE_TIERS} entries`
    );
  }

  const seen = new Set<number>();
  for (const tier of tiers) {
    if (!isValidFactoryFeeTier(tier)) {
      throw new Error(
        `${fieldName}: candidateFeeTiers must contain only positive uint24 fee tiers`
      );
    }
    if (seen.has(tier)) {
      throw new Error(
        `${fieldName}: candidateFeeTiers cannot contain duplicates`
      );
    }
    if (!STANDARD_V3_FEE_TIER_SET.has(tier)) {
      logger.warn(
        `${fieldName}: candidateFeeTiers includes non-standard fee tier ${tier}; verify this tier is deployed on the target DEX before production use`
      );
    }
    seen.add(tier);
  }
}

function validateRouterFeeTiers(config: KeeperConfig): void {
  const uniswapConfig: UniswapV3RouterOverrides | undefined =
    config.dex?.uniswapV3?.router;
  const universalRouterConfig = config.dex?.uniswapV3?.universalRouter;
  requireOptionalPercentage(
    config.dex?.oneInch?.defaultSlippage,
    'KeeperConfig.dex.oneInch.defaultSlippage must be a number between 0 and 100'
  );
  requireOptionalIntegerRange(
    config.dex?.curve?.executionDelayMs,
    0,
    VALIDATION_BOUNDS.maxCurveExecutionDelayMs,
    `KeeperConfig.dex.curve.executionDelayMs must be an integer between 0 and ${VALIDATION_BOUNDS.maxCurveExecutionDelayMs}`
  );
  validateCandidateFeeTiers(
    uniswapConfig?.candidateFeeTiers,
    uniswapConfig?.defaultFeeTier,
    'KeeperConfig.dex.uniswapV3.router'
  );
  validateDefaultFeeTier(
    universalRouterConfig?.defaultFeeTier,
    'KeeperConfig.dex.uniswapV3.universalRouter'
  );
}

function parseLiquiditySourceKey(source: string): LiquiditySource | undefined {
  const parsed = Number(source);
  if (!Number.isInteger(parsed)) {
    return undefined;
  }
  return Object.values(LiquiditySource).includes(parsed)
    ? (parsed as LiquiditySource)
    : undefined;
}

function getEffectiveFactoryRouteSources(
  discoveredTake: TakeSettings,
  allowedLiquiditySources: LiquiditySource[] | undefined,
  defaultDirectDexLiquiditySource?: LiquiditySource
): Set<LiquiditySource> {
  return new Set(
    resolveExternalTakePolicy({
      defaultLiquiditySource: discoveredTake.liquiditySource,
      takePolicy: { allowedLiquiditySources, defaultDirectDexLiquiditySource },
    }).directDexRouteSources
  );
}

function getEffectiveTakeGasOverrideSources(
  discoveredTake: TakeSettings,
  allowedLiquiditySources: LiquiditySource[] | undefined,
  defaultDirectDexLiquiditySource: LiquiditySource | undefined,
  externalTakePaths: Set<ExternalTakePathKind>,
  calldataAggregatorSources: readonly ExternalTakeLiquiditySource[]
): Set<LiquiditySource> {
  const sources = getEffectiveFactoryRouteSources(
    discoveredTake,
    allowedLiquiditySources,
    defaultDirectDexLiquiditySource
  );
  for (const path of Array.from(externalTakePaths)) {
    if (path === 'calldata_aggregator') {
      for (const source of calldataAggregatorSources) {
        sources.add(source);
      }
      continue;
    }
    const defaultSource = getExternalTakePathDefaultSource(path);
    if (defaultSource !== undefined) {
      sources.add(defaultSource);
    }
  }
  return sources;
}

// Path/provider/default-source interpretation and its validation live in
// resolveExternalTakePolicy (src/config/route-policy.ts); this is the
// one-line delegation the resolver boundary allows in this legacy-frozen file.
function getEffectiveExternalTakePaths(
  discoveredTake: TakeSettings,
  takePolicy: RawExternalTakePolicyInputs | undefined
): Set<ExternalTakePathKind> {
  return new Set(
    resolveExternalTakePolicy({
      defaultLiquiditySource: discoveredTake.liquiditySource,
      takePolicy,
    }).externalTakePaths
  );
}

function getEffectiveCalldataAggregatorProviders(
  discoveredTake: TakeSettings,
  takePolicy: RawExternalTakePolicyInputs | undefined
): Set<CalldataAggregatorProviderId> {
  return new Set(
    resolveExternalTakePolicy({
      defaultLiquiditySource: discoveredTake.liquiditySource,
      takePolicy,
    }).calldataAggregatorProviders
  );
}

function getEffectiveCalldataAggregatorSources(
  discoveredTake: TakeSettings,
  takePolicy: RawExternalTakePolicyInputs | undefined
): ExternalTakeLiquiditySource[] {
  return Array.from(
    getEffectiveCalldataAggregatorProviders(discoveredTake, takePolicy),
    (providerId) => getAggregatorProviderIdentity(providerId).liquiditySource
  );
}

function validateExternalTakeTransportPolicy(
  policy: ExternalTakeTransportPolicy | undefined
): void {
  if (policy === undefined) {
    return;
  }
  if (!EXTERNAL_TAKE_TRANSPORT_POLICIES.has(policy)) {
    throw new Error(
      'AutoDiscoverConfig.take: externalTakeTransportPolicy must be allow_public, prefer_private_or_relay, or require_private_or_relay'
    );
  }
}

function validateExternalTakeRouteSelectionMode(
  mode: ExternalTakeRouteSelectionMode | undefined
): void {
  if (mode === undefined) {
    return;
  }
  if (!EXTERNAL_TAKE_ROUTE_SELECTION_MODES.has(mode)) {
    throw new Error(
      'AutoDiscoverConfig.take: externalTakeRouteSelectionMode must be maximize_profit or direct_dex_first'
    );
  }
}

function validateHybridGasQuoteFailureFallbackMode(
  mode: HybridGasQuoteFailureFallbackMode | undefined
): void {
  if (mode === undefined) {
    return;
  }
  if (!HYBRID_GAS_QUOTE_FAILURE_FALLBACK_MODES.has(mode)) {
    throw new Error(
      'AutoDiscoverConfig.take: hybridGasQuoteFailureFallbackMode must be disabled or direct_dex_first'
    );
  }
}

function validateOneInchAggregationExecutorAllowlist(
  config: KeeperConfig
): void {
  const allowlist = config.dex?.oneInch?.aggregationExecutorAllowlist;
  if (allowlist === undefined) {
    return;
  }
  if (
    typeof allowlist !== 'object' ||
    allowlist === null ||
    Array.isArray(allowlist)
  ) {
    throw new Error(
      'KeeperConfig.dex.oneInch.aggregationExecutorAllowlist must be an object keyed by chainId'
    );
  }

  for (const [chainId, executors] of Object.entries(allowlist)) {
    const parsedChainId = Number(chainId);
    if (
      !/^[1-9]\d*$/.test(chainId) ||
      !Number.isInteger(parsedChainId) ||
      parsedChainId <= 0 ||
      String(parsedChainId) !== chainId ||
      !Array.isArray(executors) ||
      executors.length === 0
    ) {
      throw new Error(
        'KeeperConfig.dex.oneInch.aggregationExecutorAllowlist entries must use canonical positive integer chain ID keys and non-empty address arrays'
      );
    }
    if (
      executors.length >
      VALIDATION_BOUNDS.maxOneInchAggregationExecutorAllowlistEntries
    ) {
      throw new Error(
        `KeeperConfig.dex.oneInch.aggregationExecutorAllowlist.${chainId} cannot contain more than ${VALIDATION_BOUNDS.maxOneInchAggregationExecutorAllowlistEntries} addresses`
      );
    }

    const seenExecutors = new Set<string>();
    for (const executor of executors) {
      if (typeof executor !== 'string' || !ethers.utils.isAddress(executor)) {
        throw new Error(
          `KeeperConfig.dex.oneInch.aggregationExecutorAllowlist.${chainId} contains invalid address ${String(executor)}`
        );
      }
      const normalizedExecutor = ethers.utils
        .getAddress(executor)
        .toLowerCase();
      if (seenExecutors.has(normalizedExecutor)) {
        throw new Error(
          `KeeperConfig.dex.oneInch.aggregationExecutorAllowlist.${chainId} cannot contain duplicate addresses`
        );
      }
      seenExecutors.add(normalizedExecutor);
    }
  }
}

function getConfiguredTakeWriteMode(
  config: KeeperConfig
): TakeWriteTransportMode | undefined {
  if (config.writes?.take) {
    return config.writes.take.mode;
  }
  return undefined;
}

function isPrivateOrRelayTakeWriteMode(
  mode: TakeWriteTransportMode | undefined
): boolean {
  return (
    mode === TakeWriteTransportMode.PRIVATE_RPC ||
    mode === TakeWriteTransportMode.RELAY
  );
}

export function validatePostAuctionDex(
  dexProvider: PostAuctionDex,
  config: KeeperConfig
): void {
  switch (dexProvider) {
    case PostAuctionDex.ONEINCH:
      if (!config.dex?.oneInch?.routers) {
        throw new Error(
          'PostAuctionDex.ONEINCH requires dex.oneInch.routers configuration'
        );
      }
      return;
    case PostAuctionDex.UNISWAP_V3:
      if (!config.dex?.uniswapV3?.universalRouter) {
        throw new Error(
          'PostAuctionDex.UNISWAP_V3 requires dex.uniswapV3.universalRouter configuration'
        );
      }
      return;
    case PostAuctionDex.CURVE:
      if (!config.dex?.curve) {
        throw new Error(
          'PostAuctionDex.CURVE requires dex.curve configuration'
        );
      }
      return;
    default:
      throw new Error(`Unsupported PostAuctionDex: ${String(dexProvider)}`);
  }
}

interface ExternalTakeSourceValidationParams {
  keeperConfig: KeeperConfig;
  chainId?: number;
}

type ExternalTakeSourceValidator = (
  params: ExternalTakeSourceValidationParams
) => void;

function requireRegisteredTakerContract(params: {
  keeperConfig: KeeperConfig;
  source: ExternalTakeLiquiditySource;
}): void {
  const sourceName = LiquiditySource[params.source];
  const contractKey = getExternalTakeTakerContractKeyForSource(params.source);
  if (!contractKey) {
    throw new Error(
      `TakeSettings: liquiditySource ${sourceName} does not use a registered taker contract`
    );
  }
  if (!params.keeperConfig.takers?.router) {
    throw new Error(
      `TakeSettings: takers.router required when liquiditySource is ${sourceName}`
    );
  }
  if (!params.keeperConfig.takers.contracts?.[contractKey]) {
    throw new Error(
      `TakeSettings: takers.contracts.${contractKey} required when liquiditySource is ${sourceName}`
    );
  }
}

function validateOneInchTakeSource({
  keeperConfig,
  chainId,
}: ExternalTakeSourceValidationParams): void {
  requireRegisteredTakerContract({
    keeperConfig,
    source: LiquiditySource.ONEINCH,
  });
  if (
    !keeperConfig.dex?.oneInch?.routers ||
    Object.keys(keeperConfig.dex.oneInch.routers).length === 0
  ) {
    throw new Error(
      'TakeSettings: dex.oneInch.routers required when liquiditySource is ONEINCH'
    );
  }
  if (chainId !== undefined && !keeperConfig.dex.oneInch.routers[chainId]) {
    throw new Error(
      `TakeSettings: dex.oneInch.routers missing router for chain ${chainId}`
    );
  }
}

function validateUniswapV3TakeSource({
  keeperConfig,
}: ExternalTakeSourceValidationParams): void {
  requireRegisteredTakerContract({
    keeperConfig,
    source: LiquiditySource.UNISWAPV3,
  });
  if (!keeperConfig.dex?.uniswapV3?.router) {
    throw new Error(
      'TakeSettings: dex.uniswapV3.router required when liquiditySource is UNISWAPV3'
    );
  }
  const routerOverrides = keeperConfig.dex.uniswapV3.router;
  if (getMissingUniswapV3FactoryRouteConfigFields(routerOverrides).length > 0) {
    throw new Error(
      'TakeSettings: dex.uniswapV3.router.swapRouter02Address, poolFactoryAddress, wethAddress, and quoterV2Address required when liquiditySource is UNISWAPV3'
    );
  }
}

function validateCurveTakeSource({
  keeperConfig,
}: ExternalTakeSourceValidationParams): void {
  requireRegisteredTakerContract({
    keeperConfig,
    source: LiquiditySource.CURVE,
  });
  if (!keeperConfig.dex?.curve) {
    throw new Error(
      'TakeSettings: dex.curve required when liquiditySource is CURVE'
    );
  }
  const routerOverrides = keeperConfig.dex.curve;
  if (
    !hasNonEmptyObject(routerOverrides.poolConfigs) ||
    !routerOverrides.wethAddress
  ) {
    throw new Error(
      'TakeSettings: dex.curve.poolConfigs and wethAddress required when liquiditySource is CURVE'
    );
  }
  if (
    !keeperConfig.network.tokenAddresses ||
    Object.keys(keeperConfig.network.tokenAddresses).length === 0
  ) {
    throw new Error(
      'TakeSettings: network.tokenAddresses required when liquiditySource is CURVE'
    );
  }
}

function validateLifiTakeSource({
  keeperConfig,
  chainId,
}: ExternalTakeSourceValidationParams): void {
  requireRegisteredTakerContract({
    keeperConfig,
    source: LiquiditySource.LIFI,
  });
  assertValidLifiDexConfig({
    config: keeperConfig.dex?.lifi,
    fieldName: 'KeeperConfig.dex.lifi',
    chainId,
    requireProduction: keeperConfig.runtime?.dryRun !== true,
  });
}

function validateSushiAggregatorTakeSource({
  keeperConfig,
  chainId,
}: ExternalTakeSourceValidationParams): void {
  requireRegisteredTakerContract({
    keeperConfig,
    source: LiquiditySource.SUSHI_AGGREGATOR,
  });
  validateSushiAggregatorDexRequirements({ keeperConfig, chainId });
}

const EXTERNAL_TAKE_SOURCE_VALIDATORS = {
  [LiquiditySource.ONEINCH]: validateOneInchTakeSource,
  [LiquiditySource.UNISWAPV3]: validateUniswapV3TakeSource,
  [LiquiditySource.CURVE]: validateCurveTakeSource,
  [LiquiditySource.LIFI]: validateLifiTakeSource,
  [LiquiditySource.SUSHI_AGGREGATOR]: validateSushiAggregatorTakeSource,
} satisfies Record<ExternalTakeLiquiditySource, ExternalTakeSourceValidator>;

function validateExternalTakeSourceRequirements(params: {
  source: ExternalTakeLiquiditySource;
  keeperConfig: KeeperConfig;
  chainId?: number;
}): void {
  EXTERNAL_TAKE_SOURCE_VALIDATORS[params.source]({
    keeperConfig: params.keeperConfig,
    chainId: params.chainId,
  });
}

export function validateTakeSettings(
  config: TakeSettings,
  keeperConfig: KeeperConfig,
  chainId?: number
): void {
  const hasArbTake =
    config.minCollateral !== undefined && config.hpbPriceFactor !== undefined;
  const hasTake = hasExternalTakeSettings(config);

  if (!hasArbTake && !hasTake) {
    throw new Error(
      'TakeSettings: Must configure arbTake (minCollateral, hpbPriceFactor) or take (liquiditySource, marketPriceFactor)'
    );
  }

  if (hasTake) {
    const liquiditySource = config.liquiditySource;
    if (liquiditySource === LiquiditySource.NONE) {
      throw new Error('TakeSettings: liquiditySource cannot be NONE');
    }

    if (!isExternalTakeLiquiditySource(liquiditySource)) {
      throw new Error(
        `TakeSettings: liquiditySource must be ${formatSupportedExternalTakeLiquiditySources()}`
      );
    }

    requirePositive(
      config.marketPriceFactor,
      'TakeSettings: marketPriceFactor must be positive'
    );
    if (
      config.marketPriceFactor !== undefined &&
      config.marketPriceFactor < VALIDATION_BOUNDS.minMarketPriceFactor
    ) {
      throw new Error(
        `TakeSettings: marketPriceFactor ${config.marketPriceFactor} is below the minimum supported precision ${VALIDATION_BOUNDS.minMarketPriceFactor.toFixed(6)}`
      );
    }
    if (
      config.marketPriceFactor !== undefined &&
      config.marketPriceFactor > VALIDATION_BOUNDS.maxMarketPriceFactor
    ) {
      throw new Error(
        `TakeSettings: marketPriceFactor ${config.marketPriceFactor} is unreasonable; values above ${VALIDATION_BOUNDS.maxMarketPriceFactor} are rejected because values above 1 weaken market-factor protection. Did you mean ${config.marketPriceFactor / 100}?`
      );
    }
    requireOptionalBoolean(
      config.allowSubsidy,
      'TakeSettings: allowSubsidy must be a boolean'
    );

    validateExternalTakeSourceRequirements({
      source: liquiditySource,
      keeperConfig,
      chainId,
    });
  }

  if (hasArbTake) {
    requirePositive(
      config.minCollateral,
      'TakeSettings: minCollateral must be greater than 0'
    );
    requirePositive(
      config.hpbPriceFactor,
      'TakeSettings: hpbPriceFactor must be positive'
    );
  }
}

export function validateSettlementSettings(config: SettlementConfig): void {
  if (!config.enabled) {
    throw new Error(
      'SettlementConfig: enabled must be true for active settlement targets'
    );
  }
  requireOptionalNonNegative(
    config.minAuctionAge,
    'SettlementConfig: minAuctionAge cannot be negative'
  );
  requireOptionalPositive(
    config.maxBucketDepth,
    'SettlementConfig: maxBucketDepth must be greater than 0'
  );
  requireOptionalPositive(
    config.maxIterations,
    'SettlementConfig: maxIterations must be greater than 0'
  );
}

export function validateAutoDiscoverConfig(
  config: KeeperConfig,
  chainId?: number
): void {
  validateRouterFeeTiers(config);
  validateOneInchAggregationExecutorAllowlist(config);

  const autoDiscover = config.discovery;
  if (!autoDiscover?.enabled) {
    return;
  }
  const takePolicy = getAutoDiscoverTakePolicy(autoDiscover);
  const settlementPolicy = getAutoDiscoverSettlementPolicy(autoDiscover);

  if (autoDiscover.kick) {
    throw new Error(
      'AutoDiscoverConfig: kick discovery is not supported in V1'
    );
  }
  if (!takePolicy && !settlementPolicy) {
    throw new Error(
      'AutoDiscoverConfig: enable at least one of take or settlement'
    );
  }
  requireOptionalNonNegative(
    autoDiscover.hydrateCooldownSec,
    'AutoDiscoverConfig: hydrateCooldownSec cannot be negative'
  );

  if (takePolicy) {
    requireOptionalPositiveInteger(
      takePolicy.maxPoolsPerRun,
      'AutoDiscoverConfig.take: maxPoolsPerRun must be a positive integer'
    );
    requireOptionalPositiveInteger(
      takePolicy.takeQuoteBudgetPerRun,
      'AutoDiscoverConfig.take: takeQuoteBudgetPerRun must be a positive integer'
    );
    requireOptionalNonNegative(
      takePolicy.hotAuctionCandidateTtlMs,
      'AutoDiscoverConfig.take: hotAuctionCandidateTtlMs cannot be negative'
    );
    requireOptionalPositiveInteger(
      takePolicy.maxHotAuctionCandidates,
      'AutoDiscoverConfig.take: maxHotAuctionCandidates must be a positive integer'
    );
    requireOptionalPositiveInteger(
      takePolicy.takeRouteQuoteBudgetPerCandidate,
      'AutoDiscoverConfig.take: takeRouteQuoteBudgetPerCandidate must be a positive integer'
    );
    requireOptionalIntegerRange(
      takePolicy.maxConcurrentCandidateEvaluations,
      1,
      VALIDATION_BOUNDS.maxConcurrentCandidateEvaluations,
      `AutoDiscoverConfig.take: maxConcurrentCandidateEvaluations must be an integer between 1 and ${VALIDATION_BOUNDS.maxConcurrentCandidateEvaluations}`
    );
    requireOptionalIntegerRange(
      takePolicy.maxExecutionsPerPoolPerRun,
      1,
      VALIDATION_BOUNDS.maxExecutionsPerPoolPerRun,
      `AutoDiscoverConfig.take: maxExecutionsPerPoolPerRun must be an integer between 1 and ${VALIDATION_BOUNDS.maxExecutionsPerPoolPerRun}`
    );
    requireOptionalIntegerRange(
      takePolicy.maxInFlightRouteProbes,
      1,
      VALIDATION_BOUNDS.maxInFlightRouteProbes,
      `AutoDiscoverConfig.take: maxInFlightRouteProbes must be an integer between 1 and ${VALIDATION_BOUNDS.maxInFlightRouteProbes}`
    );
    if (
      takePolicy.maxInFlightRouteProbes !== undefined &&
      (takePolicy.maxConcurrentCandidateEvaluations ?? 1) <= 1
    ) {
      logger.warn(
        'AutoDiscoverConfig.take: maxInFlightRouteProbes is configured but maxConcurrentCandidateEvaluations is 1; the global route probe limiter is only enforced for parallel candidate evaluation'
      );
    }
    if (
      (takePolicy.maxExecutionsPerPoolPerRun ?? 1) > 1 &&
      (takePolicy.maxConcurrentCandidateEvaluations ?? 1) > 1
    ) {
      logger.warn(
        'AutoDiscoverConfig.take: maxExecutionsPerPoolPerRun > 1 forces sequential same-pool candidate evaluation; maxConcurrentCandidateEvaluations is ignored for those pools'
      );
    }
    requireOptionalNonNegative(
      takePolicy.l1GasPriceFreshnessTtlMs,
      'AutoDiscoverConfig.take: l1GasPriceFreshnessTtlMs cannot be negative'
    );
    requireOptionalNonNegative(
      takePolicy.l2GasPriceFreshnessTtlMs,
      'AutoDiscoverConfig.take: l2GasPriceFreshnessTtlMs cannot be negative'
    );
    requireOptionalIntegerRange(
      takePolicy.l2GasCostBufferBasisPoints,
      VALIDATION_BOUNDS.minL2GasCostBufferBps,
      VALIDATION_BOUNDS.maxL2GasCostBufferBps,
      'AutoDiscoverConfig.take: l2GasCostBufferBasisPoints must be an integer between 10000 and 30000'
    );
    requireOptionalIntegerRange(
      takePolicy.gasPriceDriftToleranceBasisPoints,
      0,
      VALIDATION_BOUNDS.maxGasPriceDriftToleranceBps,
      'AutoDiscoverConfig.take: gasPriceDriftToleranceBasisPoints must be an integer between 0 and 5000'
    );
    requireOptionalIntegerRange(
      takePolicy.oneInchQuoteTimeoutMs,
      1,
      VALIDATION_BOUNDS.maxOneInchQuoteTimeoutMs,
      `AutoDiscoverConfig.take: oneInchQuoteTimeoutMs must be an integer between 1 and ${VALIDATION_BOUNDS.maxOneInchQuoteTimeoutMs}`
    );
    requireOptionalPositive(
      takePolicy.oneInchQuoteFailureCooldownMs,
      'AutoDiscoverConfig.take: oneInchQuoteFailureCooldownMs must be greater than 0'
    );
    requireOptionalIntegerRange(
      takePolicy.oneInchQuoteFailureThreshold,
      1,
      100,
      'AutoDiscoverConfig.take: oneInchQuoteFailureThreshold must be an integer between 1 and 100'
    );
    requireOptionalIntegerRange(
      takePolicy.externalTakeProbeTimeoutMs,
      1,
      VALIDATION_BOUNDS.maxExternalTakeProbeTimeoutMs,
      `AutoDiscoverConfig.take: externalTakeProbeTimeoutMs must be an integer between 1 and ${VALIDATION_BOUNDS.maxExternalTakeProbeTimeoutMs}`
    );
    validateExternalTakeRouteSelectionMode(
      takePolicy.externalTakeRouteSelectionMode
    );
    validateHybridGasQuoteFailureFallbackMode(
      takePolicy.hybridGasQuoteFailureFallbackMode
    );
    requireOptionalBoolean(
      takePolicy.validateRouteDeployments,
      'AutoDiscoverConfig.take: validateRouteDeployments must be a boolean'
    );
    validateExternalTakeTransportPolicy(takePolicy.externalTakeTransportPolicy);
    if (
      takePolicy.externalTakeTransportPolicy === 'require_private_or_relay' &&
      !isPrivateOrRelayTakeWriteMode(getConfiguredTakeWriteMode(config)) &&
      !config.runtime.dryRun
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: externalTakeTransportPolicy=require_private_or_relay requires writes.take.mode private_rpc or relay'
      );
    }
    if (
      (takePolicy.externalTakeTransportPolicy === 'prefer_private_or_relay' ||
        (takePolicy.externalTakeTransportPolicy ===
          'require_private_or_relay' &&
          config.runtime.dryRun)) &&
      !isPrivateOrRelayTakeWriteMode(getConfiguredTakeWriteMode(config))
    ) {
      logger.warn(
        `AutoDiscoverConfig.take: externalTakeTransportPolicy=${takePolicy.externalTakeTransportPolicy} is set but no private_rpc/relay writes.take transport is configured; discovered external takes may use public RPC fallback`
      );
    }
    requireOptionalNonNegative(
      takePolicy.minExpectedProfitQuote,
      'AutoDiscoverConfig.take: minExpectedProfitQuote cannot be negative'
    );
    if (takePolicy.minProfitNative !== undefined) {
      validateDecimalStringBigInt(
        takePolicy.minProfitNative,
        'AutoDiscoverConfig.take: minProfitNative'
      );
      const minProfitNativeWei = BigInt(takePolicy.minProfitNative);
      if (minProfitNativeWei === BigInt(0)) {
        logger.warn(
          'AutoDiscoverConfig.take: minProfitNative is set to 0; this is equivalent to disabling the native profit floor'
        );
      }
      if (minProfitNativeWei > MAX_MIN_PROFIT_NATIVE_WEI) {
        throw new Error(
          `AutoDiscoverConfig.take: minProfitNative must not exceed ${MAX_MIN_PROFIT_NATIVE_WEI.toString()} wei`
        );
      }
    }
    if (
      takePolicy.externalTakeRouteSelectionMode === 'direct_dex_first' &&
      (takePolicy.minExpectedProfitQuote !== undefined ||
        takePolicy.minProfitNative !== undefined)
    ) {
      logger.warn(
        `AutoDiscoverConfig.take: externalTakeRouteSelectionMode=${takePolicy.externalTakeRouteSelectionMode} stops after the first non-subsidized approved path; subsidized paths continue probing, but quote-normalized gas-cost ranking is skipped to reduce 1inch/API use`
      );
    }
    requireOptionalPositive(
      takePolicy.maxGasPriceGwei,
      'AutoDiscoverConfig.take: maxGasPriceGwei must be greater than 0'
    );
    requireOptionalNonNegative(
      takePolicy.maxGasCostNative,
      'AutoDiscoverConfig.take: maxGasCostNative cannot be negative'
    );
    requireOptionalNonNegative(
      takePolicy.maxGasCostQuote,
      'AutoDiscoverConfig.take: maxGasCostQuote cannot be negative'
    );

    const discoveredTake = config.discovery?.defaults?.take;
    if (!discoveredTake) {
      throw new Error(
        'AutoDiscoverConfig: discovery.defaults.take required when discovery.take is enabled'
      );
    }
    if (discoveredTake.allowSubsidy === true) {
      logger.warn(
        'AutoDiscoverConfig: discovery.defaults.take.allowSubsidy=true can subsidize external takes on every discovered pool that matches this policy; prefer enabling it only on manually reviewed defensive pools'
      );
      if (
        takePolicy.minExpectedProfitQuote === undefined &&
        takePolicy.minProfitNative === undefined
      ) {
        logger.warn(
          'AutoDiscoverConfig: allowSubsidy=true is configured without minExpectedProfitQuote or minProfitNative; gas/profit shortfall protection is intentionally bypassable for discovered external takes'
        );
      }
    }

    const externalTakePaths = getEffectiveExternalTakePaths(
      discoveredTake,
      takePolicy
    );
    const calldataAggregatorSources = getEffectiveCalldataAggregatorSources(
      discoveredTake,
      takePolicy
    );
    if (takePolicy.hybridGasQuoteFailureFallbackMode === 'direct_dex_first') {
      const fallbackEligibility = resolveHybridGasQuoteFallbackPolicy({
        fallbackMode: takePolicy.hybridGasQuoteFailureFallbackMode,
        routeSelectionMode: normalizeExternalTakeRouteSelectionMode(
          takePolicy.externalTakeRouteSelectionMode
        ),
        externalTakePaths: Array.from(externalTakePaths),
        maxGasCostNative: takePolicy.maxGasCostNative,
        maxGasCostQuote: takePolicy.maxGasCostQuote,
        minExpectedProfitQuote: takePolicy.minExpectedProfitQuote,
        minProfitNative: takePolicy.minProfitNative,
      });
      if (!fallbackEligibility.eligible) {
        const reason =
          fallbackEligibility.reason === 'maxGasCostNative is not configured'
            ? 'AutoDiscoverConfig.take: hybridGasQuoteFailureFallbackMode=direct_dex_first requires maxGasCostNative'
            : `AutoDiscoverConfig.take: hybridGasQuoteFailureFallbackMode=direct_dex_first is ineligible because ${fallbackEligibility.reason}`;
        throw new Error(reason);
      }
    }
    if (
      takePolicy.defaultDirectDexLiquiditySource !== undefined &&
      !isDirectDexDynamicSource(takePolicy.defaultDirectDexLiquiditySource)
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: defaultDirectDexLiquiditySource must be UNISWAPV3 or CURVE'
      );
    }
    const effectiveDefaultDirectDexLiquiditySource = isDirectDexDynamicSource(
      discoveredTake.liquiditySource
    )
      ? discoveredTake.liquiditySource
      : takePolicy.defaultDirectDexLiquiditySource;
    if (
      externalTakePaths.has('direct_dex') &&
      effectiveDefaultDirectDexLiquiditySource === undefined
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: defaultDirectDexLiquiditySource required when allowedExternalTakePaths includes direct_dex and discovery.defaults.take.liquiditySource is not a direct DEX source'
      );
    }
    for (const descriptor of getExternalTakePathDescriptors(
      externalTakePaths
    )) {
      if (
        descriptor.requiresRouteDeploymentValidation &&
        takePolicy.validateRouteDeployments !== true
      ) {
        throw new Error(
          `AutoDiscoverConfig.take: validateRouteDeployments=true required when resolved external take paths include ${descriptor.path}`
        );
      }
    }
    if (
      calldataAggregatorSources.includes(LiquiditySource.ONEINCH)
    ) {
      if (
        !config.dex?.oneInch?.aggregationExecutorAllowlist ||
        Object.keys(config.dex.oneInch.aggregationExecutorAllowlist).length ===
          0
      ) {
        logger.warn(
          'AutoDiscoverConfig.take: dex.oneInch.aggregationExecutorAllowlist is not configured; decoded 1inch aggregationExecutor addresses will be logged but not hard-restricted'
        );
      } else if (
        chainId !== undefined &&
        !config.dex.oneInch.aggregationExecutorAllowlist[chainId]
      ) {
        logger.warn(
          `AutoDiscoverConfig.take: dex.oneInch.aggregationExecutorAllowlist has no entry for chain ${chainId}; decoded 1inch aggregationExecutor addresses will be logged but not hard-restricted`
        );
      }
    }
    for (const descriptor of getExternalTakePathDescriptors(
      externalTakePaths
    )) {
      const defaultSource = descriptor.defaultSource;
      if (
        descriptor.path === 'calldata_aggregator' &&
        descriptor.requiresDexGasOverride
      ) {
        for (const source of calldataAggregatorSources) {
          if (takePolicy.dexGasOverrides?.[source] === undefined) {
            throw new Error(
              `AutoDiscoverConfig.take: dexGasOverrides.${formatLiquiditySource(source)} required when resolved external take paths include ${descriptor.path}`
            );
          }
        }
        continue;
      }
      if (
        descriptor.requiresDexGasOverride &&
        defaultSource !== undefined &&
        takePolicy.dexGasOverrides?.[defaultSource] === undefined
      ) {
        throw new Error(
          `AutoDiscoverConfig.take: dexGasOverrides.${formatLiquiditySource(defaultSource)} required when resolved external take paths include ${descriptor.path}`
        );
      }
    }
    if (externalTakePaths.size > 1) {
      validateQuoteDenominatedGasPolicy(
        config,
        'AutoDiscoverConfig.take: hybrid external take route ranking',
        chainId
      );
    }
    if (
      takePolicy.takeRouteQuoteBudgetPerCandidate !== undefined &&
      !externalTakePaths.has('direct_dex')
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: takeRouteQuoteBudgetPerCandidate requires an enabled direct_dex external take path'
      );
    }

    if (takePolicy.allowedLiquiditySources !== undefined) {
      if (!externalTakePaths.has('direct_dex')) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedLiquiditySources requires a direct_dex external take path'
        );
      }
      if (takePolicy.allowedLiquiditySources.length === 0) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedLiquiditySources must be non-empty'
        );
      }
      const seenSources = new Set<LiquiditySource>();
      for (const source of takePolicy.allowedLiquiditySources) {
        if (seenSources.has(source)) {
          throw new Error(
            'AutoDiscoverConfig.take: allowedLiquiditySources cannot contain duplicates'
          );
        }
        seenSources.add(source);
        if (source === LiquiditySource.ONEINCH) {
          throw new Error(
            'AutoDiscoverConfig.take: allowedLiquiditySources cannot include ONEINCH for direct_dex external takes'
          );
        }
        if (!isDirectDexDynamicSource(source)) {
          throw new Error(
            'AutoDiscoverConfig.take: allowedLiquiditySources currently supports only UNISWAPV3 and CURVE'
          );
        }
        validateTakeSettings(
          {
            ...discoveredTake,
            liquiditySource: source,
          },
          config,
          chainId
        );
      }
      if (
        takePolicy.defaultDirectDexLiquiditySource !== undefined &&
        effectiveDefaultDirectDexLiquiditySource !== undefined &&
        !takePolicy.allowedLiquiditySources.includes(
          effectiveDefaultDirectDexLiquiditySource
        )
      ) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedLiquiditySources must include the effective default direct DEX liquidity source'
        );
      }
    } else {
      if (externalTakePaths.has('direct_dex')) {
        validateTakeSettings(
          {
            ...discoveredTake,
            liquiditySource: effectiveDefaultDirectDexLiquiditySource,
          },
          config,
          chainId
        );
      }
    }

    for (const descriptor of getExternalTakePathDescriptors(
      externalTakePaths
    )) {
      const defaultSource = descriptor.defaultSource;
      if (descriptor.path === 'calldata_aggregator') {
        for (const source of calldataAggregatorSources) {
          validateTakeSettings(
            {
              ...discoveredTake,
              liquiditySource: source,
            },
            config,
            chainId
          );
        }
        continue;
      }
      if (defaultSource === undefined) {
        continue;
      }
      validateTakeSettings(
        {
          ...discoveredTake,
          liquiditySource: defaultSource,
        },
        config,
        chainId
      );
    }

    if (!externalTakePaths.size) {
      validateTakeSettings(discoveredTake, config, chainId);
    }

    const effectiveFactorySources = getEffectiveFactoryRouteSources(
      discoveredTake,
      takePolicy.allowedLiquiditySources,
      effectiveDefaultDirectDexLiquiditySource
    );
    const effectiveTakeGasOverrideSources = getEffectiveTakeGasOverrideSources(
      discoveredTake,
      takePolicy.allowedLiquiditySources,
      effectiveDefaultDirectDexLiquiditySource,
      externalTakePaths,
      calldataAggregatorSources
    );
    if (
      config.dex?.uniswapV3?.router?.candidateFeeTiers !== undefined &&
      !effectiveFactorySources.has(LiquiditySource.UNISWAPV3)
    ) {
      logger.warn(
        'KeeperConfig.dex.uniswapV3.router.candidateFeeTiers configured but UNISWAPV3 is not an enabled autodiscover direct DEX route source'
      );
    }

    if (takePolicy.dexGasOverrides !== undefined) {
      for (const [source, value] of Object.entries(
        takePolicy.dexGasOverrides
      )) {
        if (value === undefined) {
          continue;
        }
        const liquiditySource = parseLiquiditySourceKey(source);
        const sourceLabel =
          liquiditySource !== undefined
            ? formatLiquiditySource(liquiditySource)
            : source;
        if (liquiditySource === undefined) {
          throw new Error(
            `AutoDiscoverConfig.take: dexGasOverrides.${source} is not a valid LiquiditySource`
          );
        }
        const sourcePath = resolveExternalTakePathFromSource(liquiditySource);
        if (
          sourcePath !== undefined &&
          sourcePath !== 'direct_dex' &&
          !effectiveTakeGasOverrideSources.has(liquiditySource)
        ) {
          throw new Error(
            `AutoDiscoverConfig.take: dexGasOverrides.${sourceLabel} requires an enabled ${getExternalTakePathDescriptor(sourcePath).label} external take path`
          );
        }
        if (!effectiveTakeGasOverrideSources.has(liquiditySource)) {
          throw new Error(
            `AutoDiscoverConfig.take: dexGasOverrides.${sourceLabel} is not enabled by the effective take liquidity sources`
          );
        }
        validateDecimalStringBigInt(
          value,
          `AutoDiscoverConfig.take: dexGasOverrides.${source}`
        );
        const gas = BigInt(value);
        if (gas < MIN_DEX_GAS_OVERRIDE || gas > MAX_DEX_GAS_OVERRIDE) {
          throw new Error(
            `AutoDiscoverConfig.take: dexGasOverrides.${source} must be between 100000 and 2000000`
          );
        }
      }
    }

    if (takePolicy.maxGasCostQuote !== undefined) {
      validateQuoteDenominatedGasPolicy(
        config,
        'AutoDiscoverConfig.take: maxGasCostQuote',
        chainId
      );
    }
    if (takePolicy.minProfitNative !== undefined) {
      validateQuoteDenominatedGasPolicy(
        config,
        'AutoDiscoverConfig.take: minProfitNative',
        chainId
      );
    }

    if (
      (takePolicy.minExpectedProfitQuote !== undefined ||
        takePolicy.minProfitNative !== undefined) &&
      (!externalTakePaths.size ||
        discoveredTake.marketPriceFactor === undefined)
    ) {
      throw new Error(
        'AutoDiscoverConfig: quote-normalized profit floors require discovery.defaults.take to configure an external take path'
      );
    }
    if (takePolicy.minExpectedProfitQuote !== undefined) {
      validateQuoteDenominatedGasPolicy(
        config,
        'AutoDiscoverConfig.take: minExpectedProfitQuote',
        chainId
      );
    }
  }

  if (settlementPolicy) {
    requireOptionalPositive(
      settlementPolicy.maxPoolsPerRun,
      'AutoDiscoverConfig.settlement: maxPoolsPerRun must be greater than 0'
    );
    requireOptionalPositive(
      settlementPolicy.maxGasPriceGwei,
      'AutoDiscoverConfig.settlement: maxGasPriceGwei must be greater than 0'
    );
    requireOptionalNonNegative(
      settlementPolicy.maxGasCostNative,
      'AutoDiscoverConfig.settlement: maxGasCostNative cannot be negative'
    );
    requireOptionalNonNegative(
      settlementPolicy.maxGasCostQuote,
      'AutoDiscoverConfig.settlement: maxGasCostQuote cannot be negative'
    );
    if (settlementPolicy.maxGasCostQuote !== undefined) {
      validateQuoteDenominatedGasPolicy(
        config,
        'AutoDiscoverConfig.settlement: maxGasCostQuote',
        chainId
      );
    }

    const discoveredSettlement = config.discovery?.defaults?.settlement;
    if (!discoveredSettlement?.enabled) {
      throw new Error(
        'AutoDiscoverConfig: enabled discovery.defaults.settlement required when discovery.settlement is enabled'
      );
    }
    validateSettlementSettings(discoveredSettlement);
  }
}

export function validateTakeWriteConfig(config: KeeperConfig): void {
  const takeWrite = config.writes?.take;
  if (!takeWrite) {
    return;
  }

  switch (takeWrite.mode) {
    case TakeWriteTransportMode.PUBLIC_RPC:
      requireOptionalPositive(
        takeWrite.receiptTimeoutMs,
        'KeeperConfig.writes.take: receiptTimeoutMs must be greater than 0 when provided'
      );
      return;
    case TakeWriteTransportMode.PRIVATE_RPC:
      if (!takeWrite.rpcUrl) {
        throw new Error(
          'KeeperConfig.writes.take: rpcUrl required when mode is private_rpc'
        );
      }
      requireOptionalPositive(
        takeWrite.receiptTimeoutMs,
        'KeeperConfig.writes.take: receiptTimeoutMs must be greater than 0 when provided'
      );
      return;
    case TakeWriteTransportMode.RELAY:
      if (!takeWrite.relay?.url) {
        throw new Error(
          'KeeperConfig.writes.take: relay.url required when mode is relay'
        );
      }
      requireOptionalPositive(
        takeWrite.relay.maxBlockNumberOffset,
        'KeeperConfig.writes.take: relay.maxBlockNumberOffset must be greater than 0 when provided'
      );
      requireOptionalPositive(
        takeWrite.relay.requestTimeoutMs,
        'KeeperConfig.writes.take: relay.requestTimeoutMs must be greater than 0 when provided'
      );
      requireOptionalPositive(
        takeWrite.receiptTimeoutMs,
        'KeeperConfig.writes.take: receiptTimeoutMs must be greater than 0 when provided'
      );
      requireOptionalPositive(
        takeWrite.relay.receiptTimeoutMs,
        'KeeperConfig.writes.take: relay.receiptTimeoutMs must be greater than 0 when provided'
      );
      return;
    default:
      throw new Error(
        `KeeperConfig.writes.take: unsupported mode ${String(takeWrite.mode)}`
      );
  }
}

export function validateTakeSettingsForChain(
  config: KeeperConfig,
  chainId: number
): void {
  validateRouterFeeTiers(config);
  validateOneInchAggregationExecutorAllowlist(config);

  for (const poolConfig of getManualPools(config)) {
    if (poolConfig.take) {
      if (poolConfig.take.allowSubsidy === true) {
        logger.warn(
          `Pool ${poolConfig.name ?? poolConfig.address} has take.allowSubsidy=true; this can intentionally execute external takes that repay the auction while bypassing gas/profit shortfall protection`
        );
      }
      validateTakeSettings(poolConfig.take, config, chainId);
    }
  }

  const discoveredTake = config.discovery?.defaults?.take;
  if (discoveredTake && getAutoDiscoverTakePolicy(config.discovery)) {
    validateTakeSettings(discoveredTake, config, chainId);
  }
}
