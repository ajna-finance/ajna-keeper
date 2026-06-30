import {
  ExternalTakeRouteSelectionMode,
  ExternalTakeTransportPolicy,
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
} from './route-policy';
import {
  formatSupportedExternalTakeLiquiditySources,
  getExternalTakeTakerContractKeyForSource,
  isExternalTakeLiquiditySource,
} from './external-take-descriptors';
import type { ExternalTakeLiquiditySource } from './external-take-descriptors';
import {
  formatLiquiditySource,
  getLiquiditySourceConfig,
  getMissingUniswapV3DirectDexRouteConfigFields,
  hasConfiguredWrappedNativeAddress,
  isValidV3FeeTier,
  resolveConfiguredGasQuoteLiquiditySource,
  STANDARD_V3_FEE_TIERS,
} from './liquidity-source';
import { logger } from '../logging';
import { ethers } from 'ethers';
import { MARKET_FACTOR_SCALE } from '../constants';
import { LIFI_POLICY_BOUNDS, assertValidLifiDexConfig } from './lifi-policy';
import { assertValidOneInchAggregatorDexConfig } from './oneinch-aggregator-policy';
import { validateSushiAggregatorDexRequirements } from './sushi-aggregator-policy';
import {
  isFiniteNumber,
  requireOptionalPositive,
  requireOptionalIntegerRange,
} from './numeric-validation';
export {
  requireOptionalPositive,
  requireOptionalIntegerRange,
} from './numeric-validation';

const EXTERNAL_TAKE_TRANSPORT_POLICIES = new Set<ExternalTakeTransportPolicy>([
  'allow_public',
  'prefer_private_or_relay',
  'require_private_or_relay',
]);
const MAX_CANDIDATE_FEE_TIERS = 8;
export const MIN_DEX_GAS_OVERRIDE = BigInt(100_000);
export const MAX_DEX_GAS_OVERRIDE = BigInt(2_000_000);
export const MAX_MIN_PROFIT_NATIVE_WEI = BigInt('1000000000000000000000000000');
const STANDARD_V3_FEE_TIER_SET: ReadonlySet<number> = new Set(
  STANDARD_V3_FEE_TIERS
);
export const VALIDATION_BOUNDS = {
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

export function validateQuoteDenominatedGasPolicy(
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

export function validateDecimalStringBigInt(
  value: unknown,
  fieldName: string
): void {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(
      `${fieldName} must be a non-negative decimal integer string`
    );
  }
}

export function requirePositive(value: unknown, message: string): void {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new Error(message);
  }
}

function requireNonNegative(value: unknown, message: string): void {
  if (!isFiniteNumber(value) || value < 0) {
    throw new Error(message);
  }
}

export function requireOptionalPositiveInteger(
  value: unknown,
  message: string
): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
  ) {
    throw new Error(message);
  }
}

export function requireOptionalNonNegative(
  value: unknown,
  message: string
): void {
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

export function requireOptionalBoolean(value: unknown, message: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(message);
  }
}

function validateDefaultFeeTier(
  defaultFeeTier: number | undefined,
  fieldName: string
): void {
  if (defaultFeeTier !== undefined && !isValidV3FeeTier(defaultFeeTier)) {
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
    if (!isValidV3FeeTier(tier)) {
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

export function validateRouterFeeTiers(config: KeeperConfig): void {
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

export function parseLiquiditySourceKey(
  source: string
): LiquiditySource | undefined {
  const parsed = Number(source);
  if (!Number.isInteger(parsed)) {
    return undefined;
  }
  return Object.values(LiquiditySource).includes(parsed)
    ? (parsed as LiquiditySource)
    : undefined;
}

export function validateExternalTakeTransportPolicy(
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

export function validateExternalTakeRouteSelectionMode(
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

export function validateHybridGasQuoteFailureFallbackMode(
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

export function validateOneInchAggregationExecutorAllowlist(
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

export function getConfiguredTakeWriteMode(
  config: KeeperConfig
): TakeWriteTransportMode | undefined {
  if (config.writes?.take) {
    return config.writes.take.mode;
  }
  return undefined;
}

export function isPrivateOrRelayTakeWriteMode(
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
      // The Universal Router reward swap derives its slippage floor from a live
      // QuoterV2 output quote and fails closed without one. Require it up front
      // (from either documented location) so a misconfig surfaces here rather
      // than as a cryptic throw deep inside the LP-reward loop's swap.
      if (
        !config.dex.uniswapV3.universalRouter.quoterV2Address &&
        !config.dex.uniswapV3.router?.quoterV2Address
      ) {
        throw new Error(
          'PostAuctionDex.UNISWAP_V3 requires a QuoterV2 address (dex.uniswapV3.universalRouter.quoterV2Address or dex.uniswapV3.router.quoterV2Address) to derive a safe reward-swap minimum-out'
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
  const router = params.keeperConfig.takers?.router;
  if (!router) {
    throw new Error(
      `TakeSettings: takers.router required when liquiditySource is ${sourceName}`
    );
  }
  if (!ethers.utils.isAddress(router)) {
    throw new Error(
      `TakeSettings: takers.router must be a valid address (got "${router}")`
    );
  }
  const takerContract = params.keeperConfig.takers?.contracts?.[contractKey];
  if (!takerContract) {
    throw new Error(
      `TakeSettings: takers.contracts.${contractKey} required when liquiditySource is ${sourceName}`
    );
  }
  if (!ethers.utils.isAddress(takerContract)) {
    throw new Error(
      `TakeSettings: takers.contracts.${contractKey} must be a valid address (got "${takerContract}")`
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
  // Live (non-dry-run) 1inch external takes execute through the
  // OneInchAggregatorKeeperTaker, which enforces on-chain allowlists; require a
  // complete reviewed allowlist policy (mirrors LI.FI/Sushi production gating).
  assertValidOneInchAggregatorDexConfig({
    config: keeperConfig.dex?.oneInch,
    fieldName: 'KeeperConfig.dex.oneInch',
    chainId,
    requireProduction: keeperConfig.runtime?.dryRun !== true,
  });
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
  if (
    getMissingUniswapV3DirectDexRouteConfigFields(routerOverrides).length > 0
  ) {
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

export function validateKickSettings(settings: unknown, path: string): void {
  if (settings === undefined) {
    return;
  }
  if (
    typeof settings !== 'object' ||
    settings === null ||
    Array.isArray(settings)
  ) {
    throw new Error(`${path} must be an object`);
  }
  const kick = settings as {
    enabled?: unknown;
    minDebt?: unknown;
    priceFactor?: unknown;
  };
  if (kick.enabled !== true && kick.enabled !== false) {
    throw new Error(`${path}.enabled must be explicitly true or false`);
  }
  if (kick.enabled === true) {
    if (!isFiniteNumber(kick.minDebt) || kick.minDebt < 0) {
      throw new Error(
        `${path}.minDebt must be a non-negative number when kick is enabled`
      );
    }
    if (!isFiniteNumber(kick.priceFactor) || kick.priceFactor <= 0) {
      throw new Error(
        `${path}.priceFactor must be a positive number when kick is enabled`
      );
    }
    // Option 1 reward margin: the kick gate is NP * priceFactor >= market, so
    // priceFactor < 1 forces NP to exceed market (by 1/priceFactor). A
    // priceFactor >= 1 gives no margin (or kicks more aggressively than market),
    // which would let the keeper's own take penalize the bond.
    if (kick.priceFactor >= 1) {
      throw new Error(
        `${path}.priceFactor must be less than 1 (Option-1 reward margin)`
      );
    }
  }
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
