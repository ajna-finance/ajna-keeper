import { ethers } from 'ethers';
import * as path from 'path';
import {
  KeeperConfig,
  LiquiditySource,
  type NormalizedLifiAllowlistPolicy,
} from '../../src/config';
import { normalizeLifiProductionChainPolicy } from '../../src/config/lifi-policy';
import {
  assertLifiTakerAllowlistPolicy,
  buildLifiTakerAllowlistReconciliationPlan,
  createLifiTakerAllowlistReader,
  type LifiAllowlistReconciliationPlan,
  readLifiTakerAllowlistSnapshot,
  normalizeLifiTakerAllowlistSnapshot,
} from '../../src/dex/lifi';

export type LifiProductionAllowlists = NormalizedLifiAllowlistPolicy;
export type { LifiAllowlistReconciliationPlan };

type GasConfig = { gasLimit: string; gasPrice?: string };

function getArtifactPath(...segments: string[]): string {
  return path.join(__dirname, '..', '..', 'artifacts', ...segments);
}

export function getLifiProductionAllowlists(
  config: KeeperConfig,
  chainId: number
): LifiProductionAllowlists {
  const lifi = config.dex?.lifi;
  if (!lifi) {
    throw new Error('LI.FI production config is required for deployment');
  }
  const policy = normalizeLifiProductionChainPolicy({
    config: lifi,
    fieldName: 'LI.FI',
    chainId,
  });
  return {
    callTargets: policy.callTargets,
    approvalSpenders: policy.approvalSpenders,
    selectorAllowlist: policy.selectorAllowlist,
  };
}

export function hasProductionLifiConfig(config: KeeperConfig): boolean {
  return config.dex?.lifi?.mode === 'production';
}

export function getLifiProductionDeploymentGateMessages(
  configPath: string
): string[] {
  return [
    `Run the LI.FI route-shape gate: AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true npm run lifi-route-canary -- --config ${configPath}`,
    `Run the LI.FI callback-path fork gate: AJNA_AGENT_LIFI_FORK_CANARY_CONFIG=${configPath} npm run lifi-fork-execution-canary`,
    'For non-Base LI.FI production support, run an equivalent reviewed chain-specific fork canary before live use',
    `After both LI.FI gates pass, test startup with: yarn start --config ${configPath}`,
  ];
}

export function buildLifiAllowlistReconciliationPlan(params: {
  desired: LifiProductionAllowlists;
  currentCallTargets: readonly string[];
  currentApprovalSpenders: readonly string[];
  currentSelectorsByTarget: Record<string, readonly string[]>;
}): LifiAllowlistReconciliationPlan {
  return buildLifiTakerAllowlistReconciliationPlan({
    desired: params.desired,
    current: normalizeLifiTakerAllowlistSnapshot({
      callTargets: params.currentCallTargets,
      approvalSpenders: params.currentApprovalSpenders,
      selectorAllowlist: params.currentSelectorsByTarget,
      selectorTargets: [
        ...params.desired.callTargets,
        ...Object.keys(params.desired.selectorAllowlist),
      ],
      labelPrefix: 'on-chain LI.FI',
    }),
  });
}

export function validateDetectedChainLifiProductionConfig(
  config: KeeperConfig,
  chainInfo: { chainId: number; name: string }
): void {
  if (!hasProductionLifiConfig(config)) {
    return;
  }

  const { callTargets, approvalSpenders, selectorAllowlist } =
    getLifiProductionAllowlists(config, chainInfo.chainId);
  console.log(
    `✅ LI.FI production allowlists validated for ${chainInfo.name} (${chainInfo.chainId}): targets=${callTargets.length}, spenders=${approvalSpenders.length}, selectorTargets=${Object.keys(selectorAllowlist).length}`
  );
}

export async function deployLifiKeeperTaker(
  deployer: ethers.Wallet,
  ajnaPoolFactory: string,
  factoryAddress: string,
  chainId: number,
  getGasConfig: (chainId: number) => GasConfig
): Promise<string> {
  console.log('\n📦 Step 2d: Deploying LifiKeeperTaker...');

  const takerArtifactPath = getArtifactPath(
    'contracts',
    'takers',
    'LifiKeeperTaker.sol',
    'LifiKeeperTaker.json'
  );
  const takerArtifact = require(takerArtifactPath);

  const LifiKeeperTaker = new ethers.ContractFactory(
    takerArtifact.abi,
    takerArtifact.bytecode,
    deployer
  );

  const gasConfig = getGasConfig(chainId);
  const deployOptions: any = {
    gasLimit: gasConfig.gasLimit,
  };

  if (gasConfig.gasPrice) {
    deployOptions.gasPrice = gasConfig.gasPrice;
  }

  const taker = await LifiKeeperTaker.deploy(
    ajnaPoolFactory,
    factoryAddress,
    deployOptions
  );

  console.log('✅ LI.FI taker deployment tx:', taker.deployTransaction.hash);
  await taker.deployed();
  console.log('🎉 LifiKeeperTaker deployed to:', taker.address);

  return taker.address;
}

