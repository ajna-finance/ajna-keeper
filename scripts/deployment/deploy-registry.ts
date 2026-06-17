import { ethers } from 'ethers';
import * as path from 'path';
import { KeeperConfig, LiquiditySource } from '../../src/config';
import {
  type ExternalTakeTakerContractKey,
  getExternalTakeLiquiditySourceDescriptor,
} from '../../src/config/external-take-descriptors';
import { normalizeLifiProductionChainPolicy } from '../../src/config/lifi-policy';
import { normalizeSushiAggregatorChainPolicy } from '../../src/config/sushi-aggregator-policy';
import {
  hasOneInchAggregatorAllowlistPolicy,
  normalizeOneInchChainPolicy,
} from '../../src/config/oneinch-aggregator-policy';
import {
  AGGREGATOR_TAKER_ALLOWLIST_ABI,
  assertTakerAllowlistPolicy,
  buildTakerAllowlistReconciliationPlan,
  createTakerAllowlistReader,
  type NormalizedTakerAllowlistPolicy,
  readTakerAllowlistSnapshot,
} from '../../src/take/aggregator-calldata/allowlist';

// DEPLOY-SIDE registry for the descriptor-driven deploy loop (plan item M-A).
//
// Placement rationale: this lives in scripts/deployment/ — NOT in the canonical
// src/config/external-take-descriptors.ts EXTERNAL_TAKE_SOURCE_IDENTITIES table —
// on purpose. The canonical identities own only runtime-shared metadata
// (source/path/provider/taker/label). The two fields the deploy loop needs
// (`takerArtifact` build-output path and `normalizeChainPolicy` function ref)
// are deploy-only concerns: artifacts exist only after `yarn compile`, and the
// per-provider normalizers are deploy/preflight machinery. Hanging them off the
// runtime identities would couple the runtime config surface to the artifacts
// directory and the deploy-only normalizers. So the deploy descriptors compose
// the canonical identity (label / takerContractKey / source) with these two
// deploy-local fields here.

export type GasConfig = { gasLimit: string; gasPrice?: string };

export type DeploymentAddressKey =
  | 'uniswapTaker'
  | 'curveTaker'
  | 'lifiTaker'
  | 'sushiAggregatorTaker'
  | 'oneInchAggregatorTaker';

// Per-source artifact path under artifacts/contracts/takers/<Sol>/<Json>.
type TakerArtifact = {
  contractFileName: string; // e.g. 'UniswapV3KeeperTaker.sol'
  artifactName: string; // e.g. 'UniswapV3KeeperTaker.json'
};

export interface DeployTakerContext {
  deployer: ethers.Wallet;
  ajnaPoolFactory: string;
  factoryAddress: string;
  chainId: number;
  getGasConfig: (chainId: number) => GasConfig;
}

interface DeployDescriptorBase {
  readonly source: LiquiditySource;
  readonly label: string;
  readonly takerContractKey: ExternalTakeTakerContractKey;
  readonly addressKey: DeploymentAddressKey;
  readonly takerArtifact: TakerArtifact;
  // Step label printed by the deploy phase (preserves the original CLI strings).
  readonly deployStepLabel: string;
  // Operator-facing summary line in generateConfigUpdate ("<icon> <name>: addr").
  readonly summaryIcon: string;
  readonly summaryContractName: string;
}

export interface DirectDexDeployDescriptor extends DeployDescriptorBase {
  readonly category: 'direct_dex';
  // Gating predicate: deploy this taker when its dex config is present.
  isConfigured(config: KeeperConfig): boolean;
}

