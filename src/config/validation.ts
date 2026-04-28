import {
  ExternalTakeRouteSelectionMode,
  ExternalTakeTransportPolicy,
  ExternalTakePathKind,
  KeeperConfig,
  LiquiditySource,
  PostAuctionDex,
  SushiswapRouterOverrides,
  SettlementConfig,
  TakeSettings,
  TakeWriteTransportMode,
  UniversalRouterOverrides,
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
  getManualPools,
  hasExternalTakeSettings,
  hasNonEmptyObject,
} from './schema';
import {
  EXTERNAL_TAKE_PATHS,
  EXTERNAL_TAKE_ROUTE_SELECTION_MODES,
  FACTORY_DYNAMIC_SOURCES,
  isFactoryDynamicSource,
  resolveExternalTakePaths,
  resolveFactoryRouteSelectionSources,
} from './route-policy';
import {
  formatLiquiditySource,
  getLiquiditySourceConfig,
  hasConfiguredWrappedNativeAddress,
  resolveConfiguredGasQuoteLiquiditySource,
  STANDARD_V3_FEE_TIERS,
} from './liquidity-source';
import { logger } from '../logging';
import { ethers } from 'ethers';
import { MARKET_FACTOR_SCALE, MAX_UINT24_FEE_TIER } from '../constants';

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
  maxOneInchAggregationExecutorAllowlistEntries: 64,
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

