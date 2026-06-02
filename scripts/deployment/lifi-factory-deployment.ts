import { ethers } from 'ethers';
import * as path from 'path';
import { KeeperConfig, LiquiditySource } from '../../src/config';
import { normalizeLifiProductionChainPolicy } from '../../src/config/lifi-policy';
import {
  normalizeLifiAddressAllowlist,
  normalizeLifiSelectorAllowlistRecord,
} from '../../src/dex/lifi';

interface LifiProductionAllowlists {
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
}

type LifiSelectorEntry = { target: string; selector: string };

export interface LifiAllowlistReconciliationPlan {
  callTargetsToEnable: string[];
  callTargetsToDisable: string[];
  approvalSpendersToEnable: string[];
  approvalSpendersToDisable: string[];
  selectorsToEnable: LifiSelectorEntry[];
  selectorsToDisable: LifiSelectorEntry[];
  selectorTargets: string[];
}

type GasConfig = { gasLimit: string; gasPrice?: string };

function getArtifactPath(...segments: string[]): string {
  return path.join(__dirname, '..', '..', 'artifacts', ...segments);
}

function normalizeLifiSelectorsForTarget(
  target: string,
  selectors: readonly string[],
  label: string,
  requireNonEmpty = true
): string[] {
  if (!requireNonEmpty && selectors.length === 0) {
    return [];
  }
  const normalized = normalizeLifiSelectorAllowlistRecord(
    { [target]: selectors },
    { label, requireNonEmpty }
  );
  return normalized[ethers.utils.getAddress(target).toLowerCase()] ?? [];
}

function toLowerSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function getLifiProductionAllowlists(
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

function assertExactSet(
  label: string,
  expectedValues: readonly string[],
  actualValues: readonly string[]
): void {
  const expected = expectedValues.map((value) => value.toLowerCase()).sort();
  const actual = actualValues.map((value) => value.toLowerCase()).sort();
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    throw new Error(
      `${label} mismatch. expected=[${expected.join(',')}] actual=[${actual.join(',')}]`
    );
  }
}