export interface AggregatorDeployDescriptor extends DeployDescriptorBase {
  readonly category: 'aggregator';
  // Diagnostic label prefix threaded into the provider-neutral allowlist helpers.
  readonly allowlistLabelPrefix: string;
  // Gating predicate: deploy this taker when its dex config is present.
  isConfigured(config: KeeperConfig): boolean;
  // Resolve the reviewed desired allowlist policy for the detected chain, or
  // undefined to short-circuit allowlist reconciliation (LI.FI canary mode:
  // taker is not deployed at all, so this never resolves a policy in practice;
  // kept for parity / explicit short-circuit semantics).
  normalizeChainPolicy(
    config: KeeperConfig,
    chainId: number
  ): NormalizedTakerAllowlistPolicy | undefined;
}

export type DeployDescriptor =
  | DirectDexDeployDescriptor
  | AggregatorDeployDescriptor;

function takerArtifactPath(artifact: TakerArtifact): string {
  return path.join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'contracts',
    'takers',
    artifact.contractFileName,
    artifact.artifactName
  );
}

function factoryArtifactPath(): string {
  return path.join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'contracts',
    'factories',
    'TakerRouter.sol',
    'TakerRouter.json'
  );
}

function loadFactoryContract(
  deployer: ethers.Wallet,
  factoryAddress: string
): ethers.Contract {
  const factoryArtifact = require(factoryArtifactPath());
  return new ethers.Contract(factoryAddress, factoryArtifact.abi, deployer);
}

// Generic router registration: replaces the per-direct-DEX setTaker calls in the
// old configureFactory if-chain AND the near-identical registerLifiTakerInFactory
// / registerSushiAggregatorTakerInFactory functions (B-S2). For aggregator
// sources this MUST run only after reconcileTakerAllowlists has succeeded, so the
// router never maps the source to a taker with incomplete/unverified allowlists.
export async function registerTakerInRouter(params: {
  descriptor: DeployDescriptor;
  deployer: ethers.Wallet;
  factoryAddress: string;
  takerAddress: string;
}): Promise<void> {
  const { descriptor, deployer, factoryAddress, takerAddress } = params;
  console.log(`\n⚙️  Registering ${descriptor.label} taker in router...`);
  const factory = loadFactoryContract(deployer, factoryAddress);
  const tx = await factory.setTaker(descriptor.source, takerAddress);
  console.log(`✅ ${descriptor.label} registration tx:`, tx.hash);
  await tx.wait();
  console.log(`🎉 Router configured with ${descriptor.label} taker`);
  await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
}

// Generic post-registration verification for a deployed+registered taker.
// Fixes B-S1: the old hand-unrolled verifyDeployment had a Uniswap branch and a
// LI.FI branch but NO Sushi branch; routing every registered taker through this
// helper gives Sushi (and any future aggregator) the same router-config /
// authorization / owner checks.
export async function verifyTakerRegistration(params: {
  descriptor: DeployDescriptor;
  deployer: ethers.Wallet;
  factoryAddress: string;
  takerAddress: string;
}): Promise<void> {
  const { descriptor, deployer, factoryAddress, takerAddress } = params;
  const factory = loadFactoryContract(deployer, factoryAddress);

  const hasTaker = await factory.hasConfiguredTaker(descriptor.source);
  const registeredTaker = await factory.takerContracts(descriptor.source);
  const factoryOwner = await factory.owner();
  console.log(`- ${descriptor.label} Configured: ${hasTaker}`);
  console.log(`- Registered ${descriptor.label} Taker: ${registeredTaker}`);
  console.log(`- Expected ${descriptor.label} Taker: ${takerAddress}`);

  const takerArtifact = require(takerArtifactPath(descriptor.takerArtifact));
  const taker = new ethers.Contract(takerAddress, takerArtifact.abi, deployer);
  const takerOwner = await taker.owner();
  const authorizedRouter = await taker.authorizedRouter();
  console.log(`- ${descriptor.label} Taker Owner: ${takerOwner}`);
  console.log(`- ${descriptor.label} Authorized Router: ${authorizedRouter}`);
  console.log(`- Expected Router: ${factoryAddress}`);

  if (
    !hasTaker ||
    registeredTaker.toLowerCase() !== takerAddress.toLowerCase()
  ) {
    throw new Error(
      `❌ ${descriptor.label} factory configuration verification failed`
    );
  }
  if (authorizedRouter.toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error(
      `❌ ${descriptor.label} taker authorization verification failed`
    );
  }
  if (
    takerOwner.toLowerCase() !== deployer.address.toLowerCase() ||
    factoryOwner.toLowerCase() !== deployer.address.toLowerCase()
  ) {
    throw new Error(`❌ ${descriptor.label} owner verification failed`);
  }
}

