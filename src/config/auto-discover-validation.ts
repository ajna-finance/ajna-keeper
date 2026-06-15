import {
  AutoDiscoverSettlementPolicy,
  AutoDiscoverTakePolicy,
  KeeperConfig,
  LiquiditySource,
  TakeSettings,
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
} from './schema';
import {
  ResolvedExternalTakePolicy,
  isDirectDexDynamicSource,
  resolveExternalTakePolicy,
} from './route-policy';
import {
  getAggregatorProviderIdentity,
  getExternalTakePathDescriptor,
  getExternalTakePathDescriptors,
  resolveExternalTakePathFromSource,
} from './external-take-descriptors';
import { formatLiquiditySource } from './liquidity-source';
import { logger } from '../logging';
import {
  MAX_DEX_GAS_OVERRIDE,
  MAX_MIN_PROFIT_NATIVE_WEI,
  MIN_DEX_GAS_OVERRIDE,
  VALIDATION_BOUNDS,
  getConfiguredTakeWriteMode,
  isPrivateOrRelayTakeWriteMode,
  parseLiquiditySourceKey,
  requireOptionalBoolean,
  requireOptionalIntegerRange,
  requireOptionalNonNegative,
  requireOptionalPositive,
  requireOptionalPositiveInteger,
  validateDecimalStringBigInt,
  validateExternalTakeRouteSelectionMode,
  validateExternalTakeTransportPolicy,
  validateHybridGasQuoteFailureFallbackMode,
  validateOneInchAggregationExecutorAllowlist,
  validateQuoteDenominatedGasPolicy,
  validateRouterFeeTiers,
  validateSettlementSettings,
  validateTakeSettings,
} from './validation-rules';

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
    validateAutoDiscoverTakePolicy(config, takePolicy, chainId);
  }

  if (settlementPolicy) {
    validateAutoDiscoverSettlementPolicy(config, settlementPolicy, chainId);
  }
}

function validateAutoDiscoverTakePolicy(
  config: KeeperConfig,
  takePolicy: AutoDiscoverTakePolicy,
  chainId?: number
): void {
  validateTakeScalarBounds(config, takePolicy);
  const discoveredTake = requireDiscoveredTakeAndWarnSubsidy(
    config,
    takePolicy
  );
  const {
    resolvedExternalTakePolicy,
    externalTakePaths,
    calldataAggregatorSources,
    effectiveDefaultDirectDexLiquiditySource,
  } = validateResolvedTakePathRequirements(
    config,
    takePolicy,
    discoveredTake,
    chainId
  );
  validateTakeLiquiditySourceSettings(
    config,
    takePolicy,
    discoveredTake,
    externalTakePaths,
    calldataAggregatorSources,
    effectiveDefaultDirectDexLiquiditySource,
    chainId
  );
  validateTakeGasOverridesAndProfitFloors(
    config,
    takePolicy,
    discoveredTake,
    resolvedExternalTakePolicy,
    externalTakePaths,
    calldataAggregatorSources,
    chainId
  );
}

