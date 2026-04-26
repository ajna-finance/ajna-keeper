import { ethers, providers } from 'ethers';
import {
  ExternalTakePathKind,
  KeeperConfig,
  LiquiditySource,
  getAutoDiscoverTakePolicy,
} from '../config';
import { logger } from '../logging';

const FACTORY_TAKER_REGISTRY_ABI = [
  'function takerContracts(uint8 source) view returns (address)',
];
const FACTORY_REGISTRY_READ_RETRY_DELAYS_MS = [100, 250];

const FACTORY_SOURCES = [
  LiquiditySource.UNISWAPV3,
  LiquiditySource.SUSHISWAP,
  LiquiditySource.CURVE,
];

const TAKER_CONTRACT_KEYS: Record<LiquiditySource, string[]> = {
  [LiquiditySource.NONE]: [],
  [LiquiditySource.ONEINCH]: ['OneInch', 'ONEINCH', 'oneinch', '1'],
  [LiquiditySource.UNISWAPV3]: [
    'UniswapV3',
    'UNISWAPV3',
    'uniswapV3',
    'uniswapv3',
    '2',
  ],
  [LiquiditySource.SUSHISWAP]: ['SushiSwap', 'SUSHISWAP', 'sushiswap', '3'],
  [LiquiditySource.CURVE]: ['Curve', 'CURVE', 'curve', '4'],
};

function isFactorySource(
  source: LiquiditySource | undefined
): source is
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.SUSHISWAP
  | LiquiditySource.CURVE {
  return source !== undefined && FACTORY_SOURCES.includes(source);
}

function getEffectiveExternalTakePaths(
  config: KeeperConfig
): Set<ExternalTakePathKind> {
  const takePolicy = getAutoDiscoverTakePolicy(config.autoDiscover);
  const discoveredTake = config.discoveredDefaults?.take;
  if (takePolicy?.allowedExternalTakePaths?.length) {
    return new Set(takePolicy.allowedExternalTakePaths);
  }
  if (discoveredTake?.liquiditySource === LiquiditySource.ONEINCH) {
    return new Set<ExternalTakePathKind>(['oneinch']);
  }
  if (isFactorySource(discoveredTake?.liquiditySource)) {
    return new Set<ExternalTakePathKind>(['factory']);
  }
  return new Set<ExternalTakePathKind>();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableRpcReadError(error: unknown): boolean {
  const maybeError = error as { code?: unknown; reason?: unknown };
  const code =
    typeof maybeError.code === 'string' ? maybeError.code.toLowerCase() : '';
  const reason =
    typeof maybeError.reason === 'string'
      ? maybeError.reason.toLowerCase()
      : '';
  const message = getErrorMessage(error).toLowerCase();
  return [
    'timeout',
    'timed out',
    'econnreset',
    'econnrefused',
    'etimedout',
    'network',
    '429',
    '502',
    '503',
    '504',
    'server error',
    'bad gateway',
  ].some(
    (needle) =>
      code.includes(needle) ||
      reason.includes(needle) ||
      message.includes(needle)
  );
}

function getEffectiveFactorySources(config: KeeperConfig): LiquiditySource[] {
  const takePolicy = getAutoDiscoverTakePolicy(config.autoDiscover);
  if (takePolicy?.allowedLiquiditySources?.length) {
    return takePolicy.allowedLiquiditySources.filter(isFactorySource);
  }

  const discoveredSource = config.discoveredDefaults?.take?.liquiditySource;
  if (isFactorySource(discoveredSource)) {
    return [discoveredSource];
  }
  const defaultFactoryLiquiditySource =
    takePolicy?.defaultFactoryLiquiditySource;
  if (isFactorySource(defaultFactoryLiquiditySource)) {
    return [defaultFactoryLiquiditySource];
  }
  return [];
}

function getConfiguredTakerAddress(
  config: KeeperConfig,
  source: LiquiditySource
): string | undefined {
  const takerContracts = config.takerContracts;
  if (!takerContracts) {
    return undefined;
  }

  for (const key of TAKER_CONTRACT_KEYS[source]) {
    const address = takerContracts[key];
    if (address) {
      return address;
    }
  }
  return undefined;
}

async function requireContractCode(params: {
  provider: providers.Provider;
  label: string;
  address: string | undefined;
  errors: string[];
}): Promise<void> {
  if (!params.address) {
    params.errors.push(`${params.label} address is not configured`);
    return;
  }
  if (!ethers.utils.isAddress(params.address)) {
    params.errors.push(`${params.label} address is invalid: ${params.address}`);
    return;
  }

  let code: string | undefined;
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= FACTORY_REGISTRY_READ_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      code = await params.provider.getCode(params.address);
      break;
    } catch (error) {
      lastError = error;
      if (
        !isRetryableRpcReadError(error) ||
        attempt === FACTORY_REGISTRY_READ_RETRY_DELAYS_MS.length
      ) {
        break;
      }
      await sleepMs(FACTORY_REGISTRY_READ_RETRY_DELAYS_MS[attempt]);
    }
  }
  if (code === undefined) {
    if (isRetryableRpcReadError(lastError)) {
      logger.warn(
        `${params.label} code could not be read after retries; skipping bytecode preflight for this address: ${getErrorMessage(lastError)}`
      );
      return;
    }
    params.errors.push(
      `${params.label} code could not be read at ${params.address}: ${getErrorMessage(lastError)}`
    );
    return;
  }
  if (code === '0x') {
    params.errors.push(
      `${params.label} has no contract code at ${params.address}`
    );
  }
}

