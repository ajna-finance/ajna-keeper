import { ethers, providers } from 'ethers';
import {
  ExternalTakeLiquiditySource,
  ExternalTakePathKind,
  KeeperConfig,
  LiquiditySource,
  ResolvedExternalTakePolicy,
  UNISWAP_V3_FACTORY_ROUTE_REQUIRED_ADDRESS_FIELDS,
  formatLiquiditySource,
  getAggregatorProviderIdentity,
  getAutoDiscoverTakePolicy,
  getExternalTakeTakerContractKeyForSource,
  getExternalTakePathDescriptor,
  getManualPools,
  isExternalTakeLiquiditySource,
  resolveExternalTakePolicy,
  resolveExternalTakePathFromSource,
} from '../config';
import { reconcileTakerAllowlistSnapshot } from '../take/aggregator-calldata/allowlist';
import { normalizeLifiProductionChainPolicy } from '../dex/lifi/chain-policy';
import {
  hasOneInchAggregatorAllowlistPolicy,
  normalizeOneInchChainPolicy,
} from '../config/oneinch-aggregator-policy';
import { validateSushiAggregatorAllowlistPreflight } from '../dex/sushi-aggregator/preflight';
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

interface ContractCodePreflightRequirement {
  readonly label: string;
  readonly address: string | undefined;
}

interface ExternalTakeSourcePreflightInput {
  readonly config: KeeperConfig;
  readonly chainId: number;
  readonly source: ExternalTakeLiquiditySource;
}

interface ExternalTakeSourcePreflightValidationInput
  extends ExternalTakeSourcePreflightInput {
  readonly provider: providers.Provider;
  readonly takerAddress: string | undefined;
  readonly errors: string[];
}

interface ExternalTakeSourcePreflightDescriptor {
  readonly usesTakerRouterRegistry: boolean;
  readonly takerLabel: (source: ExternalTakeLiquiditySource) => string;
  readonly getTakerAddress: (
    params: ExternalTakeSourcePreflightInput
  ) => string | undefined;
  readonly getContractCodeRequirements: (
    params: ExternalTakeSourcePreflightInput
  ) => ContractCodePreflightRequirement[];
  readonly validateAdditional?: (
    params: ExternalTakeSourcePreflightValidationInput
  ) => Promise<void>;
}

