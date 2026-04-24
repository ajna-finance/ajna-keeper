import {
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
  hasExternalTakeSettings,
  hasNonEmptyObject,
} from './schema';
import {
  hasConfiguredWrappedNativeAddress,
  resolveConfiguredGasQuoteLiquiditySource,
} from './liquidity-source';
import { logger } from '../logging';

const FACTORY_DYNAMIC_SOURCES = [
  LiquiditySource.UNISWAPV3,
  LiquiditySource.SUSHISWAP,
  LiquiditySource.CURVE,
];
const MAX_UINT24_FEE_TIER = 16_777_215;
const MAX_CANDIDATE_FEE_TIERS = 8;
const MIN_DEX_GAS_OVERRIDE = BigInt(100_000);
const MAX_DEX_GAS_OVERRIDE = BigInt(2_000_000);
const MAX_MIN_PROFIT_NATIVE_WEI = BigInt('1000000000000000000000000000');
const STANDARD_V3_FEE_TIERS = new Set([100, 500, 3000, 10000]);

function validateQuoteDenominatedGasPolicy(
  config: KeeperConfig,
  fieldName: string,
  chainId?: number
): void {
  if (resolveConfiguredGasQuoteLiquiditySource(config, chainId) === undefined) {
    throw new Error(
      `${fieldName} requires a configured native-to-quote liquidity source`
    );
  }
  if (!hasConfiguredWrappedNativeAddress(config)) {
    throw new Error(
      `${fieldName} requires a configured wrapped native token address`
    );
  }
}

