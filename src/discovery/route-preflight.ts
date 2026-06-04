import { ethers, providers } from 'ethers';
import {
  ExternalTakeLiquiditySource,
  ExternalTakePathKind,
  KeeperConfig,
  LiquiditySource,
  UNISWAP_V3_FACTORY_ROUTE_CONTRACT_ADDRESS_FIELDS,
  formatLiquiditySource,
  getAutoDiscoverTakePolicy,
  getExternalTakeTakerContractKeyForSource,
  getExternalTakePathDefaultSource,
  getExternalTakePathDescriptor,
  getManualPools,
  isExternalTakeLiquiditySource,
  resolveExternalTakePaths,
  resolveExternalTakePathFromSource,
  resolveFactoryRouteSelectionSources,
} from '../config';
import {
  LIFI_TAKER_ALLOWLIST_ABI,
  compareLifiTakerAllowlistPolicy,
  createLifiTakerAllowlistReader,
  readLifiTakerAllowlistSnapshot,
} from '../dex/lifi';
import { normalizeLifiProductionChainPolicy } from '../dex/lifi/chain-policy';
import { logger } from '../logging';
import { getErrorMessage } from '../utils';

const FACTORY_TAKER_REGISTRY_ABI = [
  'function takerContracts(uint8 source) view returns (address)',
];
const FACTORY_REGISTRY_READ_RETRY_DELAYS_MS = [100, 250, 500];

export interface ExternalTakeRoutePreflightRequirement {
  readonly path: ExternalTakePathKind;
  readonly source: ExternalTakeLiquiditySource;
}

export interface ExternalTakeRouteDeploymentPreflightPlan {
  readonly shouldValidate: boolean;
  readonly requirements: readonly ExternalTakeRoutePreflightRequirement[];
}

function getAutodiscoverExternalTakePaths(
  config: KeeperConfig
): ExternalTakePathKind[] {
  const takePolicy = getAutoDiscoverTakePolicy(config.discovery);
  if (!config.discovery?.enabled || !takePolicy) {
    return [];
  }
  const discoveredTake = config.discovery?.defaults?.take;
  return resolveExternalTakePaths({
    defaultLiquiditySource: discoveredTake?.liquiditySource,
    allowedExternalTakePaths: takePolicy?.allowedExternalTakePaths,
  });
}

function addPreflightRequirement(
  requirements: Map<string, ExternalTakeRoutePreflightRequirement>,
  source: LiquiditySource | undefined
): void {
  if (!isExternalTakeLiquiditySource(source)) {
    return;
  }
  const path = resolveExternalTakePathFromSource(source);
  if (!path) {
    return;
  }
  requirements.set(`${path}:${source}`, { path, source });
}

function addExternalTakePathRequirements(
  requirements: Map<string, ExternalTakeRoutePreflightRequirement>,
  config: KeeperConfig,
  paths: readonly ExternalTakePathKind[]
): void {
  const takePolicy = getAutoDiscoverTakePolicy(config.discovery);
  for (const path of paths) {
    if (path === 'factory') {
      for (const source of resolveFactoryRouteSelectionSources({
        defaultLiquiditySource:
          config.discovery?.defaults?.take?.liquiditySource,
        allowedLiquiditySources: takePolicy?.allowedLiquiditySources,
        configuredDefaultFactoryLiquiditySource:
          takePolicy?.defaultFactoryLiquiditySource,
      })) {
        addPreflightRequirement(requirements, source);
      }
      continue;
    }

    addPreflightRequirement(
      requirements,
      getExternalTakePathDefaultSource(path)
    );
  }
}

function addManualTakeRequirements(
  requirements: Map<string, ExternalTakeRoutePreflightRequirement>,
  config: KeeperConfig,
  options: { onlyRequired?: boolean } = {}
): void {
  for (const poolConfig of getManualPools(config)) {
    const source = poolConfig.take?.liquiditySource;
    const path = resolveExternalTakePathFromSource(source);
    if (
      options.onlyRequired &&
      (path === undefined ||
        getExternalTakePathDescriptor(path).requiresRouteDeploymentValidation !==
          true)
    ) {
      continue;
    }
    addPreflightRequirement(requirements, source);
  }
}