function resolveAutodiscoverExternalTakePolicy(
  config: KeeperConfig
): ResolvedExternalTakePolicy | undefined {
  const takePolicy = getAutoDiscoverTakePolicy(config.discovery);
  if (!config.discovery?.enabled || !takePolicy) {
    return undefined;
  }
  const discoveredTake = config.discovery?.defaults?.take;
  return resolveExternalTakePolicy({
    defaultLiquiditySource: discoveredTake?.liquiditySource,
    takePolicy,
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

function addExternalTakePolicyRequirements(
  requirements: Map<string, ExternalTakeRoutePreflightRequirement>,
  policy: ResolvedExternalTakePolicy | undefined
): void {
  if (!policy) {
    return;
  }
  for (const source of policy.directDexRouteSources) {
    addPreflightRequirement(requirements, source);
  }
  for (const providerId of policy.calldataAggregatorProviders) {
    addPreflightRequirement(
      requirements,
      getAggregatorProviderIdentity(providerId).source
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
        getExternalTakePathDescriptor(path)
          .requiresRouteDeploymentValidation !== true)
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
  const requirements = new Map<string, ExternalTakeRoutePreflightRequirement>();
  addManualTakeRequirements(requirements, config, { onlyRequired: true });
  return getPreflightRequirements(requirements);
}

export function resolveAutodiscoverRoutePreflightRequirements(
  config: KeeperConfig
): ExternalTakeRoutePreflightRequirement[] {
  const requirements = new Map<string, ExternalTakeRoutePreflightRequirement>();
  addExternalTakePolicyRequirements(
    requirements,
    resolveAutodiscoverExternalTakePolicy(config)
  );
  return getPreflightRequirements(requirements);
}

export function resolveExternalTakeRoutePreflightRequirements(
  config: KeeperConfig
): ExternalTakeRoutePreflightRequirement[] {
  const requirements = new Map<string, ExternalTakeRoutePreflightRequirement>();
  addManualTakeRequirements(requirements, config);
  addExternalTakePolicyRequirements(
    requirements,
    resolveAutodiscoverExternalTakePolicy(config)
  );
  return getPreflightRequirements(requirements);
}

export function resolveExternalTakeRouteDeploymentPreflight(
  config: KeeperConfig
): ExternalTakeRouteDeploymentPreflightPlan {
  const requirements = new Map<string, ExternalTakeRoutePreflightRequirement>();
  if (
    getAutoDiscoverTakePolicy(config.discovery)?.validateRouteDeployments ===
    true
  ) {
    addExternalTakePolicyRequirements(
      requirements,
      resolveAutodiscoverExternalTakePolicy(config)
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

async function validateTakerRouterRegistry(params: {
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
        `keeperTakerRouter registry for ${formatLiquiditySource(params.source)} could not be read after retries: ${getErrorMessage(error)}`
      );
      return;
    }
    if (
      !ethers.utils.isAddress(registeredTaker) ||
      registeredTaker.toLowerCase() ===
        ethers.constants.AddressZero.toLowerCase()
    ) {
      params.errors.push(
        `keeperTakerRouter registry has no taker for ${formatLiquiditySource(params.source)}, expected ${params.expectedTaker}`
      );
      return;
    }
    if (registeredTaker.toLowerCase() !== params.expectedTaker.toLowerCase()) {
      params.errors.push(
        `keeperTakerRouter registry maps ${formatLiquiditySource(params.source)} to ${registeredTaker}, expected ${params.expectedTaker}`
      );
    }
  } catch (error) {
    params.errors.push(
      `keeperTakerRouter registry for ${formatLiquiditySource(params.source)} could not be read: ${getErrorMessage(error)}`
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

  // LI.FI reads selectors for its call targets AND any extra selectorAllowlist
  // keys, and retries only on classified-retryable RPC read errors.
  await reconcileTakerAllowlistSnapshot({
    provider: params.provider,
    takerAddress: params.takerAddress,
    policy,
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
    errors: params.errors,
  });
}

async function validateOneInchAggregatorAllowlistPreflight(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  chainId: number;
  takerAddress: string | undefined;
  errors: string[];
}): Promise<void> {
  const oneInch = params.config.dex?.oneInch;
  if (!hasOneInchAggregatorAllowlistPolicy(oneInch) || !params.takerAddress) {
    return;
  }
  let policy;
  try {
    policy = normalizeOneInchChainPolicy({
      config: oneInch!,
      fieldName: 'dex.oneInch',
      chainId: params.chainId,
    });
  } catch (error) {
    params.errors.push(
      `1inch production policy for chain ${params.chainId} is invalid: ${getErrorMessage(error)}`
    );
    return;
  }
  // Mirror LI.FI: every allowlisted call target + approval spender must have
  // on-chain code, else the taker reverts CallTargetHasNoCode at take time.
  for (const target of policy.callTargets) {
    await requireContractCode({
      provider: params.provider,
      label: `1inch call target ${target}`,
      address: target,
      errors: params.errors,
    });
  }
  for (const spender of policy.approvalSpenders) {
    await requireContractCode({
      provider: params.provider,
      label: `1inch approval spender ${spender}`,
      address: spender,
      errors: params.errors,
    });
  }
  // The 1inch take encodes approvalSpender = the configured router for the
  // chain; if that router is not in the approval-spender allowlist the taker
  // reverts ApprovalSpenderNotAllowed on-chain. Catch it here at startup.
  const configuredRouter = oneInch!.routers?.[params.chainId];
  if (
    configuredRouter &&
    !policy.approvalSpenders.some(
      (s) => s.toLowerCase() === configuredRouter.toLowerCase()
    )
  ) {
    params.errors.push(
      `1inch router ${configuredRouter} for chain ${params.chainId} is not in ` +
        `dex.oneInch.approvalSpenderAllowlist; takes set approvalSpender to it and ` +
        `would revert on-chain (ApprovalSpenderNotAllowed)`
    );
  }
  // Mirrors LI.FI: read selectors for the call targets AND any extra
  // selectorAllowlist keys, retrying only on classified-retryable RPC errors.
  await reconcileTakerAllowlistSnapshot({
    provider: params.provider,
    takerAddress: params.takerAddress,
    policy,
    selectorTargets: [
      ...policy.callTargets,
      ...Object.keys(policy.selectorAllowlist),
    ],
    labelPrefix: '1inch taker',
    read: async ({ label, operation }) => {
      const { value, error } = await retryRpcRead(operation);
      if (value === undefined) {
        throw new Error(
          `${label} could not be read after retries: ${getErrorMessage(error)}`
        );
      }
      return value;
    },
    errors: params.errors,
  });
}

function createRouterRegisteredPreflightDescriptor(params: {
  takerLabel?: (source: ExternalTakeLiquiditySource) => string;
  getContractCodeRequirements: (
    params: ExternalTakeSourcePreflightInput
  ) => ContractCodePreflightRequirement[];
  validateAdditional?: (
    params: ExternalTakeSourcePreflightValidationInput
  ) => Promise<void>;
}): ExternalTakeSourcePreflightDescriptor {
  return {
    usesTakerRouterRegistry: true,
    takerLabel:
      params.takerLabel ??
      ((source) => `${formatLiquiditySource(source)} taker`),
    getTakerAddress: ({ config, source }) =>
      getConfiguredTakerAddress(config, source),
    getContractCodeRequirements: params.getContractCodeRequirements,
    validateAdditional: params.validateAdditional,
  };
}

const EXTERNAL_TAKE_SOURCE_PREFLIGHT_DESCRIPTORS = {
  [LiquiditySource.ONEINCH]: createRouterRegisteredPreflightDescriptor({
    takerLabel: () => '1inch taker',
    getContractCodeRequirements: ({ config, chainId }) => [
      {
        label: `1inch router for chain ${chainId}`,
        address: config.dex?.oneInch?.routers?.[chainId],
      },
    ],
    validateAdditional: async ({
      config,
      provider,
      chainId,
      takerAddress,
      errors,
    }) => {
      await validateOneInchAggregatorAllowlistPreflight({
        config,
        provider,
        chainId,
        takerAddress,
        errors,
      });
    },
  }),
  [LiquiditySource.UNISWAPV3]: createRouterRegisteredPreflightDescriptor({
    getContractCodeRequirements: ({ config }) => {
      const routerConfig = config.dex?.uniswapV3?.router;
      return UNISWAP_V3_FACTORY_ROUTE_REQUIRED_ADDRESS_FIELDS.map((field) => ({
        label: `Uniswap V3 ${field}`,
        address: routerConfig?.[field],
      }));
    },
  }),
  [LiquiditySource.CURVE]: createRouterRegisteredPreflightDescriptor({
    getContractCodeRequirements: ({ config }) => [
      {
        label: 'Curve wethAddress',
        address: config.dex?.curve?.wethAddress,
      },
      ...Object.entries(config.dex?.curve?.poolConfigs ?? {}).map(
        ([pairName, poolConfig]) => ({
          label: `Curve pool ${pairName}`,
          address: poolConfig.address,
        })
      ),
    ],
  }),
  [LiquiditySource.LIFI]: createRouterRegisteredPreflightDescriptor({
    takerLabel: () => 'LI.FI taker',
    getContractCodeRequirements: () => [],
    validateAdditional: async ({
      config,
      provider,
      chainId,
      takerAddress,
      errors,
    }) => {
      await validateLifiAllowlistPreflight({
        config,
        provider,
        chainId,
        takerAddress,
        errors,
      });
    },
  }),
  [LiquiditySource.SUSHI_AGGREGATOR]: createRouterRegisteredPreflightDescriptor({
    takerLabel: () => 'Sushi aggregator taker',
    getContractCodeRequirements: () => [],
    validateAdditional: async ({
      config,
      provider,
      chainId,
      takerAddress,
      errors,
    }) => {
      await validateSushiAggregatorAllowlistPreflight({
        config,
        provider,
        chainId,
        takerAddress,
        errors,
      });
    },
  }),
} satisfies Record<
  ExternalTakeLiquiditySource,
  ExternalTakeSourcePreflightDescriptor
>;

function getExternalTakeSourcePreflightDescriptor(
  source: ExternalTakeLiquiditySource
): ExternalTakeSourcePreflightDescriptor {
  return EXTERNAL_TAKE_SOURCE_PREFLIGHT_DESCRIPTORS[source];
}

async function validateExternalTakeSourcePreflight(params: {
  config: KeeperConfig;
  provider: providers.Provider;
  chainId: number;
  source: ExternalTakeLiquiditySource;
  descriptor: ExternalTakeSourcePreflightDescriptor;
  errors: string[];
}): Promise<void> {
  const descriptorInput = {
    config: params.config,
    chainId: params.chainId,
    source: params.source,
  };
  const takerAddress = params.descriptor.getTakerAddress(descriptorInput);
  await requireContractCode({
    provider: params.provider,
    label: params.descriptor.takerLabel(params.source),
    address: takerAddress,
    errors: params.errors,
  });

  if (params.descriptor.usesTakerRouterRegistry) {
    await validateTakerRouterRegistry({
      provider: params.provider,
      factoryAddress: params.config.takers?.router,
      source: params.source,
      expectedTaker: takerAddress,
      errors: params.errors,
    });
  }

  for (const requirement of params.descriptor.getContractCodeRequirements(
    descriptorInput
  )) {
    await requireContractCode({
      provider: params.provider,
      label: requirement.label,
      address: requirement.address,
      errors: params.errors,
    });
  }

  await params.descriptor.validateAdditional?.({
    ...descriptorInput,
    provider: params.provider,
    takerAddress,
    errors: params.errors,
  });
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
  const sourcePreflights = requirements.map((requirement) => ({
    source: requirement.source,
    descriptor: getExternalTakeSourcePreflightDescriptor(requirement.source),
  }));
  if (
    sourcePreflights.some(({ descriptor }) => descriptor.usesTakerRouterRegistry)
  ) {
    await requireContractCode({
      provider: params.provider,
      label: 'takers.router',
      address: params.config.takers?.router,
      errors,
    });
  }

  for (const { source, descriptor } of sourcePreflights) {
    await validateExternalTakeSourcePreflight({
      config: params.config,
      provider: params.provider,
      chainId: params.chainId,
      source,
      descriptor,
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