function validateDecimalStringBigInt(value: string, fieldName: string): void {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(
      `${fieldName} must be a non-negative decimal integer string`
    );
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
    if (!STANDARD_V3_FEE_TIERS.has(tier)) {
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
    config.universalRouterOverrides;
  const sushiConfig: SushiswapRouterOverrides | undefined =
    config.sushiswapRouterOverrides;
  validateCandidateFeeTiers(
    uniswapConfig?.candidateFeeTiers,
    uniswapConfig?.defaultFeeTier,
    'UniversalRouterOverrides'
  );
  validateCandidateFeeTiers(
    sushiConfig?.candidateFeeTiers,
    sushiConfig?.defaultFeeTier,
    'SushiswapRouterOverrides'
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
  allowedLiquiditySources: LiquiditySource[] | undefined
): Set<LiquiditySource> {
  const sources = new Set<LiquiditySource>();
  if (
    discoveredTake.liquiditySource !== undefined &&
    FACTORY_DYNAMIC_SOURCES.includes(discoveredTake.liquiditySource)
  ) {
    sources.add(discoveredTake.liquiditySource);
  }
  for (const source of allowedLiquiditySources ?? []) {
    if (FACTORY_DYNAMIC_SOURCES.includes(source)) {
      sources.add(source);
    }
  }
  return sources;
}

function isFactoryDynamicSource(
  source: LiquiditySource | undefined
): source is
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.SUSHISWAP
  | LiquiditySource.CURVE {
  return source !== undefined && FACTORY_DYNAMIC_SOURCES.includes(source);
}

export function validatePostAuctionDex(
  dexProvider: PostAuctionDex,
  config: KeeperConfig
): void {
  switch (dexProvider) {
    case PostAuctionDex.ONEINCH:
      if (!config.oneInchRouters) {
        throw new Error(
          'PostAuctionDex.ONEINCH requires oneInchRouters configuration'
        );
      }
      return;
    case PostAuctionDex.UNISWAP_V3:
      if (!config.universalRouterOverrides) {
        throw new Error(
          'PostAuctionDex.UNISWAP_V3 requires universalRouterOverrides configuration'
        );
      }
      return;
    case PostAuctionDex.SUSHISWAP:
      if (!config.sushiswapRouterOverrides) {
        throw new Error(
          'PostAuctionDex.SUSHISWAP requires sushiswapRouterOverrides configuration'
        );
      }
      return;
    case PostAuctionDex.CURVE:
      if (!config.curveRouterOverrides) {
        throw new Error(
          'PostAuctionDex.CURVE requires curveRouterOverrides configuration'
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

    if (
      config.marketPriceFactor === undefined ||
      config.marketPriceFactor <= 0
    ) {
      throw new Error('TakeSettings: marketPriceFactor must be positive');
    }

    if (config.liquiditySource === LiquiditySource.ONEINCH) {
      if (!keeperConfig.keeperTaker) {
        throw new Error(
          'TakeSettings: keeperTaker required when liquiditySource is ONEINCH'
        );
      }
      if (
        !keeperConfig.oneInchRouters ||
        Object.keys(keeperConfig.oneInchRouters).length === 0
      ) {
        throw new Error(
          'TakeSettings: oneInchRouters required when liquiditySource is ONEINCH'
        );
      }
      if (chainId !== undefined && !keeperConfig.oneInchRouters[chainId]) {
        throw new Error(
          `TakeSettings: oneInchRouters missing router for chain ${chainId}`
        );
      }
    }

    if (config.liquiditySource === LiquiditySource.UNISWAPV3) {
      if (!keeperConfig.keeperTakerFactory) {
        throw new Error(
          'TakeSettings: keeperTakerFactory required when liquiditySource is UNISWAPV3'
        );
      }
      if (
        !keeperConfig.takerContracts ||
        !keeperConfig.takerContracts['UniswapV3']
      ) {
        throw new Error(
          'TakeSettings: takerContracts.UniswapV3 required when liquiditySource is UNISWAPV3'
        );
      }
      if (!keeperConfig.universalRouterOverrides) {
        throw new Error(
          'TakeSettings: universalRouterOverrides required when liquiditySource is UNISWAPV3'
        );
      }
      const routerOverrides = keeperConfig.universalRouterOverrides;
      if (
        !routerOverrides.universalRouterAddress ||
        !routerOverrides.permit2Address ||
        !routerOverrides.poolFactoryAddress ||
        !routerOverrides.wethAddress ||
        !routerOverrides.quoterV2Address
      ) {
        throw new Error(
          'TakeSettings: universalRouterOverrides.universalRouterAddress, permit2Address, poolFactoryAddress, wethAddress, and quoterV2Address required when liquiditySource is UNISWAPV3'
        );
      }
    }

    if (config.liquiditySource === LiquiditySource.SUSHISWAP) {
      if (!keeperConfig.keeperTakerFactory) {
        throw new Error(
          'TakeSettings: keeperTakerFactory required when liquiditySource is SUSHISWAP'
        );
      }
      if (
        !keeperConfig.takerContracts ||
        !keeperConfig.takerContracts['SushiSwap']
      ) {
        throw new Error(
          'TakeSettings: takerContracts.SushiSwap required when liquiditySource is SUSHISWAP'
        );
      }
      if (!keeperConfig.sushiswapRouterOverrides) {
        throw new Error(
          'TakeSettings: sushiswapRouterOverrides required when liquiditySource is SUSHISWAP'
        );
      }
      const routerOverrides = keeperConfig.sushiswapRouterOverrides;
      if (
        !routerOverrides.swapRouterAddress ||
        !routerOverrides.factoryAddress ||
        !routerOverrides.wethAddress ||
        !routerOverrides.quoterV2Address
      ) {
        throw new Error(
          'TakeSettings: sushiswapRouterOverrides.swapRouterAddress, factoryAddress, wethAddress, and quoterV2Address required when liquiditySource is SUSHISWAP'
        );
      }
    }

    if (config.liquiditySource === LiquiditySource.CURVE) {
      if (!keeperConfig.keeperTakerFactory) {
        throw new Error(
          'TakeSettings: keeperTakerFactory required when liquiditySource is CURVE'
        );
      }
      if (
        !keeperConfig.takerContracts ||
        !keeperConfig.takerContracts['Curve']
      ) {
        throw new Error(
          'TakeSettings: takerContracts.Curve required when liquiditySource is CURVE'
        );
      }
      if (!keeperConfig.curveRouterOverrides) {
        throw new Error(
          'TakeSettings: curveRouterOverrides required when liquiditySource is CURVE'
        );
      }
      const routerOverrides = keeperConfig.curveRouterOverrides;
      if (
        !hasNonEmptyObject(routerOverrides.poolConfigs) ||
        !routerOverrides.wethAddress
      ) {
        throw new Error(
          'TakeSettings: curveRouterOverrides.poolConfigs and wethAddress required when liquiditySource is CURVE'
        );
      }
      if (
        !keeperConfig.tokenAddresses ||
        Object.keys(keeperConfig.tokenAddresses).length === 0
      ) {
        throw new Error(
          'TakeSettings: tokenAddresses required when liquiditySource is CURVE'
        );
      }
    }
  }

  if (hasArbTake) {
    if (config.minCollateral! <= 0) {
      throw new Error('TakeSettings: minCollateral must be greater than 0');
    }
    if (config.hpbPriceFactor === undefined || config.hpbPriceFactor <= 0) {
      throw new Error('TakeSettings: hpbPriceFactor must be positive');
    }
  }
}

export function validateSettlementSettings(config: SettlementConfig): void {
  if (!config.enabled) {
    throw new Error(
      'SettlementConfig: enabled must be true for active settlement targets'
    );
  }
  if (config.minAuctionAge !== undefined && config.minAuctionAge < 0) {
    throw new Error('SettlementConfig: minAuctionAge cannot be negative');
  }
  if (config.maxBucketDepth !== undefined && config.maxBucketDepth <= 0) {
    throw new Error('SettlementConfig: maxBucketDepth must be greater than 0');
  }
  if (config.maxIterations !== undefined && config.maxIterations <= 0) {
    throw new Error('SettlementConfig: maxIterations must be greater than 0');
  }
}

export function validateAutoDiscoverConfig(
  config: KeeperConfig,
  chainId?: number
): void {
  validateRouterFeeTiers(config);

  const autoDiscover = config.autoDiscover;
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
  if (
    autoDiscover.hydrateCooldownSec !== undefined &&
    autoDiscover.hydrateCooldownSec < 0
  ) {
    throw new Error(
      'AutoDiscoverConfig: hydrateCooldownSec cannot be negative'
    );
  }

  if (takePolicy) {
    if (
      takePolicy.maxPoolsPerRun !== undefined &&
      takePolicy.maxPoolsPerRun <= 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: maxPoolsPerRun must be greater than 0'
      );
    }
    if (
      takePolicy.takeQuoteBudgetPerRun !== undefined &&
      takePolicy.takeQuoteBudgetPerRun <= 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: takeQuoteBudgetPerRun must be greater than 0'
      );
    }
    if (
      takePolicy.takeRouteQuoteBudgetPerCandidate !== undefined &&
      takePolicy.takeRouteQuoteBudgetPerCandidate <= 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: takeRouteQuoteBudgetPerCandidate must be greater than 0'
      );
    }
    if (
      takePolicy.minExpectedProfitQuote !== undefined &&
      takePolicy.minExpectedProfitQuote < 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: minExpectedProfitQuote cannot be negative'
      );
    }
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
      takePolicy.maxGasPriceGwei !== undefined &&
      takePolicy.maxGasPriceGwei <= 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: maxGasPriceGwei must be greater than 0'
      );
    }
    if (
      takePolicy.maxGasCostNative !== undefined &&
      takePolicy.maxGasCostNative < 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: maxGasCostNative cannot be negative'
      );
    }
    if (
      takePolicy.maxGasCostQuote !== undefined &&
      takePolicy.maxGasCostQuote < 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: maxGasCostQuote cannot be negative'
      );
    }

    const discoveredTake = config.discoveredDefaults?.take;
    if (!discoveredTake) {
      throw new Error(
        'AutoDiscoverConfig: discoveredDefaults.take required when autoDiscover.take is enabled'
      );
    }

    validateTakeSettings(discoveredTake, config, chainId);

    const discoveredTakeUsesFactory = isFactoryDynamicSource(
      discoveredTake.liquiditySource
    );
    if (
      takePolicy.takeRouteQuoteBudgetPerCandidate !== undefined &&
      !discoveredTakeUsesFactory
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: takeRouteQuoteBudgetPerCandidate requires discoveredDefaults.take.liquiditySource to be UNISWAPV3, SUSHISWAP, or CURVE'
      );
    }

    if (takePolicy.allowedLiquiditySources !== undefined) {
      if (!discoveredTakeUsesFactory) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedLiquiditySources requires discoveredDefaults.take.liquiditySource to be UNISWAPV3, SUSHISWAP, or CURVE'
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
        if (!FACTORY_DYNAMIC_SOURCES.includes(source)) {
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
    }

    const effectiveFactorySources = getEffectiveFactoryRouteSources(
      discoveredTake,
      takePolicy.allowedLiquiditySources
    );
    if (
      config.universalRouterOverrides?.candidateFeeTiers !== undefined &&
      !effectiveFactorySources.has(LiquiditySource.UNISWAPV3)
    ) {
      logger.warn(
        'UniversalRouterOverrides: candidateFeeTiers configured but UNISWAPV3 is not an enabled autodiscover factory route source'
      );
    }
    if (
      config.sushiswapRouterOverrides?.candidateFeeTiers !== undefined &&
      !effectiveFactorySources.has(LiquiditySource.SUSHISWAP)
    ) {
      logger.warn(
        'SushiswapRouterOverrides: candidateFeeTiers configured but SUSHISWAP is not an enabled autodiscover factory route source'
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
            ? LiquiditySource[liquiditySource]
            : source;
        if (liquiditySource === undefined) {
          throw new Error(
            `AutoDiscoverConfig.take: dexGasOverrides.${source} is not a valid LiquiditySource`
          );
        }
        if (liquiditySource === LiquiditySource.ONEINCH) {
          throw new Error(
            'AutoDiscoverConfig.take: dexGasOverrides cannot include ONEINCH for factory external takes'
          );
        }
        if (
          !FACTORY_DYNAMIC_SOURCES.includes(liquiditySource) ||
          !effectiveFactorySources.has(liquiditySource)
        ) {
          throw new Error(
            `AutoDiscoverConfig.take: dexGasOverrides.${sourceLabel} is not enabled by discoveredDefaults.take.liquiditySource or allowedLiquiditySources`
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
      !hasExternalTakeSettings(discoveredTake)
    ) {
      throw new Error(
        'AutoDiscoverConfig: quote-normalized profit floors require discoveredDefaults.take to configure an external take path'
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
    if (
      settlementPolicy.maxPoolsPerRun !== undefined &&
      settlementPolicy.maxPoolsPerRun <= 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.settlement: maxPoolsPerRun must be greater than 0'
      );
    }
    if (
      settlementPolicy.maxGasPriceGwei !== undefined &&
      settlementPolicy.maxGasPriceGwei <= 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.settlement: maxGasPriceGwei must be greater than 0'
      );
    }
    if (
      settlementPolicy.maxGasCostNative !== undefined &&
      settlementPolicy.maxGasCostNative < 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.settlement: maxGasCostNative cannot be negative'
      );
    }
    if (
      settlementPolicy.maxGasCostQuote !== undefined &&
      settlementPolicy.maxGasCostQuote < 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.settlement: maxGasCostQuote cannot be negative'
      );
    }
    if (settlementPolicy.maxGasCostQuote !== undefined) {
      validateQuoteDenominatedGasPolicy(
        config,
        'AutoDiscoverConfig.settlement: maxGasCostQuote',
        chainId
      );
    }

    const discoveredSettlement = config.discoveredDefaults?.settlement;
    if (!discoveredSettlement?.enabled) {
      throw new Error(
        'AutoDiscoverConfig: enabled discoveredDefaults.settlement required when autoDiscover.settlement is enabled'
      );
    }
    validateSettlementSettings(discoveredSettlement);
  }
}