function getPreflightRequirements(
  requirements: Map<string, ExternalTakeRoutePreflightRequirement>
): ExternalTakeRoutePreflightRequirement[] {
  return Array.from(requirements.values());
}

export function resolveManualRequiredRoutePreflightRequirements(
  config: KeeperConfig
): ExternalTakeRoutePreflightRequirement[] {
  const requirements = new Map<
    string,
    ExternalTakeRoutePreflightRequirement
  >();
  addManualTakeRequirements(requirements, config, { onlyRequired: true });
  return getPreflightRequirements(requirements);
}

export function resolveAutodiscoverRoutePreflightRequirements(
  config: KeeperConfig
): ExternalTakeRoutePreflightRequirement[] {
  const requirements = new Map<
    string,
    ExternalTakeRoutePreflightRequirement
  >();
  addExternalTakePathRequirements(
    requirements,
    config,
    getAutodiscoverExternalTakePaths(config)
  );
  return getPreflightRequirements(requirements);
}

export function resolveExternalTakeRoutePreflightRequirements(
  config: KeeperConfig
): ExternalTakeRoutePreflightRequirement[] {
  const requirements = new Map<
    string,
    ExternalTakeRoutePreflightRequirement
  >();
  addManualTakeRequirements(requirements, config);
  addExternalTakePathRequirements(
    requirements,
    config,
    getAutodiscoverExternalTakePaths(config)
  );
  return getPreflightRequirements(requirements);
}

export function resolveExternalTakeRouteDeploymentPreflight(
  config: KeeperConfig
): ExternalTakeRouteDeploymentPreflightPlan {
  const requirements = new Map<
    string,
    ExternalTakeRoutePreflightRequirement
  >();
  if (
    getAutoDiscoverTakePolicy(config.discovery)?.validateRouteDeployments ===
    true
  ) {
    addExternalTakePathRequirements(
      requirements,
      config,
      getAutodiscoverExternalTakePaths(config)
    );
  }
  if (!config.runtime.dryRun) {
    addManualTakeRequirements(requirements, config, { onlyRequired: true });
  }
  const resolvedRequirements = getPreflightRequirements(requirements);
  return {
    shouldValidate: resolvedRequirements.length > 0,
    requirements: resolvedRequirements,
  };
}