function assertContainsSet(
  label: string,
  expectedValues: readonly string[],
  actualValues: readonly string[]
): void {
  const actual = toLowerSet(actualValues);
  const missing = expectedValues.filter(
    (value) => !actual.has(value.toLowerCase())
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} missing expected entries: [${missing.join(',')}]`
    );
  }
}

export function buildLifiAllowlistReconciliationPlan(params: {
  desired: LifiProductionAllowlists;
  currentCallTargets: readonly string[];
  currentApprovalSpenders: readonly string[];
  currentSelectorsByTarget: Record<string, readonly string[]>;
}): LifiAllowlistReconciliationPlan {
  const desiredCallTargets = toLowerSet(params.desired.callTargets);
  const desiredApprovalSpenders = toLowerSet(params.desired.approvalSpenders);
  const currentCallTargets = toLowerSet(params.currentCallTargets);
  const currentApprovalSpenders = toLowerSet(params.currentApprovalSpenders);

  const selectorTargets = new Map<string, string>();
  for (const target of [
    ...params.currentCallTargets,
    ...params.desired.callTargets,
    ...Object.keys(params.currentSelectorsByTarget),
    ...Object.keys(params.desired.selectorAllowlist),
  ]) {
    selectorTargets.set(target.toLowerCase(), target);
  }

  const selectorsToEnable: LifiSelectorEntry[] = [];
  const selectorsToDisable: LifiSelectorEntry[] = [];
  for (const target of Array.from(selectorTargets.values())) {
    const targetKey = target.toLowerCase();
    const desiredSelectors = toLowerSet(
      params.desired.selectorAllowlist[targetKey] ?? []
    );
    const currentSelectors = toLowerSet(
      params.currentSelectorsByTarget[targetKey] ?? []
    );
    for (const selector of params.desired.selectorAllowlist[targetKey] ?? []) {
      if (!currentSelectors.has(selector.toLowerCase())) {
        selectorsToEnable.push({ target, selector });
      }
    }
    for (const selector of params.currentSelectorsByTarget[targetKey] ?? []) {
      if (!desiredSelectors.has(selector.toLowerCase())) {
        selectorsToDisable.push({ target, selector });
      }
    }
  }

  return {
    callTargetsToEnable: params.desired.callTargets.filter(
      (target) => !currentCallTargets.has(target.toLowerCase())
    ),
    callTargetsToDisable: params.currentCallTargets.filter(
      (target) => !desiredCallTargets.has(target.toLowerCase())
    ),
    approvalSpendersToEnable: params.desired.approvalSpenders.filter(
      (spender) => !currentApprovalSpenders.has(spender.toLowerCase())
    ),
    approvalSpendersToDisable: params.currentApprovalSpenders.filter(
      (spender) => !desiredApprovalSpenders.has(spender.toLowerCase())
    ),
    selectorsToEnable,
    selectorsToDisable,
    selectorTargets: Array.from(selectorTargets.values()),
  };
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
  const currentCallTargets = normalizeLifiAddressAllowlist(
    await taker.getAllowedCallTargets(),
    {
      label: 'on-chain LI.FI call target allowlist',
    }
  );
  const currentApprovalSpenders = normalizeLifiAddressAllowlist(
    await taker.getAllowedApprovalSpenders(),
    {
      label: 'on-chain LI.FI approval spender allowlist',
    }
  );

  const selectorTargets = new Map<string, string>();
  for (const target of [
    ...currentCallTargets,
    ...desired.callTargets,
    ...Object.keys(desired.selectorAllowlist),
  ]) {
    selectorTargets.set(target.toLowerCase(), target);
  }
  const currentSelectorsByTarget: Record<string, string[]> = {};
  for (const target of Array.from(selectorTargets.values())) {
    currentSelectorsByTarget[target.toLowerCase()] =
      normalizeLifiSelectorsForTarget(
        target,
        await taker.getAllowedCallSelectors(target),
        `on-chain LI.FI selector allowlist for ${target}`,
        false
      );
  }

  const plan = buildLifiAllowlistReconciliationPlan({
    desired,
    currentCallTargets,
    currentApprovalSpenders,
    currentSelectorsByTarget,
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

  assertContainsSet(
    'LI.FI call target allowlist',
    desired.callTargets,
    normalizeLifiAddressAllowlist(await taker.getAllowedCallTargets(), {
      label: 'on-chain LI.FI call target allowlist',
    })
  );
  assertContainsSet(
    'LI.FI approval spender allowlist',
    desired.approvalSpenders,
    normalizeLifiAddressAllowlist(await taker.getAllowedApprovalSpenders(), {
      label: 'on-chain LI.FI approval spender allowlist',
    })
  );
  for (const target of desired.callTargets) {
    assertContainsSet(
      `LI.FI selector allowlist for ${target}`,
      desired.selectorAllowlist[target.toLowerCase()] ?? [],
      normalizeLifiSelectorsForTarget(
        target,
        await taker.getAllowedCallSelectors(target),
        `on-chain LI.FI selector allowlist for ${target}`,
        false
      )
    );
  }

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

  assertExactSet(
    'LI.FI call target allowlist',
    desired.callTargets,
    normalizeLifiAddressAllowlist(await taker.getAllowedCallTargets(), {
      label: 'on-chain LI.FI call target allowlist',
    })
  );
  assertExactSet(
    'LI.FI approval spender allowlist',
    desired.approvalSpenders,
    normalizeLifiAddressAllowlist(await taker.getAllowedApprovalSpenders(), {
      label: 'on-chain LI.FI approval spender allowlist',
    })
  );
  for (const target of plan.selectorTargets) {
    assertExactSet(
      `LI.FI selector allowlist for ${target}`,
      desired.selectorAllowlist[target.toLowerCase()] ?? [],
      normalizeLifiSelectorsForTarget(
        target,
        await taker.getAllowedCallSelectors(target),
        `on-chain LI.FI selector allowlist for ${target}`,
        false
      )
    );
  }

  console.log(
    `🎉 LI.FI allowlists configured: targets=${desired.callTargets.length}, spenders=${desired.approvalSpenders.length}, selectorTargets=${Object.keys(desired.selectorAllowlist).length}`
  );
}
