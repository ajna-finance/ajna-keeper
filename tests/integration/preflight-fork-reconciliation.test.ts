// Key-free Base-fork validation of the keeper's STARTUP preflight reconciliation
// (src/discovery/route-preflight.ts: validateAutoDiscoverRouteDeployments ->
// validateLifiAllowlistPreflight). This is the production safety gate that
// reconciles the on-chain LI.FI taker allowlists (getAllowedCallTargets /
// getAllowedApprovalSpenders / getAllowedCallSelectors) against the reviewed
// config, and verifies factory registration + contract-code presence.
//
// It does ONLY on-chain reads (getCode + view calls) — it never calls li.quest
// or 1inch — so it needs NO API key and has no fork-vs-API drift. It uses the
// Base fork only so the real LI.FI diamond (0x1231DEB6…4EaE) call-target/spender
// addresses resolve to live bytecode. Env-gated; skips cleanly otherwise.
//
// Run: RUN_PREFLIGHT_FORK=true HARDHAT_CHAIN_ID=8453 FORK_NETWORK=base \
//      npx hardhat test tests/integration/preflight-fork-reconciliation.test.ts
// (ALCHEMY_API_KEY in .env resolves the Base fork RPC.)

import { expect } from 'chai';
import { Contract, Wallet, utils } from 'ethers';
import { network } from 'hardhat';
import { AjnaKeeperTakerFactory__factory } from '../../typechain-types';
import { LifiKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import { KeeperConfig, LifiDexConfig, readConfigFile } from '../../src/config';
import { validateAutoDiscoverRouteDeployments } from '../../src/discovery/route-preflight';
import { getProvider, resetHardhat, setBalance } from './test-utils';

const RUN_PREFLIGHT_FORK = process.env.RUN_PREFLIGHT_FORK === 'true';
const BASE_CHAIN_ID = 8453;
const BASE_ERC20_POOL_FACTORY = '0x214f62B5836D83f3D6c4f71F174209097B1A779C';
const HYBRID_CONFIG_PATH = 'examples/example-base-hybrid-fork-config.ts';

function requireConfiguredBaseForkRpc(): void {
  const forkUrl = (network.config as { forking?: { url?: unknown } }).forking
    ?.url;
  if (
    typeof forkUrl !== 'string' ||
    forkUrl.trim().length === 0 ||
    /\b(undefined|null)\b/i.test(forkUrl)
  ) {
    throw new Error(
      'Base fork RPC is required for RUN_PREFLIGHT_FORK=true; set AJNA_AGENT_RPC_URL, AJNA_RPC_URL_BASE, BASE_RPC_URL, or ALCHEMY_API_KEY'
    );
  }
}

async function deployFactoryAndLifiTaker(signer: Wallet) {
  const factory = await new AjnaKeeperTakerFactory__factory(signer).deploy(
    BASE_ERC20_POOL_FACTORY
  );
  await factory.deployed();
  const lifiTaker = await new LifiKeeperTaker__factory(signer).deploy(
    BASE_ERC20_POOL_FACTORY,
    factory.address
  );
  await lifiTaker.deployed();
  // LiquiditySource.Lifi = 5.
  await (await factory.setTaker(5, lifiTaker.address)).wait();
  return { factory, lifiTaker };
}

async function applyLifiAllowlists(
  lifiTaker: Contract,
  lifi: LifiDexConfig & { mode: 'production' }
): Promise<void> {
  for (const target of lifi.callTargetAllowlist[BASE_CHAIN_ID]) {
    await (await lifiTaker.setCallTarget(target, true)).wait();
  }
  for (const spender of lifi.approvalSpenderAllowlist[BASE_CHAIN_ID]) {
    await (await lifiTaker.setApprovalSpender(spender, true)).wait();
  }
  for (const [target, selectors] of Object.entries(
    lifi.selectorAllowlist[BASE_CHAIN_ID]
  )) {
    for (const selector of selectors) {
      await (await lifiTaker.setCallSelector(target, selector, true)).wait();
    }
  }
}

describe('Startup preflight reconciliation on a Base fork (LI.FI)', function () {
  this.timeout(300_000);

  let baseConfig: KeeperConfig;
  let lifi: LifiDexConfig & { mode: 'production' };

  before(async function () {
    if (!RUN_PREFLIGHT_FORK) {
      this.skip();
    }
    if (network.name !== 'hardhat') {
      throw new Error('preflight fork test must run on the hardhat network');
    }
    if ((process.env.FORK_NETWORK ?? 'mainnet') !== 'base') {
      throw new Error('preflight fork test requires FORK_NETWORK=base');
    }
    if (Number(process.env.HARDHAT_CHAIN_ID ?? '31337') !== BASE_CHAIN_ID) {
      throw new Error('preflight fork test requires HARDHAT_CHAIN_ID=8453');
    }
    requireConfiguredBaseForkRpc();
    baseConfig = await readConfigFile(HYBRID_CONFIG_PATH);
    if (baseConfig.dex?.lifi?.mode !== 'production') {
      throw new Error(
        'preflight fork test requires production dex.lifi config'
      );
    }
    lifi = baseConfig.dex.lifi as LifiDexConfig & { mode: 'production' };
  });

  beforeEach(async () => {
    await resetHardhat();
  });

  // Build a config whose takers point at freshly deployed contracts and whose
  // discovery enables only the LI.FI external-take path (so the preflight only
  // exercises the LI.FI + factory-registration branches, no oneinch/uniswap).
  function configForDeployment(
    factoryAddress: string,
    lifiTakerAddress: string
  ): KeeperConfig {
    return {
      ...baseConfig,
      takers: {
        ...baseConfig.takers,
        factory: factoryAddress,
        contracts: { ...baseConfig.takers?.contracts, Lifi: lifiTakerAddress },
      },
      discovery: {
        ...baseConfig.discovery,
        enabled: true,
        // LI.FI-only path so the preflight exercises just the LI.FI +
        // factory-registration branches (no oneinch/uniswap deployments needed).
        take: {
          enabled: true,
          allowedExternalTakePaths: ['lifi'],
          validateRouteDeployments: true,
          dexGasOverrides: { 5: '900000' },
        },
      },
    } as KeeperConfig;
  }

  it('passes when on-chain LI.FI allowlists exactly match the reviewed config', async () => {
    const provider = getProvider();
    const signer = Wallet.createRandom().connect(provider);
    await setBalance(signer.address, utils.parseEther('100').toHexString());

    const { factory, lifiTaker } = await deployFactoryAndLifiTaker(signer);
    await applyLifiAllowlists(
      new Contract(lifiTaker.address, LifiKeeperTaker__factory.abi, signer),
      lifi
    );

    // Reconciles factory registration + contract code + on-chain==config
    // allowlists (call targets, approval spenders, per-target selectors).
    await validateAutoDiscoverRouteDeployments({
      config: configForDeployment(factory.address, lifiTaker.address),
      provider,
      chainId: BASE_CHAIN_ID,
    });
  });

  it('throws when the on-chain selector allowlist diverges from config (extra selector)', async () => {
    const provider = getProvider();
    const signer = Wallet.createRandom().connect(provider);
    await setBalance(signer.address, utils.parseEther('100').toHexString());

    const { factory, lifiTaker } = await deployFactoryAndLifiTaker(signer);
    const takerContract = new Contract(
      lifiTaker.address,
      LifiKeeperTaker__factory.abi,
      signer
    );
    await applyLifiAllowlists(takerContract, lifi);
    // Add an on-chain selector that is NOT in the reviewed config.
    const target = lifi.callTargetAllowlist[BASE_CHAIN_ID][0];
    await (
      await takerContract.setCallSelector(target, '0xdeadbeef', true)
    ).wait();

    let caught: unknown;
    try {
      await validateAutoDiscoverRouteDeployments({
        config: configForDeployment(factory.address, lifiTaker.address),
        provider,
        chainId: BASE_CHAIN_ID,
      });
    } catch (error) {
      caught = error;
    }
    expect(
      caught,
      'expected preflight to reject the allowlist mismatch'
    ).to.be.instanceOf(Error);
    expect((caught as Error).message).to.match(/selector allowlist|mismatch/i);
  });

  it('throws when the factory registry does not map LIFI to the configured taker', async () => {
    const provider = getProvider();
    const signer = Wallet.createRandom().connect(provider);
    await setBalance(signer.address, utils.parseEther('100').toHexString());

    const { factory, lifiTaker } = await deployFactoryAndLifiTaker(signer);
    await applyLifiAllowlists(
      new Contract(lifiTaker.address, LifiKeeperTaker__factory.abi, signer),
      lifi
    );
    // Deploy a second taker and point the config at it, leaving the factory
    // registered to the first — a registration drift the preflight must catch.
    const otherTaker = await new LifiKeeperTaker__factory(signer).deploy(
      BASE_ERC20_POOL_FACTORY,
      factory.address
    );
    await otherTaker.deployed();
    await applyLifiAllowlists(
      new Contract(otherTaker.address, LifiKeeperTaker__factory.abi, signer),
      lifi
    );

    let caught: unknown;
    try {
      await validateAutoDiscoverRouteDeployments({
        config: configForDeployment(factory.address, otherTaker.address),
        provider,
        chainId: BASE_CHAIN_ID,
      });
    } catch (error) {
      caught = error;
    }
    expect(
      caught,
      'expected preflight to reject the registry drift'
    ).to.be.instanceOf(Error);
    expect((caught as Error).message).to.match(/registry|expected/i);
  });
});
