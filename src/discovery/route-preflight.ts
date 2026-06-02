import { ethers, providers } from 'ethers';
import {
  ExternalTakePathKind,
  KeeperConfig,
  LiquiditySource,
  UNISWAP_V3_FACTORY_ROUTE_CONTRACT_ADDRESS_FIELDS,
  formatLiquiditySource,
  getAutoDiscoverTakePolicy,
  normalizeLifiProductionChainPolicy,
  resolveExternalTakePaths,
  resolveFactoryRouteSelectionSources,
} from '../config';
import { normalizeLifiAddressAllowlist } from '../dex/lifi';
import { logger } from '../logging';
import { getErrorMessage } from '../utils';

const FACTORY_TAKER_REGISTRY_ABI = [
  'function takerContracts(uint8 source) view returns (address)',
];
const LIFI_TAKER_ALLOWLIST_ABI = [
  'function getAllowedCallTargets() view returns (address[])',
  'function getAllowedApprovalSpenders() view returns (address[])',
  'function getAllowedCallSelectors(address target) view returns (bytes4[])',
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
  [LiquiditySource.LIFI]: ['Lifi'],
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

function normalizeAddressList(
  addresses: readonly string[] | undefined,
  label: string,
  errors: string[]
): string[] {
  try {
    return normalizeLifiAddressAllowlist(addresses, { label })
      .map((address) => address.toLowerCase())
      .sort();
  } catch (error) {
    errors.push(`${label} is invalid: ${getErrorMessage(error)}`);
    return [];
  }
}

function normalizeSelectorList(
  selectors: readonly string[] | undefined
): string[] {
  return Array.from(
    new Set((selectors ?? []).map((selector) => selector.toLowerCase()))
  ).sort();
}

function assertExactSet(params: {
  label: string;
  expected: readonly string[];
  actual: readonly string[];
  errors: string[];
}): void {
  if (
    params.expected.length !== params.actual.length ||
    params.expected.some((value, index) => value !== params.actual[index])
  ) {
    params.errors.push(
      `${params.label} mismatch: expected [${params.expected.join(
        ', '
      )}], got [${params.actual.join(', ')}]`
    );
  }
}

async function readLifiAllowlist<T>(params: {
  provider: providers.Provider;
  takerAddress: string;
  operation: (contract: ethers.Contract) => Promise<T>;
  label: string;
  errors: string[];
}): Promise<T | undefined> {
  const contract = new ethers.Contract(
    params.takerAddress,
    LIFI_TAKER_ALLOWLIST_ABI,
    params.provider
  );
  const { value, error } = await retryRpcRead(() => params.operation(contract));
  if (value === undefined) {
    params.errors.push(
      `${params.label} could not be read after retries: ${getErrorMessage(error)}`
    );
    return undefined;
  }
  return value;
}

async function validateLifiAllowlistPreflight(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  chainId: number;
  takerAddress: string | undefined;
  errors: string[];
}): Promise<void> {
  const lifi = params.config.dex?.lifi;
  if (!lifi || lifi.mode !== 'production' || !params.takerAddress) {
    return;
  }

  let policy;
  try {
    policy = normalizeLifiProductionChainPolicy({
      config: lifi,
      fieldName: 'LI.FI',
      chainId: params.chainId,
    });
  } catch (error) {
    params.errors.push(
      `LI.FI production policy for chain ${params.chainId} is invalid: ${getErrorMessage(error)}`
    );
    return;
  }
  const expectedTargets = policy.callTargets
    .map((target) => target.toLowerCase())
    .sort();
  const expectedSpenders = policy.approvalSpenders
    .map((spender) => spender.toLowerCase())
    .sort();
  const expectedSelectorsByTarget = policy.selectorAllowlist;

  for (const target of expectedTargets) {
    await requireContractCode({
      provider: params.provider,
      label: `LI.FI call target ${target}`,
      address: target,
      errors: params.errors,
    });
  }
  for (const spender of expectedSpenders) {
    await requireContractCode({
      provider: params.provider,
      label: `LI.FI approval spender ${spender}`,
      address: spender,
      errors: params.errors,
    });
  }

  const actualTargets = await readLifiAllowlist<string[]>({
    provider: params.provider,
    takerAddress: params.takerAddress,
    label: 'LI.FI taker call target allowlist',
    errors: params.errors,
    operation: (contract) => contract.getAllowedCallTargets(),
  });
  const actualSpenders = await readLifiAllowlist<string[]>({
    provider: params.provider,
    takerAddress: params.takerAddress,
    label: 'LI.FI taker approval spender allowlist',
    errors: params.errors,
    operation: (contract) => contract.getAllowedApprovalSpenders(),
  });

  if (actualTargets !== undefined) {
    assertExactSet({
      label: 'LI.FI taker call target allowlist',
      expected: expectedTargets,
      actual: normalizeAddressList(
        actualTargets,
        'LI.FI taker call target allowlist',
        params.errors
      ),
      errors: params.errors,
    });
  }
  if (actualSpenders !== undefined) {
    assertExactSet({
      label: 'LI.FI taker approval spender allowlist',
      expected: expectedSpenders,
      actual: normalizeAddressList(
        actualSpenders,
        'LI.FI taker approval spender allowlist',
        params.errors
      ),
      errors: params.errors,
    });
  }

  for (const target of expectedTargets) {
    const configuredSelectors = expectedSelectorsByTarget[target] ?? [];
    const expectedSelectors = normalizeSelectorList(configuredSelectors);
    if (expectedSelectors.length === 0) {
      params.errors.push(
        `LI.FI selectorAllowlist.${params.chainId}.${target} is not configured`
      );
      continue;
    }
    const actualSelectors = await readLifiAllowlist<string[]>({
      provider: params.provider,
      takerAddress: params.takerAddress,
      label: `LI.FI taker selector allowlist for ${target}`,
      errors: params.errors,
      operation: (contract) => contract.getAllowedCallSelectors(target),
    });
    if (actualSelectors !== undefined) {
      assertExactSet({
        label: `LI.FI taker selector allowlist for ${target}`,
        expected: expectedSelectors,
        actual: normalizeSelectorList(actualSelectors),
        errors: params.errors,
      });
    }
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
        const routerConfig = params.config.dex?.uniswapV3?.router;
        for (const field of UNISWAP_V3_FACTORY_ROUTE_CONTRACT_ADDRESS_FIELDS) {
          await requireContractCode({
            provider: params.provider,
            label: `Uniswap V3 ${field}`,
            address: routerConfig?.[field],
            errors,
          });
        }
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

  if (paths.has('lifi')) {
    await requireContractCode({
      provider: params.provider,
      label: 'takers.factory',
      address: params.config.takers?.factory,
      errors,
    });

    const takerAddress = getConfiguredTakerAddress(
      params.config,
      LiquiditySource.LIFI
    );
    await requireContractCode({
      provider: params.provider,
      label: 'LI.FI taker',
      address: takerAddress,
      errors,
    });
    await validateFactoryRegistry({
      provider: params.provider,
      factoryAddress: params.config.takers?.factory,
      source: LiquiditySource.LIFI,
      expectedTaker: takerAddress,
      errors,
    });
    await validateLifiAllowlistPreflight({
      config: params.config,
      provider: params.provider,
      chainId: params.chainId,
      takerAddress,
      errors,
    });
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