export function validateTakeWriteConfig(config: KeeperConfig): void {
  const hasTakeWriteRpcUrl =
    Object.prototype.hasOwnProperty.call(config, 'takeWriteRpcUrl') &&
    (config as { takeWriteRpcUrl?: unknown }).takeWriteRpcUrl !== undefined;
  const shorthandRpcUrl = hasTakeWriteRpcUrl
    ? (config as { takeWriteRpcUrl?: unknown }).takeWriteRpcUrl
    : undefined;

  if (config.takeWrite && hasTakeWriteRpcUrl) {
    throw new Error(
      'KeeperConfig: configure only one of takeWrite or takeWriteRpcUrl'
    );
  }

  if (hasTakeWriteRpcUrl) {
    if (
      typeof shorthandRpcUrl !== 'string' ||
      shorthandRpcUrl.trim().length === 0
    ) {
      throw new Error('KeeperConfig: takeWriteRpcUrl cannot be blank');
    }
  }

  if (!config.takeWrite) {
    return;
  }

  switch (config.takeWrite.mode) {
    case TakeWriteTransportMode.PUBLIC_RPC:
      if (
        config.takeWrite.receiptTimeoutMs !== undefined &&
        config.takeWrite.receiptTimeoutMs <= 0
      ) {
        throw new Error(
          'KeeperConfig.takeWrite: receiptTimeoutMs must be greater than 0 when provided'
        );
      }
      return;
    case TakeWriteTransportMode.PRIVATE_RPC:
      if (!config.takeWrite.rpcUrl) {
        throw new Error(
          'KeeperConfig.takeWrite: rpcUrl required when mode is private_rpc'
        );
      }
      if (
        config.takeWrite.receiptTimeoutMs !== undefined &&
        config.takeWrite.receiptTimeoutMs <= 0
      ) {
        throw new Error(
          'KeeperConfig.takeWrite: receiptTimeoutMs must be greater than 0 when provided'
        );
      }
      return;
    case TakeWriteTransportMode.RELAY:
      if (!config.takeWrite.relay?.url) {
        throw new Error(
          'KeeperConfig.takeWrite: relay.url required when mode is relay'
        );
      }
      if (
        config.takeWrite.relay.maxBlockNumberOffset !== undefined &&
        config.takeWrite.relay.maxBlockNumberOffset <= 0
      ) {
        throw new Error(
          'KeeperConfig.takeWrite: relay.maxBlockNumberOffset must be greater than 0 when provided'
        );
      }
      if (
        config.takeWrite.relay.requestTimeoutMs !== undefined &&
        config.takeWrite.relay.requestTimeoutMs <= 0
      ) {
        throw new Error(
          'KeeperConfig.takeWrite: relay.requestTimeoutMs must be greater than 0 when provided'
        );
      }
      if (
        config.takeWrite.receiptTimeoutMs !== undefined &&
        config.takeWrite.receiptTimeoutMs <= 0
      ) {
        throw new Error(
          'KeeperConfig.takeWrite: receiptTimeoutMs must be greater than 0 when provided'
        );
      }
      if (
        config.takeWrite.relay.receiptTimeoutMs !== undefined &&
        config.takeWrite.relay.receiptTimeoutMs <= 0
      ) {
        throw new Error(
          'KeeperConfig.takeWrite: relay.receiptTimeoutMs must be greater than 0 when provided'
        );
      }
      return;
    default:
      throw new Error(
        `KeeperConfig.takeWrite: unsupported mode ${String(config.takeWrite.mode)}`
      );
  }
}

export function validateTakeSettingsForChain(
  config: KeeperConfig,
  chainId: number
): void {
  validateRouterFeeTiers(config);

  for (const poolConfig of config.pools) {
    if (poolConfig.take) {
      validateTakeSettings(poolConfig.take, config, chainId);
    }
  }

  const discoveredTake = config.discoveredDefaults?.take;
  if (discoveredTake && getAutoDiscoverTakePolicy(config.autoDiscover)) {
    validateTakeSettings(discoveredTake, config, chainId);
  }
}