function validateTakeScalarBounds(
  config: KeeperConfig,
  takePolicy: AutoDiscoverTakePolicy
): void {
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
      (takePolicy.externalTakeTransportPolicy === 'require_private_or_relay' &&
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
}

function requireDiscoveredTakeAndWarnSubsidy(
  config: KeeperConfig,
  takePolicy: AutoDiscoverTakePolicy
): TakeSettings {
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
  return discoveredTake;
}

function validateResolvedTakePathRequirements(
  config: KeeperConfig,
  takePolicy: AutoDiscoverTakePolicy,
  discoveredTake: TakeSettings,
  chainId?: number
): {
  resolvedExternalTakePolicy: ResolvedExternalTakePolicy;
  externalTakePaths: Set<string>;
  calldataAggregatorSources: LiquiditySource[];
  effectiveDefaultDirectDexLiquiditySource: LiquiditySource | undefined;
} {
  const resolvedExternalTakePolicy = resolveExternalTakePolicy({
    defaultLiquiditySource: discoveredTake.liquiditySource,
    takePolicy,
  });
  const externalTakePaths = new Set(
    resolvedExternalTakePolicy.externalTakePaths
  );
  const calldataAggregatorSources =
    resolvedExternalTakePolicy.calldataAggregatorProviders.map(
      (providerId) => getAggregatorProviderIdentity(providerId).liquiditySource
    );
  if (takePolicy.hybridGasQuoteFailureFallbackMode === 'direct_dex_first') {
    const fallbackEligibility =
      resolvedExternalTakePolicy.hybridGasQuoteFallbackPolicy;
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
  const effectiveDefaultDirectDexLiquiditySource =
    resolvedExternalTakePolicy.defaultDirectDexLiquiditySource;
  if (
    externalTakePaths.has('direct_dex') &&
    effectiveDefaultDirectDexLiquiditySource === undefined
  ) {
    throw new Error(
      'AutoDiscoverConfig.take: defaultDirectDexLiquiditySource required when allowedExternalTakePaths includes direct_dex and discovery.defaults.take.liquiditySource is not a direct DEX source'
    );
  }
  for (const descriptor of getExternalTakePathDescriptors(externalTakePaths)) {
    if (
      descriptor.requiresRouteDeploymentValidation &&
      takePolicy.validateRouteDeployments !== true
    ) {
      throw new Error(
        `AutoDiscoverConfig.take: validateRouteDeployments=true required when resolved external take paths include ${descriptor.path}`
      );
    }
  }
  if (calldataAggregatorSources.includes(LiquiditySource.ONEINCH)) {
    if (
      !config.dex?.oneInch?.aggregationExecutorAllowlist ||
      Object.keys(config.dex.oneInch.aggregationExecutorAllowlist).length === 0
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
  const calldataAggregatorDescriptor = getExternalTakePathDescriptor(
    'calldata_aggregator'
  );
  if (
    externalTakePaths.has('calldata_aggregator') &&
    calldataAggregatorDescriptor.requiresDexGasOverride
  ) {
    for (const source of calldataAggregatorSources) {
      if (takePolicy.dexGasOverrides?.[source] === undefined) {
        throw new Error(
          `AutoDiscoverConfig.take: dexGasOverrides.${formatLiquiditySource(source)} required when resolved external take paths include ${calldataAggregatorDescriptor.path}`
        );
      }
    }
  }
  if (resolvedExternalTakePolicy.requiresExternalTakeNetProfitRanking) {
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
  return {
    resolvedExternalTakePolicy,
    externalTakePaths,
    calldataAggregatorSources,
    effectiveDefaultDirectDexLiquiditySource,
  };
}

function validateTakeLiquiditySourceSettings(
  config: KeeperConfig,
  takePolicy: AutoDiscoverTakePolicy,
  discoveredTake: TakeSettings,
  externalTakePaths: Set<string>,
  calldataAggregatorSources: LiquiditySource[],
  effectiveDefaultDirectDexLiquiditySource: LiquiditySource | undefined,
  chainId?: number
): void {
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

  if (externalTakePaths.has('calldata_aggregator')) {
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
  }

  if (!externalTakePaths.size) {
    validateTakeSettings(discoveredTake, config, chainId);
  }
}

function validateTakeGasOverridesAndProfitFloors(
  config: KeeperConfig,
  takePolicy: AutoDiscoverTakePolicy,
  discoveredTake: TakeSettings,
  resolvedExternalTakePolicy: ResolvedExternalTakePolicy,
  externalTakePaths: Set<string>,
  calldataAggregatorSources: LiquiditySource[],
  chainId?: number
): void {
  const effectiveDirectDexSources = new Set(
    resolvedExternalTakePolicy.directDexRouteSources
  );
  const effectiveTakeGasOverrideSources = new Set<LiquiditySource>(
    resolvedExternalTakePolicy.directDexRouteSources
  );
  if (externalTakePaths.has('calldata_aggregator')) {
    for (const source of calldataAggregatorSources) {
      effectiveTakeGasOverrideSources.add(source);
    }
  }
  if (
    config.dex?.uniswapV3?.router?.candidateFeeTiers !== undefined &&
    !effectiveDirectDexSources.has(LiquiditySource.UNISWAPV3)
  ) {
    logger.warn(
      'KeeperConfig.dex.uniswapV3.router.candidateFeeTiers configured but UNISWAPV3 is not an enabled autodiscover direct DEX route source'
    );
  }

  if (takePolicy.dexGasOverrides !== undefined) {
    for (const [source, value] of Object.entries(takePolicy.dexGasOverrides)) {
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
    (!externalTakePaths.size || discoveredTake.marketPriceFactor === undefined)
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

function validateAutoDiscoverSettlementPolicy(
  config: KeeperConfig,
  settlementPolicy: AutoDiscoverSettlementPolicy,
  chainId?: number
): void {
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
