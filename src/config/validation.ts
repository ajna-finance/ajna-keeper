import {
  KeeperConfig,
  LiquiditySource,
  PostAuctionDex,
  SettlementConfig,
  TakeSettings,
  TakeWriteTransportMode,
  getAutoDiscoverSettlementPolicy,
  getAutoDiscoverTakePolicy,
  hasExternalTakeSettings,
  hasNonEmptyObject,
} from './schema';

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
        !routerOverrides.wethAddress
      ) {
        throw new Error(
          'TakeSettings: universalRouterOverrides.universalRouterAddress, permit2Address, poolFactoryAddress, and wethAddress required when liquiditySource is UNISWAPV3'
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
        !routerOverrides.wethAddress
      ) {
        throw new Error(
          'TakeSettings: sushiswapRouterOverrides.swapRouterAddress, factoryAddress, and wethAddress required when liquiditySource is SUSHISWAP'
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
    if (
      config.hpbPriceFactor === undefined ||
      config.hpbPriceFactor <= 0
    ) {
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
    throw new Error(
      'SettlementConfig: maxBucketDepth must be greater than 0'
    );
  }
  if (config.maxIterations !== undefined && config.maxIterations <= 0) {
    throw new Error(
      'SettlementConfig: maxIterations must be greater than 0'
    );
  }
}

export function validateAutoDiscoverConfig(config: KeeperConfig): void {
  const autoDiscover = config.autoDiscover;
  if (!autoDiscover?.enabled) {
    return;
  }
  const takePolicy = getAutoDiscoverTakePolicy(autoDiscover);
  const settlementPolicy = getAutoDiscoverSettlementPolicy(autoDiscover);

  if (autoDiscover.kick) {
    throw new Error('AutoDiscoverConfig: kick discovery is not supported in V1');
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
      takePolicy.minExpectedProfitQuote !== undefined &&
      takePolicy.minExpectedProfitQuote < 0
    ) {
      throw new Error(
        'AutoDiscoverConfig.take: minExpectedProfitQuote cannot be negative'
      );
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

    validateTakeSettings(discoveredTake, config);

    if (
      takePolicy.minExpectedProfitQuote !== undefined &&
      !hasExternalTakeSettings(discoveredTake)
    ) {
      throw new Error(
        'AutoDiscoverConfig: minExpectedProfitQuote requires discoveredDefaults.take to configure an external take path'
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
  if (config.takeWrite && config.takeWriteRpcUrl) {
    throw new Error(
      'KeeperConfig: configure only one of takeWrite or takeWriteRpcUrl'
    );
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
  }
}

export function validateTakeSettingsForChain(
  config: KeeperConfig,
  chainId: number
): void {
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