// Generic taker deploy: replaces the four near-identical per-provider deploy
// functions (deployUniswapTaker / deployCurveKeeperTaker / deployLifiKeeperTaker
// / deploySushiAggregatorKeeperTaker). Every taker constructor takes
// (ajnaPoolFactory, authorizedRouter) and is deployed with the same manual gas
// settings, so only the artifact + log labels differ per descriptor.
export async function deployTaker(
  descriptor: DeployDescriptor,
  context: DeployTakerContext
): Promise<string> {
  console.log(`\n📦 ${descriptor.deployStepLabel}`);

  const takerArtifact = require(takerArtifactPath(descriptor.takerArtifact));
  const TakerContractFactory = new ethers.ContractFactory(
    takerArtifact.abi,
    takerArtifact.bytecode,
    context.deployer
  );

  const gasConfig = context.getGasConfig(context.chainId);
  const deployOptions: any = { gasLimit: gasConfig.gasLimit };
  if (gasConfig.gasPrice) {
    deployOptions.gasPrice = gasConfig.gasPrice;
  }

  const taker = await TakerContractFactory.deploy(
    context.ajnaPoolFactory, // Ajna pool factory
    context.factoryAddress, // Authorized router (CRITICAL: never zero)
    deployOptions
  );
  console.log(
    `✅ ${descriptor.label} taker deployment tx:`,
    taker.deployTransaction.hash
  );
  await taker.deployed();
  console.log(`🎉 ${descriptor.summaryContractName} deployed to:`, taker.address);

  return taker.address;
}

// Net-new generic orchestration consolidating what configureLifiAllowlists and
// configureSushiAggregatorAllowlists duplicated (B-S3). Applies the reviewed
// desired allowlists to the deployed taker and EXACTLY reconciles on-chain state
// to the policy. Binds AGGREGATOR_TAKER_ALLOWLIST_ABI directly (the alias shims
// are gone). MUST run before the taker is registered in the router so the router
// never enables a taker whose on-chain allowlists are incomplete/unverified.
export async function reconcileTakerAllowlists(params: {
  deployer: ethers.Wallet;
  takerAddress: string;
  desired: NormalizedTakerAllowlistPolicy;
  labelPrefix: string;
}): Promise<void> {
  const { deployer, takerAddress, desired, labelPrefix } = params;
  console.log(`\n⚙️  Configuring ${labelPrefix} allowlists...`);

  const taker = new ethers.Contract(
    takerAddress,
    AGGREGATOR_TAKER_ALLOWLIST_ABI,
    deployer
  );
  const reader = createTakerAllowlistReader(taker);
  const selectorTargets = [
    ...desired.callTargets,
    ...Object.keys(desired.selectorAllowlist),
  ];

  const current = await readTakerAllowlistSnapshot({
    reader,
    selectorTargets,
    labelPrefix,
  });
  const plan = buildTakerAllowlistReconciliationPlan({ desired, current });

  for (const target of plan.callTargetsToEnable) {
    const tx = await taker.setCallTarget(target, true);
    console.log(`✅ ${labelPrefix} call target ${target} tx:`, tx.hash);
    await tx.wait();
  }
  for (const spender of plan.approvalSpendersToEnable) {
    const tx = await taker.setApprovalSpender(spender, true);
    console.log(`✅ ${labelPrefix} approval spender ${spender} tx:`, tx.hash);
    await tx.wait();
  }
  for (const { target, selector } of plan.selectorsToEnable) {
    const tx = await taker.setCallSelector(target, selector, true);
    console.log(
      `✅ ${labelPrefix} selector ${selector} for ${target} tx:`,
      tx.hash
    );
    await tx.wait();
  }

  // Verify the enable phase landed before disabling any stale entries.
  assertTakerAllowlistPolicy({
    expected: desired,
    actual: await readTakerAllowlistSnapshot({
      reader,
      selectorTargets,
      labelPrefix,
    }),
    mode: 'contains',
  });

  for (const { target, selector } of plan.selectorsToDisable) {
    const tx = await taker.setCallSelector(target, selector, false);
    console.log(
      `Disabled stale ${labelPrefix} selector ${selector} for ${target} tx:`,
      tx.hash
    );
    await tx.wait();
  }
  for (const target of plan.callTargetsToDisable) {
    const tx = await taker.setCallTarget(target, false);
    console.log(
      `Disabled stale ${labelPrefix} call target ${target} tx:`,
      tx.hash
    );
    await tx.wait();
  }
  for (const spender of plan.approvalSpendersToDisable) {
    const tx = await taker.setApprovalSpender(spender, false);
    console.log(
      `Disabled stale ${labelPrefix} approval spender ${spender} tx:`,
      tx.hash
    );
    await tx.wait();
  }

  // Exact match: on-chain allowlists must equal the reviewed policy.
  assertTakerAllowlistPolicy({
    expected: desired,
    actual: await readTakerAllowlistSnapshot({
      reader,
      selectorTargets: plan.selectorTargets,
      labelPrefix,
    }),
    mode: 'exact',
  });

  console.log(
    `🎉 ${labelPrefix} allowlists configured: targets=${desired.callTargets.length}, spenders=${desired.approvalSpenders.length}, selectorTargets=${Object.keys(desired.selectorAllowlist).length}`
  );
}