export function shouldValidateExternalTakeRouteDeployments(
  config: KeeperConfig
): boolean {
  return resolveExternalTakeRouteDeploymentPreflight(config).shouldValidate;
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

function getConfiguredTakerAddress(
  config: KeeperConfig,
  source: LiquiditySource
): string | undefined {
  const contractKey = getExternalTakeTakerContractKeyForSource(source);
  if (!contractKey) {
    return undefined;
  }
  return config.takers?.contracts?.[contractKey];
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

  try {
    const taker = new ethers.Contract(
      params.takerAddress,
      LIFI_TAKER_ALLOWLIST_ABI,
      params.provider
    );
    const actual = await readLifiTakerAllowlistSnapshot({
      reader: createLifiTakerAllowlistReader(taker),
      selectorTargets: [
        ...expectedTargets,
        ...Object.keys(policy.selectorAllowlist),
      ],
      labelPrefix: 'LI.FI taker',
      read: async ({ label, operation }) => {
        const { value, error } = await retryRpcRead(operation);
        if (value === undefined) {
          throw new Error(
            `${label} could not be read after retries: ${getErrorMessage(error)}`
          );
        }
        return value;
      },
    });
    params.errors.push(
      ...compareLifiTakerAllowlistPolicy({
        expected: policy,
        actual,
        mode: 'exact',
      })
    );
  } catch (error) {
    params.errors.push(getErrorMessage(error));
  }
}

function formatTakerLabel(source: LiquiditySource): string {
  return source === LiquiditySource.LIFI
    ? 'LI.FI taker'
    : `${formatLiquiditySource(source)} taker`;
}

async function validateFactoryBackedSourcePreflight(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  chainId: number;
  source: ExternalTakeLiquiditySource;
  errors: string[];
}): Promise<void> {
  const takerAddress = getConfiguredTakerAddress(
    params.config,
    params.source
  );
  await requireContractCode({
    provider: params.provider,
    label: formatTakerLabel(params.source),
    address: takerAddress,
    errors: params.errors,
  });
  await validateFactoryRegistry({
    provider: params.provider,
    factoryAddress: params.config.takers?.factory,
    source: params.source,
    expectedTaker: takerAddress,
    errors: params.errors,
  });

  if (params.source === LiquiditySource.UNISWAPV3) {
    const routerConfig = params.config.dex?.uniswapV3?.router;
    for (const field of UNISWAP_V3_FACTORY_ROUTE_CONTRACT_ADDRESS_FIELDS) {
      await requireContractCode({
        provider: params.provider,
        label: `Uniswap V3 ${field}`,
        address: routerConfig?.[field],
        errors: params.errors,
      });
    }
  }

  if (params.source === LiquiditySource.SUSHISWAP) {
    await requireContractCode({
      provider: params.provider,
      label: 'SushiSwap swapRouterAddress',
      address: params.config.dex?.sushiswap?.swapRouterAddress,
      errors: params.errors,
    });
    await requireContractCode({
      provider: params.provider,
      label: 'SushiSwap factoryAddress',
      address: params.config.dex?.sushiswap?.factoryAddress,
      errors: params.errors,
    });
    await requireContractCode({
      provider: params.provider,
      label: 'SushiSwap quoterV2Address',
      address: params.config.dex?.sushiswap?.quoterV2Address,
      errors: params.errors,
    });
    await requireContractCode({
      provider: params.provider,
      label: 'SushiSwap wethAddress',
      address: params.config.dex?.sushiswap?.wethAddress,
      errors: params.errors,
    });
  }

  if (params.source === LiquiditySource.CURVE) {
    await requireContractCode({
      provider: params.provider,
      label: 'Curve wethAddress',
      address: params.config.dex?.curve?.wethAddress,
      errors: params.errors,
    });
    for (const [pairName, poolConfig] of Object.entries(
      params.config.dex?.curve?.poolConfigs ?? {}
    )) {
      await requireContractCode({
        provider: params.provider,
        label: `Curve pool ${pairName}`,
        address: poolConfig.address,
        errors: params.errors,
      });
    }
  }

  if (params.source === LiquiditySource.LIFI) {
    await validateLifiAllowlistPreflight({
      config: params.config,
      provider: params.provider,
      chainId: params.chainId,
      takerAddress,
      errors: params.errors,
    });
  }
}

/**
 * Performs startup-only checks for the contracts required by the enabled
 * external-take paths. This is intentionally fail-fast: route
 * deployment mismatches should be fixed before the keeper enters a hot cycle.
 */
export async function validateExternalTakeRouteDeployments(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  chainId: number;
  requirements?: readonly ExternalTakeRoutePreflightRequirement[];
}): Promise<void> {
  const requirements =
    params.requirements ??
    resolveExternalTakeRoutePreflightRequirements(params.config);
  if (requirements.length === 0) {
    return;
  }

  const errors: string[] = [];
  if (requirements.some((requirement) => requirement.path === 'oneinch')) {
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

  const factoryBackedRequirements = requirements.filter(
    (requirement) =>
      getExternalTakeTakerContractKeyForSource(requirement.source) !==
      undefined
  );
  if (factoryBackedRequirements.length > 0) {
    await requireContractCode({
      provider: params.provider,
      label: 'takers.factory',
      address: params.config.takers?.factory,
      errors,
    });

    for (const { source } of factoryBackedRequirements) {
      await validateFactoryBackedSourcePreflight({
        config: params.config,
        provider: params.provider,
        chainId: params.chainId,
        source,
        errors,
      });
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

export async function validateAutoDiscoverRouteDeployments(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  chainId: number;
}): Promise<void> {
  await validateExternalTakeRouteDeployments({
    ...params,
    requirements: resolveAutodiscoverRoutePreflightRequirements(params.config),
  });
}
