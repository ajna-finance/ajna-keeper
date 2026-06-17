import { ethers } from 'ethers';
import * as path from 'path';
import { KeeperConfig, LiquiditySource } from '../../src/config';
import {
  normalizeSushiAggregatorChainPolicy,
  type NormalizedSushiAggregatorChainPolicy,
} from '../../src/config/sushi-aggregator-policy';
import {
  AGGREGATOR_TAKER_ALLOWLIST_ABI,
  assertTakerAllowlistPolicy,
  buildTakerAllowlistReconciliationPlan,
  createTakerAllowlistReader,
  readTakerAllowlistSnapshot,
} from '../../src/take/aggregator-calldata/allowlist';

// Sushi-aggregator taker deployment (Packet 3B). Mirrors the LI.FI module:
// deploy the taker, apply the reviewed dex.sushiAggregator allowlists, exactly
// reconcile/verify them, then register the verified taker so the router never
// maps LiquiditySource.SUSHI_AGGREGATOR to a taker whose on-chain allowlists are
// incomplete or unverified. Desired allowlists are derived with the SAME
// normalizer the runtime preflight uses, and reconciliation/assertion reuse the
// provider-neutral aggregator allowlist machinery.

type GasConfig = { gasLimit: string; gasPrice?: string };

const SUSHI_AGGREGATOR_LABEL_PREFIX = 'Sushi aggregator taker';

function getArtifactPath(...segments: string[]): string {
  return path.join(__dirname, '..', '..', 'artifacts', ...segments);
}

export function hasSushiAggregatorConfig(config: KeeperConfig): boolean {
  return Boolean(config.dex?.sushiAggregator);
}

export function getSushiAggregatorProductionAllowlists(
  config: KeeperConfig,
  chainId: number
): NormalizedSushiAggregatorChainPolicy {
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
}

export async function deploySushiAggregatorKeeperTaker(
  deployer: ethers.Wallet,
  ajnaPoolFactory: string,
  factoryAddress: string,
  chainId: number,
  getGasConfig: (chainId: number) => GasConfig
): Promise<string> {
  console.log('\n📦 Deploying SushiAggregatorKeeperTaker...');

  const takerArtifact = require(
    getArtifactPath(
      'contracts',
      'takers',
      'SushiAggregatorKeeperTaker.sol',
      'SushiAggregatorKeeperTaker.json'
    )
  );

  const SushiAggregatorKeeperTaker = new ethers.ContractFactory(
    takerArtifact.abi,
    takerArtifact.bytecode,
    deployer
  );

  const gasConfig = getGasConfig(chainId);
  const deployOptions: any = { gasLimit: gasConfig.gasLimit };
  if (gasConfig.gasPrice) {
    deployOptions.gasPrice = gasConfig.gasPrice;
  }

  const taker = await SushiAggregatorKeeperTaker.deploy(
    ajnaPoolFactory,
    factoryAddress,
    deployOptions
  );
  console.log('✅ Sushi aggregator taker deployment tx:', taker.deployTransaction.hash);
  await taker.deployed();
  console.log('🎉 SushiAggregatorKeeperTaker deployed to:', taker.address);

  return taker.address;
}

// Apply the reviewed dex.sushiAggregator allowlists to the deployed taker and
// EXACTLY reconcile on-chain state to the desired policy. Must run before
// registration so the router never enables a taker with incomplete allowlists.
export async function configureSushiAggregatorAllowlists(
  deployer: ethers.Wallet,
  takerAddress: string,
  config: KeeperConfig,
  chainId: number
): Promise<void> {
  console.log('\n⚙️  Configuring Sushi aggregator taker allowlists...');

  const desired = getSushiAggregatorProductionAllowlists(config, chainId);
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
    labelPrefix: SUSHI_AGGREGATOR_LABEL_PREFIX,
  });
  const plan = buildTakerAllowlistReconciliationPlan({ desired, current });

  for (const target of plan.callTargetsToEnable) {
    const tx = await taker.setCallTarget(target, true);
    console.log(`✅ Sushi call target ${target} tx:`, tx.hash);
    await tx.wait();
  }
  for (const spender of plan.approvalSpendersToEnable) {
    const tx = await taker.setApprovalSpender(spender, true);
    console.log(`✅ Sushi approval spender ${spender} tx:`, tx.hash);
    await tx.wait();
  }
  for (const { target, selector } of plan.selectorsToEnable) {
    const tx = await taker.setCallSelector(target, selector, true);
    console.log(`✅ Sushi selector ${selector} for ${target} tx:`, tx.hash);
    await tx.wait();
  }

  // Verify the enable phase landed before disabling any stale entries.
  assertTakerAllowlistPolicy({
    expected: desired,
    actual: await readTakerAllowlistSnapshot({
      reader,
      selectorTargets,
      labelPrefix: SUSHI_AGGREGATOR_LABEL_PREFIX,
    }),
    mode: 'contains',
  });

  for (const { target, selector } of plan.selectorsToDisable) {
    const tx = await taker.setCallSelector(target, selector, false);
    console.log(`Disabled stale Sushi selector ${selector} for ${target} tx:`, tx.hash);
    await tx.wait();
  }
  for (const target of plan.callTargetsToDisable) {
    const tx = await taker.setCallTarget(target, false);
    console.log(`Disabled stale Sushi call target ${target} tx:`, tx.hash);
    await tx.wait();
  }
  for (const spender of plan.approvalSpendersToDisable) {
    const tx = await taker.setApprovalSpender(spender, false);
    console.log(`Disabled stale Sushi approval spender ${spender} tx:`, tx.hash);
    await tx.wait();
  }

  // Exact match: on-chain allowlists must equal the reviewed policy.
  assertTakerAllowlistPolicy({
    expected: desired,
    actual: await readTakerAllowlistSnapshot({
      reader,
      selectorTargets: plan.selectorTargets,
      labelPrefix: SUSHI_AGGREGATOR_LABEL_PREFIX,
    }),
    mode: 'exact',
  });

  console.log(
    `🎉 Sushi aggregator allowlists configured: targets=${desired.callTargets.length}, spenders=${desired.approvalSpenders.length}, selectorTargets=${Object.keys(desired.selectorAllowlist).length}`
  );
}

// Register the Sushi aggregator taker in the router. Run only AFTER
// configureSushiAggregatorAllowlists succeeds, keeping router enablement strictly
// downstream of verified config/on-chain agreement.
export async function registerSushiAggregatorTakerInFactory(
  deployer: ethers.Wallet,
  factoryAddress: string,
  addresses: { sushiAggregatorTaker?: string }
): Promise<void> {
  if (!addresses.sushiAggregatorTaker) {
    return;
  }
  console.log('\n⚙️  Registering Sushi aggregator taker in router...');
  const factoryArtifact = require(
    getArtifactPath(
      'contracts',
      'factories',
      'TakerRouter.sol',
      'TakerRouter.json'
    )
  );
  const factory = new ethers.Contract(
    factoryAddress,
    factoryArtifact.abi,
    deployer
  );
  const tx = await factory.setTaker(
    LiquiditySource.SUSHI_AGGREGATOR,
    addresses.sushiAggregatorTaker
  );
  console.log('✅ Sushi aggregator registration tx:', tx.hash);
  await tx.wait();
  console.log('🎉 Router configured with Sushi aggregator taker');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
