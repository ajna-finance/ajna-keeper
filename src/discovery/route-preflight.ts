import { ethers, providers } from 'ethers';
import {
  ExternalTakePathKind,
  KeeperConfig,
  LiquiditySource,
  formatLiquiditySource,
  getAutoDiscoverTakePolicy,
  resolveExternalTakePaths,
  resolveFactoryRouteSelectionSources,
} from '../config';
import { logger } from '../logging';
import { getErrorMessage } from '../utils';

const FACTORY_TAKER_REGISTRY_ABI = [
  'function takerContracts(uint8 source) view returns (address)',
];
const FACTORY_REGISTRY_READ_RETRY_DELAYS_MS = [100, 250, 500];

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

function getEffectiveExternalTakePaths(
  config: KeeperConfig
): Set<ExternalTakePathKind> {
  const takePolicy = getAutoDiscoverTakePolicy(config.discovery);
  const discoveredTake = config.discovery?.defaults?.take;
  return new Set(
    resolveExternalTakePaths({
      defaultLiquiditySource: discoveredTake?.liquiditySource,
      allowedExternalTakePaths: takePolicy?.allowedExternalTakePaths,
    })
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function retryRpcRead<T>(operation: () => Promise<T>): Promise<{
  value?: T;
  error?: unknown;
}> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= FACTORY_REGISTRY_READ_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return { value: await operation() };
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
  return { error: lastError };
}

function getEffectiveFactorySources(config: KeeperConfig): LiquiditySource[] {
  const takePolicy = getAutoDiscoverTakePolicy(config.discovery);
  return resolveFactoryRouteSelectionSources({
    defaultLiquiditySource: config.discovery?.defaults?.take?.liquiditySource,
    allowedLiquiditySources: takePolicy?.allowedLiquiditySources,
    configuredDefaultFactoryLiquiditySource:
      takePolicy?.defaultFactoryLiquiditySource,
  });
}

function getConfiguredTakerAddress(
  config: KeeperConfig,
  source: LiquiditySource
): string | undefined {
  const takerContracts = config.takers?.contracts;
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
  const address = params.address;

  const { value: code, error } = await retryRpcRead(() =>
    params.provider.getCode(address)
  );
  if (code === undefined) {
    params.errors.push(
      `${params.label} code could not be read after retries at ${address}: ${getErrorMessage(error)}`
    );
    return;
  }
  if (code === '0x') {
    params.errors.push(`${params.label} has no contract code at ${address}`);
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
    const { value: registeredTaker, error } = await retryRpcRead<string>(() =>
      factory.takerContracts(params.source)
    );
    if (registeredTaker === undefined) {
      params.errors.push(
        `keeperTakerFactory registry for ${formatLiquiditySource(params.source)} could not be read after retries: ${getErrorMessage(error)}`
      );
      return;
    }
    if (
      !ethers.utils.isAddress(registeredTaker) ||
      registeredTaker.toLowerCase() ===
        ethers.constants.AddressZero.toLowerCase()
    ) {
      params.errors.push(
        `keeperTakerFactory registry has no taker for ${formatLiquiditySource(params.source)}, expected ${params.expectedTaker}`
      );
      return;
    }
    if (registeredTaker.toLowerCase() !== params.expectedTaker.toLowerCase()) {
      params.errors.push(
        `keeperTakerFactory registry maps ${formatLiquiditySource(params.source)} to ${registeredTaker}, expected ${params.expectedTaker}`
      );
    }
  } catch (error) {
    params.errors.push(
      `keeperTakerFactory registry for ${formatLiquiditySource(params.source)} could not be read: ${getErrorMessage(error)}`
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
      address: params.config.dex?.oneInch?.routers?.[params.chainId],
      errors,
    });
    await requireContractCode({
      provider: params.provider,
      label: 'takers.oneInch',
      address: params.config.takers?.oneInch,
      errors,
    });
  }

  if (paths.has('factory')) {
    await requireContractCode({
      provider: params.provider,
      label: 'takers.factory',
      address: params.config.takers?.factory,
      errors,
    });

    for (const source of getEffectiveFactorySources(params.config)) {
      const takerAddress = getConfiguredTakerAddress(params.config, source);
      await requireContractCode({
        provider: params.provider,
        label: `${formatLiquiditySource(source)} taker`,
        address: takerAddress,
        errors,
      });
      await validateFactoryRegistry({
        provider: params.provider,
        factoryAddress: params.config.takers?.factory,
        source,
        expectedTaker: takerAddress,
        errors,
      });

      if (source === LiquiditySource.UNISWAPV3) {
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 swapRouter02Address',
          address:
            params.config.dex?.uniswapV3?.universalRouter
              ?.swapRouter02Address,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 poolFactoryAddress',
          address:
            params.config.dex?.uniswapV3?.universalRouter?.poolFactoryAddress,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 quoterV2Address',
          address:
            params.config.dex?.uniswapV3?.universalRouter?.quoterV2Address,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'Uniswap V3 wethAddress',
          address: params.config.dex?.uniswapV3?.universalRouter?.wethAddress,
          errors,
        });
      }

      if (source === LiquiditySource.SUSHISWAP) {
        await requireContractCode({
          provider: params.provider,
          label: 'SushiSwap swapRouterAddress',
          address: params.config.dex?.sushiswap?.swapRouterAddress,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'SushiSwap factoryAddress',
          address: params.config.dex?.sushiswap?.factoryAddress,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'SushiSwap quoterV2Address',
          address: params.config.dex?.sushiswap?.quoterV2Address,
          errors,
        });
        await requireContractCode({
          provider: params.provider,
          label: 'SushiSwap wethAddress',
          address: params.config.dex?.sushiswap?.wethAddress,
          errors,
        });
      }

      if (source === LiquiditySource.CURVE) {
        await requireContractCode({
          provider: params.provider,
          label: 'Curve wethAddress',
          address: params.config.dex?.curve?.wethAddress,
          errors,
        });
        for (const [pairName, poolConfig] of Object.entries(
          params.config.dex?.curve?.poolConfigs ?? {}
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