function deployDescriptorFor(params: {
  source: LiquiditySource;
  addressKey: DeploymentAddressKey;
  takerArtifact: TakerArtifact;
  deployStepLabel: string;
  summaryIcon: string;
  summaryContractName: string;
}) {
  const identity = getExternalTakeLiquiditySourceDescriptor(
    params.source as Parameters<
      typeof getExternalTakeLiquiditySourceDescriptor
    >[0]
  );
  if (!identity.takerContractKey) {
    throw new Error(
      `deploy descriptor for ${LiquiditySource[params.source]} requires a takerContractKey`
    );
  }
  return {
    source: params.source,
    label: identity.label,
    takerContractKey: identity.takerContractKey,
    addressKey: params.addressKey,
    takerArtifact: params.takerArtifact,
    deployStepLabel: params.deployStepLabel,
    summaryIcon: params.summaryIcon,
    summaryContractName: params.summaryContractName,
  };
}

// Ordered deploy registry. The loop iterates in this order so the deploy /
// register / verify sequence and the config-update summary match the original
// hand-unrolled order: Uniswap, Curve, LI.FI, Sushi. 1inch is intentionally
// absent (W3-FINAL); the CLI keeps its explicit fail-before-deploy throw.
export const DEPLOY_DESCRIPTORS: readonly DeployDescriptor[] = [
  {
    ...deployDescriptorFor({
      source: LiquiditySource.UNISWAPV3,
      addressKey: 'uniswapTaker',
      takerArtifact: {
        contractFileName: 'UniswapV3KeeperTaker.sol',
        artifactName: 'UniswapV3KeeperTaker.json',
      },
      deployStepLabel: 'Step 2: Deploying UniswapV3KeeperTaker...',
      summaryIcon: '🦄',
      summaryContractName: 'UniswapV3KeeperTaker',
    }),
    category: 'direct_dex',
    isConfigured: (config) => Boolean(config.dex?.uniswapV3?.router),
  },
  {
    ...deployDescriptorFor({
      source: LiquiditySource.CURVE,
      addressKey: 'curveTaker',
      takerArtifact: {
        contractFileName: 'CurveKeeperTaker.sol',
        artifactName: 'CurveKeeperTaker.json',
      },
      deployStepLabel: 'Step 2c: Deploying CurveKeeperTaker...',
      summaryIcon: '🌊',
      summaryContractName: 'CurveKeeperTaker',
    }),
    category: 'direct_dex',
    isConfigured: (config) => Boolean(config.dex?.curve),
  },
  {
    ...deployDescriptorFor({
      source: LiquiditySource.LIFI,
      addressKey: 'lifiTaker',
      takerArtifact: {
        contractFileName: 'LifiKeeperTaker.sol',
        artifactName: 'LifiKeeperTaker.json',
      },
      deployStepLabel: 'Step 2d: Deploying LifiKeeperTaker...',
      summaryIcon: '🔁',
      summaryContractName: 'LifiKeeperTaker',
    }),
    category: 'aggregator',
    allowlistLabelPrefix: 'LI.FI',
    // Deploy LI.FI taker only for production configs. Canary configs are for
    // route-shape discovery and fork validation, not live registration.
    isConfigured: (config) => config.dex?.lifi?.mode === 'production',
    normalizeChainPolicy: (config, chainId) => {
      const lifi = config.dex?.lifi;
      if (!lifi) {
        throw new Error('LI.FI production config is required for deployment');
      }
      return normalizeLifiProductionChainPolicy({
        config: lifi,
        fieldName: 'LI.FI',
        chainId,
      });
    },
  },
  {
    ...deployDescriptorFor({
      source: LiquiditySource.SUSHI_AGGREGATOR,
      addressKey: 'sushiAggregatorTaker',
      takerArtifact: {
        contractFileName: 'SushiAggregatorKeeperTaker.sol',
        artifactName: 'SushiAggregatorKeeperTaker.json',
      },
      deployStepLabel: 'Deploying SushiAggregatorKeeperTaker...',
      summaryIcon: '🍣',
      summaryContractName: 'SushiAggregatorKeeperTaker',
    }),
    category: 'aggregator',
    allowlistLabelPrefix: 'Sushi aggregator taker',
    isConfigured: (config) => Boolean(config.dex?.sushiAggregator),
    normalizeChainPolicy: (config, chainId) => {
      const sushiAggregator = config.dex?.sushiAggregator;
      if (!sushiAggregator) {
        throw new Error(
          'dex.sushiAggregator config is required for Sushi aggregator deployment'
        );
      }
      return normalizeSushiAggregatorChainPolicy({
        config: sushiAggregator,
        fieldName: 'dex.sushiAggregator',
        chainId,
      });
    },
  },
  {
    ...deployDescriptorFor({
      source: LiquiditySource.ONEINCH,
      addressKey: 'oneInchAggregatorTaker',
      takerArtifact: {
        contractFileName: 'OneInchAggregatorKeeperTaker.sol',
        artifactName: 'OneInchAggregatorKeeperTaker.json',
      },
      deployStepLabel: 'Deploying OneInchAggregatorKeeperTaker...',
      summaryIcon: '🟦',
      summaryContractName: 'OneInchAggregatorKeeperTaker',
    }),
    category: 'aggregator',
    allowlistLabelPrefix: '1inch aggregator taker',
    // 1inch is provisioned only when dex.oneInch carries a production allowlist
    // policy; without it, 1inch is quote/discovery-only (no on-chain taker).
    isConfigured: (config) =>
      hasOneInchAggregatorAllowlistPolicy(config.dex?.oneInch),
    normalizeChainPolicy: (config, chainId) => {
      const oneInch = config.dex?.oneInch;
      if (!oneInch) {
        throw new Error(
          'dex.oneInch config is required for 1inch aggregator deployment'
        );
      }
      return normalizeOneInchChainPolicy({
        config: oneInch,
        fieldName: 'dex.oneInch',
        chainId,
      });
    },
  },
];