async function validateFactoryRegistry(params: {
  provider: providers.Provider;
  factoryAddress: string | undefined;
  source: LiquiditySource;
  expectedTaker: string | undefined;
  errors: string[];
}): Promise<void> {
  if (!params.factoryAddress || !params.expectedTaker) {
    return;
  }

  try {
    const factory = new ethers.Contract(
      params.factoryAddress,
      FACTORY_TAKER_REGISTRY_ABI,
      params.provider
    );
    let registeredTaker: string | undefined;
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= FACTORY_REGISTRY_READ_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        registeredTaker = await factory.takerContracts(params.source);
        break;
      } catch (error) {
        lastError = error;
        if (
          !isRetryableRpcReadError(error) ||
          attempt === FACTORY_REGISTRY_READ_RETRY_DELAYS_MS.length
        ) {
          break;
        }
        await sleepMs(FACTORY_REGISTRY_READ_RETRY_DELAYS_MS[attempt]);
      }
    }
    if (registeredTaker === undefined) {
      if (isRetryableRpcReadError(lastError)) {
        logger.warn(
          `keeperTakerFactory registry for ${LiquiditySource[params.source]} could not be read after retries; skipping registry preflight for this source: ${getErrorMessage(lastError)}`
        );
        return;
      }
      params.errors.push(
        `keeperTakerFactory registry for ${LiquiditySource[params.source]} could not be read: ${getErrorMessage(lastError)}`
      );
      return;
    }
    if (
      !ethers.utils.isAddress(registeredTaker) ||
      registeredTaker.toLowerCase() ===
        ethers.constants.AddressZero.toLowerCase()
    ) {
      params.errors.push(
        `keeperTakerFactory registry has no taker for ${LiquiditySource[params.source]}, expected ${params.expectedTaker}`
      );
      return;
    }
    if (registeredTaker.toLowerCase() !== params.expectedTaker.toLowerCase()) {
      params.errors.push(
        `keeperTakerFactory registry maps ${LiquiditySource[params.source]} to ${registeredTaker}, expected ${params.expectedTaker}`
      );
    }
  } catch (error) {
    params.errors.push(
      `keeperTakerFactory registry for ${LiquiditySource[params.source]} could not be read: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Performs startup-only checks for the contracts required by the enabled
 * autodiscover external-take paths. This is intentionally fail-fast: route
 * deployment mismatches should be fixed before the keeper enters a hot cycle.
 */
export async function validateAutoDiscoverRouteDeployments(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  chainId: number;
}): Promise<void> {
  const paths = getEffectiveExternalTakePaths(params.config);
  if (paths.size === 0) {
    return;
  }

  const errors: string[] = [];
  if (paths.has('oneinch')) {
    await requireContractCode({
      provider: params.provider,
      label: `1inch router for chain ${params.chainId}`,
      address: params.config.oneInchRouters?.[params.chainId],
      errors,
    });
    await requireContractCode({
      provider: params.provider,
      label: 'keeperTaker',
      address: params.config.keeperTaker,
      errors,
    });
  }

  if (paths.has('factory')) {
    await requireContractCode({
      provider: params.provider,
      label: 'keeperTakerFactory',
      address: params.config.keeperTakerFactory,
      errors,
    });

    for (const source of getEffectiveFactorySources(params.config)) {
      const takerAddress = getConfiguredTakerAddress(params.config, source);
      await requireContractCode({
        provider: params.provider,
        label: `${LiquiditySource[source]} taker`,
        address: takerAddress,
        errors,
      });
      await validateFactoryRegistry({
        provider: params.provider,
        factoryAddress: params.config.keeperTakerFactory,
        source,
        expectedTaker: takerAddress,
        errors,
      });

      if (source === LiquiditySource.UNISWAPV3) {
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 universalRouterAddress',
          address:
            params.config.universalRouterOverrides?.universalRouterAddress,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 permit2Address',
          address: params.config.universalRouterOverrides?.permit2Address,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 poolFactoryAddress',
          address: params.config.universalRouterOverrides?.poolFactoryAddress,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 quoterV2Address',
          address: params.config.universalRouterOverrides?.quoterV2Address,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 wethAddress',
          address: params.config.universalRouterOverrides?.wethAddress,
          errors,
        });
      }

      if (source === LiquiditySource.SUSHISWAP) {
        await requireContractCode({
          provider: params.provider,
          label: 'SushiSwap swapRouterAddress',
          address: params.config.sushiswapRouterOverrides?.swapRouterAddress,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'SushiSwap factoryAddress',
          address: params.config.sushiswapRouterOverrides?.factoryAddress,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'SushiSwap quoterV2Address',
          address: params.config.sushiswapRouterOverrides?.quoterV2Address,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'SushiSwap wethAddress',
          address: params.config.sushiswapRouterOverrides?.wethAddress,
          errors,
        });
      }

      if (source === LiquiditySource.CURVE) {
        await requireContractCode({
          provider: params.provider,
          label: 'Curve wethAddress',
          address: params.config.curveRouterOverrides?.wethAddress,
          errors,
        });
        for (const [pairName, poolConfig] of Object.entries(
          params.config.curveRouterOverrides?.poolConfigs ?? {}
        )) {
          await requireContractCode({
            provider: params.provider,
            label: `Curve pool ${pairName}`,
            address: poolConfig.address,
            errors,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Route deployment preflight failed:\n${errors
        .map((error) => `- ${error}`)
        .join('\n')}`
    );
  }

  logger.info('Route deployment preflight passed');
}