function validateCandidateFeeTiers(
  tiers: number[] | undefined,
  defaultFeeTier: number | undefined,
  fieldName: string
): void {
  if (defaultFeeTier !== undefined && !isValidFactoryFeeTier(defaultFeeTier)) {
    throw new Error(
      `${fieldName}: defaultFeeTier must be a positive uint24 fee tier`
    );
  }

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

function isValidFactoryFeeTier(tier: number): boolean {
  return Number.isInteger(tier) && tier > 0 && tier <= MAX_UINT24_FEE_TIER;
}

function validateRouterFeeTiers(config: KeeperConfig): void {
  const uniswapConfig: UniversalRouterOverrides | undefined =
    config.dex?.uniswapV3?.universalRouter;
  const sushiConfig: SushiswapRouterOverrides | undefined =
    config.dex?.sushiswap;
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
    'KeeperConfig.dex.uniswapV3.universalRouter'
  );
  validateCandidateFeeTiers(
    sushiConfig?.candidateFeeTiers,
    sushiConfig?.defaultFeeTier,
    'KeeperConfig.dex.sushiswap'
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
  defaultFactoryLiquiditySource?: LiquiditySource
): Set<LiquiditySource> {
  return new Set(
    resolveFactoryRouteSelectionSources({
      defaultLiquiditySource: discoveredTake.liquiditySource,
      allowedLiquiditySources,
      configuredDefaultFactoryLiquiditySource: defaultFactoryLiquiditySource,
    })
  );
}

function getEffectiveTakeGasOverrideSources(
  discoveredTake: TakeSettings,
  allowedLiquiditySources: LiquiditySource[] | undefined,
  defaultFactoryLiquiditySource: LiquiditySource | undefined,
  externalTakePaths: Set<ExternalTakePathKind>
): Set<LiquiditySource> {
  const sources = getEffectiveFactoryRouteSources(
    discoveredTake,
    allowedLiquiditySources,
    defaultFactoryLiquiditySource
  );
  if (externalTakePaths.has('oneinch')) {
    sources.add(LiquiditySource.ONEINCH);
  }
  return sources;
}

function getEffectiveExternalTakePaths(
  discoveredTake: TakeSettings,
  allowedExternalTakePaths: ExternalTakePathKind[] | undefined
): Set<ExternalTakePathKind> {
  return new Set(
    resolveExternalTakePaths({
      defaultLiquiditySource: discoveredTake.liquiditySource,
      allowedExternalTakePaths,
    })
  );
}

function validateAllowedExternalTakePaths(
  paths: ExternalTakePathKind[] | undefined
): void {
  if (paths === undefined) {
    return;
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(
      'AutoDiscoverConfig.take: allowedExternalTakePaths must be non-empty'
    );
  }
  const seen = new Set<ExternalTakePathKind>();
  for (const path of paths) {
    if (!EXTERNAL_TAKE_PATHS.has(path)) {
      throw new Error(
        'AutoDiscoverConfig.take: allowedExternalTakePaths currently supports only oneinch and factory'
      );
    }
    if (seen.has(path)) {
      throw new Error(
        'AutoDiscoverConfig.take: allowedExternalTakePaths cannot contain duplicates'
      );
    }
    seen.add(path);
  }
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
      'AutoDiscoverConfig.take: externalTakeRouteSelectionMode must be maximize_profit or factory_first'
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
    case PostAuctionDex.SUSHISWAP:
      if (!config.dex?.sushiswap) {
        throw new Error(
          'PostAuctionDex.SUSHISWAP requires dex.sushiswap configuration'
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
    if (config.liquiditySource === LiquiditySource.NONE) {
      throw new Error('TakeSettings: liquiditySource cannot be NONE');
    }

    if (
      config.liquiditySource !== LiquiditySource.ONEINCH &&
      config.liquiditySource !== LiquiditySource.UNISWAPV3 &&
      config.liquiditySource !== LiquiditySource.SUSHISWAP &&
      config.liquiditySource !== LiquiditySource.CURVE
    ) {
      throw new Error(
        'TakeSettings: liquiditySource must be ONEINCH or UNISWAPV3 or SUSHISWAP or CURVE'
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

    if (config.liquiditySource === LiquiditySource.ONEINCH) {
      if (!keeperConfig.takers?.oneInch) {
        throw new Error(
          'TakeSettings: takers.oneInch required when liquiditySource is ONEINCH'
        );
      }
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

    if (config.liquiditySource === LiquiditySource.UNISWAPV3) {
      if (!keeperConfig.takers?.factory) {
        throw new Error(
          'TakeSettings: takers.factory required when liquiditySource is UNISWAPV3'
        );
      }
      if (
        !keeperConfig.takers.contracts ||
        !keeperConfig.takers.contracts['UniswapV3']
      ) {
        throw new Error(
          'TakeSettings: takers.contracts.UniswapV3 required when liquiditySource is UNISWAPV3'
        );
      }
      if (!keeperConfig.dex?.uniswapV3?.universalRouter) {
        throw new Error(
          'TakeSettings: dex.uniswapV3.universalRouter required when liquiditySource is UNISWAPV3'
        );
      }
      const routerOverrides = keeperConfig.dex.uniswapV3.universalRouter;
      if (
        !routerOverrides.universalRouterAddress ||
        !routerOverrides.permit2Address ||
        !routerOverrides.poolFactoryAddress ||
        !routerOverrides.wethAddress ||
        !routerOverrides.quoterV2Address
      ) {
        throw new Error(
          'TakeSettings: dex.uniswapV3.universalRouter.universalRouterAddress, permit2Address, poolFactoryAddress, wethAddress, and quoterV2Address required when liquiditySource is UNISWAPV3'
        );
      }
    }

    if (config.liquiditySource === LiquiditySource.SUSHISWAP) {
      if (!keeperConfig.takers?.factory) {
        throw new Error(
          'TakeSettings: takers.factory required when liquiditySource is SUSHISWAP'
        );
      }
      if (
        !keeperConfig.takers.contracts ||
        !keeperConfig.takers.contracts['SushiSwap']
      ) {
        throw new Error(
          'TakeSettings: takers.contracts.SushiSwap required when liquiditySource is SUSHISWAP'
        );
      }
      if (!keeperConfig.dex?.sushiswap) {
        throw new Error(
          'TakeSettings: dex.sushiswap required when liquiditySource is SUSHISWAP'
        );
      }
      const routerOverrides = keeperConfig.dex.sushiswap;
      if (
        !routerOverrides.swapRouterAddress ||
        !routerOverrides.factoryAddress ||
        !routerOverrides.wethAddress ||
        !routerOverrides.quoterV2Address
      ) {
        throw new Error(
          'TakeSettings: dex.sushiswap.swapRouterAddress, factoryAddress, wethAddress, and quoterV2Address required when liquiditySource is SUSHISWAP'
        );
      }
    }

    if (config.liquiditySource === LiquiditySource.CURVE) {
      if (!keeperConfig.takers?.factory) {
        throw new Error(
          'TakeSettings: takers.factory required when liquiditySource is CURVE'
        );
      }
      if (
        !keeperConfig.takers.contracts ||
        !keeperConfig.takers.contracts['Curve']
      ) {
        throw new Error(
          'TakeSettings: takers.contracts.Curve required when liquiditySource is CURVE'
        );
      }
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
      takePolicy.externalTakeRouteSelectionMode === 'factory_first' &&
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

    validateAllowedExternalTakePaths(takePolicy.allowedExternalTakePaths);
    const externalTakePaths = getEffectiveExternalTakePaths(
      discoveredTake,
      takePolicy.allowedExternalTakePaths
    );
    if (
      takePolicy.defaultFactoryLiquiditySource !== undefined &&
      !isFactoryDynamicSource(takePolicy.defaultFactoryLiquiditySource)
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: defaultFactoryLiquiditySource must be UNISWAPV3, SUSHISWAP, or CURVE'
      );
    }
    const effectiveDefaultFactoryLiquiditySource = isFactoryDynamicSource(
      discoveredTake.liquiditySource
    )
      ? discoveredTake.liquiditySource
      : takePolicy.defaultFactoryLiquiditySource;
    if (
      externalTakePaths.has('factory') &&
      effectiveDefaultFactoryLiquiditySource === undefined
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: defaultFactoryLiquiditySource required when allowedExternalTakePaths includes factory and discovery.defaults.take.liquiditySource is not a factory source'
      );
    }
    if (
      externalTakePaths.has('factory') &&
      externalTakePaths.has('oneinch') &&
      takePolicy.validateRouteDeployments !== true
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: validateRouteDeployments=true required when allowedExternalTakePaths includes both oneinch and factory'
      );
    }
    if (externalTakePaths.has('oneinch')) {
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
    if (externalTakePaths.has('factory') && externalTakePaths.has('oneinch')) {
      validateQuoteDenominatedGasPolicy(
        config,
        'AutoDiscoverConfig.take: hybrid external take route ranking',
        chainId
      );
    }
    if (
      takePolicy.takeRouteQuoteBudgetPerCandidate !== undefined &&
      !externalTakePaths.has('factory')
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: takeRouteQuoteBudgetPerCandidate requires an enabled factory external take path'
      );
    }

    if (takePolicy.allowedLiquiditySources !== undefined) {
      if (!externalTakePaths.has('factory')) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedLiquiditySources requires a factory external take path'
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
            'AutoDiscoverConfig.take: allowedLiquiditySources cannot include ONEINCH for factory external takes'
          );
        }
        if (!isFactoryDynamicSource(source)) {
          throw new Error(
            'AutoDiscoverConfig.take: allowedLiquiditySources currently supports only UNISWAPV3, SUSHISWAP, and CURVE'
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
        takePolicy.defaultFactoryLiquiditySource !== undefined &&
        effectiveDefaultFactoryLiquiditySource !== undefined &&
        !takePolicy.allowedLiquiditySources.includes(
          effectiveDefaultFactoryLiquiditySource
        )
      ) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedLiquiditySources must include the effective default factory liquidity source'
        );
      }
    } else {
      if (externalTakePaths.has('factory')) {
        validateTakeSettings(
          {
            ...discoveredTake,
            liquiditySource: effectiveDefaultFactoryLiquiditySource,
          },
          config,
          chainId
        );
      }
    }

    if (externalTakePaths.has('oneinch')) {
      validateTakeSettings(
        {
          ...discoveredTake,
          liquiditySource: LiquiditySource.ONEINCH,
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
      effectiveDefaultFactoryLiquiditySource
    );
    const effectiveTakeGasOverrideSources = getEffectiveTakeGasOverrideSources(
      discoveredTake,
      takePolicy.allowedLiquiditySources,
      effectiveDefaultFactoryLiquiditySource,
      externalTakePaths
    );
    if (
      config.dex?.uniswapV3?.universalRouter?.candidateFeeTiers !== undefined &&
      !effectiveFactorySources.has(LiquiditySource.UNISWAPV3)
    ) {
      logger.warn(
        'KeeperConfig.dex.uniswapV3.universalRouter.candidateFeeTiers configured but UNISWAPV3 is not an enabled autodiscover factory route source'
      );
    }
    if (
      config.dex?.sushiswap?.candidateFeeTiers !== undefined &&
      !effectiveFactorySources.has(LiquiditySource.SUSHISWAP)
    ) {
      logger.warn(
        'KeeperConfig.dex.sushiswap.candidateFeeTiers configured but SUSHISWAP is not an enabled autodiscover factory route source'
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
        if (
          liquiditySource === LiquiditySource.ONEINCH &&
          !effectiveTakeGasOverrideSources.has(liquiditySource)
        ) {
          throw new Error(
            'AutoDiscoverConfig.take: dexGasOverrides.ONEINCH requires an enabled 1inch external take path'
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