// Register the LI.FI taker in the factory. Must run only after
// configureLifiAllowlists has succeeded (allowlists applied and reconciled),
// keeping factory enablement strictly downstream of verified config/on-chain
// agreement per the LI.FI plan's atomic operational runbook.
export async function registerLifiTakerInFactory(
  deployer: ethers.Wallet,
  factoryAddress: string,
  addresses: { lifiTaker?: string }
): Promise<void> {
  if (!addresses.lifiTaker) {
    return;
  }
  console.log('\n⚙️  Step 3c: Registering LI.FI taker in factory...');
  const factoryArtifact = require(
    getArtifactPath(
      'contracts',
      'factories',
      'AjnaKeeperTakerFactory.sol',
      'AjnaKeeperTakerFactory.json'
    )
  );
  const factory = new ethers.Contract(
    factoryAddress,
    factoryArtifact.abi,
    deployer
  );
  // Register LI.FI taker (LiquiditySource.LIFI = 5)
  const setLifiTakerTx = await factory.setTaker(
    LiquiditySource.LIFI,
    addresses.lifiTaker
  );
  console.log('✅ LI.FI configuration tx:', setLifiTakerTx.hash);
  await setLifiTakerTx.wait();
  console.log('🎉 Factory configured with LI.FI taker');
  await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
}

export async function configureLifiAllowlists(
  deployer: ethers.Wallet,
  takerAddress: string,
  config: KeeperConfig,
  chainId: number
): Promise<void> {
  if (!hasProductionLifiConfig(config)) {
    return;
  }

  console.log('\n⚙️  Step 3b: Configuring LI.FI taker allowlists...');

  const takerArtifactPath = getArtifactPath(
    'contracts',
    'takers',
    'LifiKeeperTaker.sol',
    'LifiKeeperTaker.json'
  );
  const takerArtifact = require(takerArtifactPath);
  const taker = new ethers.Contract(takerAddress, takerArtifact.abi, deployer);

  const desired = getLifiProductionAllowlists(config, chainId);
  const desiredSelectorTargets = [
    ...desired.callTargets,
    ...Object.keys(desired.selectorAllowlist),
  ];
  const current = await readLifiTakerAllowlistSnapshot({
    reader: createLifiTakerAllowlistReader(taker),
    selectorTargets: desiredSelectorTargets,
    labelPrefix: 'on-chain LI.FI',
  });

  const plan = buildLifiTakerAllowlistReconciliationPlan({
    desired,
    current,
  });

  for (const target of plan.callTargetsToEnable) {
    const tx = await taker.setCallTarget(target, true);
    console.log(`✅ LI.FI call target ${target} tx:`, tx.hash);
    await tx.wait();
  }

  for (const spender of plan.approvalSpendersToEnable) {
    const tx = await taker.setApprovalSpender(spender, true);
    console.log(`✅ LI.FI approval spender ${spender} tx:`, tx.hash);
    await tx.wait();
  }

  for (const { target, selector } of plan.selectorsToEnable) {
    const tx = await taker.setCallSelector(target, selector, true);
    console.log(`✅ LI.FI selector ${selector} for ${target} tx:`, tx.hash);
    await tx.wait();
  }

  assertLifiTakerAllowlistPolicy({
    expected: desired,
    actual: await readLifiTakerAllowlistSnapshot({
      reader: createLifiTakerAllowlistReader(taker),
      selectorTargets: desiredSelectorTargets,
      labelPrefix: 'on-chain LI.FI',
    }),
    mode: 'contains',
  });

  for (const { target, selector } of plan.selectorsToDisable) {
    const tx = await taker.setCallSelector(target, selector, false);
    console.log(
      `Disabled stale LI.FI selector ${selector} for ${target} tx:`,
      tx.hash
    );
    await tx.wait();
  }

  for (const target of plan.callTargetsToDisable) {
    const tx = await taker.setCallTarget(target, false);
    console.log(`Disabled stale LI.FI call target ${target} tx:`, tx.hash);
    await tx.wait();
  }

  for (const spender of plan.approvalSpendersToDisable) {
    const tx = await taker.setApprovalSpender(spender, false);
    console.log(
      `Disabled stale LI.FI approval spender ${spender} tx:`,
      tx.hash
    );
    await tx.wait();
  }

  assertLifiTakerAllowlistPolicy({
    expected: desired,
    actual: await readLifiTakerAllowlistSnapshot({
      reader: createLifiTakerAllowlistReader(taker),
      selectorTargets: plan.selectorTargets,
      labelPrefix: 'on-chain LI.FI',
    }),
    mode: 'exact',
  });

  console.log(
    `🎉 LI.FI allowlists configured: targets=${desired.callTargets.length}, spenders=${desired.approvalSpenders.length}, selectorTargets=${Object.keys(desired.selectorAllowlist).length}`
  );
}
