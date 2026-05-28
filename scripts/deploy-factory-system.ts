import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import * as path from 'path';
import { password } from '@inquirer/prompts';
import {
  getManualPools,
  readConfigFile,
  KeeperConfig,
  LiquiditySource,
} from '../src/config';
import {
  normalizeLifiAddressAllowlist,
  normalizeLifiSelectorAllowlistRecord,
} from '../src/dex/lifi';

/**
 * Universal Factory System Deployment Script
 *
 * Deploys AjnaKeeperTakerFactory + DEX-specific takers for any chain
 * Usage: npx ts-node scripts/deploy-factory-system.ts <config-file-path>
 *
 * Features:
 * - Chain-agnostic (works on any chain with proper config)
 * - Config-driven (reads all addresses from config file)
 * - Fixed deployment order (factory → taker with factory authorization)
 * - Production LI.FI configs deploy and register LifiKeeperTaker, then apply reviewed allowlists
 * - Interactive password input (same as main bot)
 * - Comprehensive validation and error handling
 * - Manual gas limits for problematic networks
 */

interface DeploymentAddresses {
  factory?: string;
  uniswapTaker?: string;
  sushiTaker?: string;
  curveTaker?: string;
  lifiTaker?: string;
  // Future: uniswapV4, pancakeswap, balancer, izumi, etc.
}

interface LifiProductionAllowlists {
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
}

// Gas configuration for different networks
const GAS_CONFIGS: {
  [chainId: number]: { gasLimit: string; gasPrice?: string };
} = {
  43111: {
    // Hemi Mainnet - Reasonable settings for large contract deployment
    gasLimit: '6000000', // 6M gas limit (reasonable for Hemi)
    gasPrice: '100000000', // 0.1 gwei (much cheaper for Hemi)
  },
  43114: {
    // Avalanche
    gasLimit: '6000000',
    gasPrice: '10000000000', // 10 gwei
  },
  1: {
    // Ethereum Mainnet
    gasLimit: '6000000',
  },
  8453: {
    // Base
    gasLimit: '6000000',
    gasPrice: '1000000000', // 1 gwei
  },

  // Add more networks as needed
};

async function getKeystorePassword(): Promise<string> {
  // Same approach as main bot - just prompt directly
  const pswd = await password({
    message: 'Please enter your keystore password',
    mask: '*',
  });

  return pswd;
}

async function detectChainInfo(
  config: KeeperConfig
): Promise<{ chainId: number; name: string }> {
  const provider = new ethers.providers.JsonRpcProvider(config.network.rpcUrl);
  const network = await provider.getNetwork();

  // Map common chain IDs to human-readable names
  const chainNames: { [chainId: number]: string } = {
    1: 'Ethereum Mainnet',
    43114: 'Avalanche',
    8453: 'Base',
    42161: 'Arbitrum One',
    43111: 'Hemi Mainnet',
    // Add more as needed
  };

  return {
    chainId: network.chainId,
    name: chainNames[network.chainId] || `Chain ${network.chainId}`,
  };
}

function getGasConfig(chainId: number) {
  const config = GAS_CONFIGS[chainId];
  if (!config) {
    console.log(
      `⚠️  No gas config for chain ${chainId}, using default settings`
    );
    return { gasLimit: '5000000' }; // Default 5M gas
  }
  return config;
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
  if (!lifi || lifi.mode !== 'production') {
    throw new Error('LI.FI production config is required for deployment');
  }
  const callTargets = normalizeLifiAddressAllowlist(
    lifi.callTargetAllowlist?.[chainId],
    {
      label: `LI.FI callTargetAllowlist.${chainId}`,
      requireNonEmpty: true,
    }
  );
  const approvalSpenders = normalizeLifiAddressAllowlist(
    lifi.approvalSpenderAllowlist?.[chainId],
    {
      label: `LI.FI approvalSpenderAllowlist.${chainId}`,
      requireNonEmpty: true,
    }
  );
  const selectorAllowlist = normalizeLifiSelectorAllowlistRecord(
    lifi.selectorAllowlist?.[chainId],
    {
      label: `LI.FI selectorAllowlist.${chainId}`,
      requireNonEmpty: true,
      callTargetAllowlist: callTargets,
      requireCallTargetCoverage: true,
    }
  );
  return { callTargets, approvalSpenders, selectorAllowlist };
}

function hasProductionLifiConfig(config: KeeperConfig): boolean {
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

async function validateConfig(config: KeeperConfig): Promise<void> {
  console.log('Validating configuration...');

  // Check required Ajna addresses
  if (!config.ajna?.erc20PoolFactory) {
    throw new Error('Missing ajna.erc20PoolFactory in config');
  }

  // Check if contract artifacts exist
  const factoryArtifactPath = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    'factories',
    'AjnaKeeperTakerFactory.sol',
    'AjnaKeeperTakerFactory.json'
  );
  const takerArtifactPath = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    'takers',
    'UniswapV3KeeperTaker.sol',
    'UniswapV3KeeperTaker.json'
  );

  try {
    require(factoryArtifactPath);
    require(takerArtifactPath);
  } catch (error) {
    throw new Error('Contract artifacts not found. Please run: yarn compile');
  }

  if (hasProductionLifiConfig(config)) {
    const lifiArtifactPath = path.join(
      __dirname,
      '..',
      'artifacts',
      'contracts',
      'takers',
      'LifiKeeperTaker.sol',
      'LifiKeeperTaker.json'
    );
    try {
      require(lifiArtifactPath);
    } catch (error) {
      throw new Error(
        'LI.FI contract artifact not found. Please run: yarn compile'
      );
    }
  }

  // Check if any pools are configured for Uniswap V3 takes
  const uniswapPools = getManualPools(config).filter(
    (pool) => pool.take?.liquiditySource === 2 // LiquiditySource.UNISWAPV3
  );

  if (uniswapPools.length > 0) {
    console.log(
      `Found ${uniswapPools.length} pools configured for Uniswap V3 takes`
    );

    // Validate Uniswap V3 configuration
    const uniswapConfig = config.dex?.uniswapV3?.router;
    if (!uniswapConfig) {
      throw new Error('dex.uniswapV3.router required for Uniswap V3 pools');
    }

    const required = [
      'swapRouter02Address',
      'wethAddress',
      'poolFactoryAddress',
      'quoterV2Address',
    ];

    for (const field of required) {
      if (!uniswapConfig[field as keyof typeof uniswapConfig]) {
        throw new Error(`Missing dex.uniswapV3.router.${field} for Uniswap V3`);
      }
    }
  }

  const curvePools = getManualPools(config).filter(
    (pool) => pool.take?.liquiditySource === 4 // LiquiditySource.CURVE
  );

  if (curvePools.length > 0) {
    console.log(`Found ${curvePools.length} pools configured for Curve takes`);

    // Validate Curve configuration
    const curveConfig = config.dex?.curve;
    if (!curveConfig) {
      throw new Error('dex.curve required for Curve pools');
    }
    if (
      !curveConfig.poolConfigs ||
      Object.keys(curveConfig.poolConfigs).length === 0
    ) {
      throw new Error('Missing dex.curve.poolConfigs for Curve');
    }
    if (!curveConfig.wethAddress) {
      throw new Error('Missing dex.curve.wethAddress for Curve');
    }
  }

  console.log('Configuration validation passed');
}

function validateDetectedChainLifiProductionConfig(
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

async function deployFactory(
  deployer: ethers.Wallet,
  ajnaPoolFactory: string,
  chainId: number
): Promise<string> {
  console.log('\n📦 Step 1: Deploying AjnaKeeperTakerFactory...');

  const factoryArtifact = require(
    path.join(
      __dirname,
      '..',
      'artifacts',
      'contracts',
      'factories',
      'AjnaKeeperTakerFactory.sol',
      'AjnaKeeperTakerFactory.json'
    )
  );
  const AjnaKeeperTakerFactory = new ethers.ContractFactory(
    factoryArtifact.abi,
    factoryArtifact.bytecode,
    deployer
  );

  // Get gas configuration for this chain
  const gasConfig = getGasConfig(chainId);
  console.log(
    `⛽ Using gas config: limit=${gasConfig.gasLimit}${gasConfig.gasPrice ? `, price=${gasConfig.gasPrice}` : ''}`
  );

  // Prepare deployment options with manual gas settings
  const deployOptions: any = {
    gasLimit: gasConfig.gasLimit,
  };

  if (gasConfig.gasPrice) {
    deployOptions.gasPrice = gasConfig.gasPrice;
  }

  console.log('🚀 Deploying with manual gas settings...');

  try {
    const factory = await AjnaKeeperTakerFactory.deploy(
      ajnaPoolFactory,
      deployOptions
    );
    console.log('✅ Factory deployment tx:', factory.deployTransaction.hash);

    console.log('⏳ Waiting for deployment confirmation...');
    await factory.deployed();
    console.log('🎉 AjnaKeeperTakerFactory deployed to:', factory.address);

    return factory.address;
  } catch (error: any) {
    console.log('❌ Factory deployment failed with manual gas settings');

    // Try with higher gas limit as fallback
    if (error.message?.includes('gas')) {
      console.log('🔄 Retrying with higher gas limit...');
      const higherGasLimit = (parseInt(gasConfig.gasLimit) * 1.5).toString();

      const retryOptions = {
        ...deployOptions,
        gasLimit: higherGasLimit,
      };

      console.log(`⛽ Retry gas limit: ${higherGasLimit}`);

      const factory = await AjnaKeeperTakerFactory.deploy(
        ajnaPoolFactory,
        retryOptions
      );
      console.log(
        '✅ Factory deployment tx (retry):',
        factory.deployTransaction.hash
      );

      await factory.deployed();
      console.log('🎉 AjnaKeeperTakerFactory deployed to:', factory.address);

      return factory.address;
    }

    throw error;
  }
}

async function deployUniswapTaker(
  deployer: ethers.Wallet,
  ajnaPoolFactory: string,
  factoryAddress: string,
  chainId: number
): Promise<string> {
  console.log('\n📦 Step 2: Deploying UniswapV3KeeperTaker...');

  const takerArtifact = require(
    path.join(
      __dirname,
      '..',
      'artifacts',
      'contracts',
      'takers',
      'UniswapV3KeeperTaker.sol',
      'UniswapV3KeeperTaker.json'
    )
  );
  const UniswapV3KeeperTaker = new ethers.ContractFactory(
    takerArtifact.abi,
    takerArtifact.bytecode,
    deployer
  );

  // Get gas configuration
  const gasConfig = getGasConfig(chainId);
  const deployOptions: any = {
    gasLimit: gasConfig.gasLimit,
  };

  if (gasConfig.gasPrice) {
    deployOptions.gasPrice = gasConfig.gasPrice;
  }

  // Correct deployment order with factory authorization
  const taker = await UniswapV3KeeperTaker.deploy(
    ajnaPoolFactory, // Ajna pool factory
    factoryAddress, // Authorized factory (CRITICAL FIX)
    deployOptions
  );
  console.log(
    '✅ UniswapV3 taker deployment tx:',
    taker.deployTransaction.hash
  );

  await taker.deployed();
  console.log('🎉 UniswapV3KeeperTaker deployed to:', taker.address);

  return taker.address;
}

async function deploySushiSwapTaker(
  deployer: ethers.Wallet,
  ajnaPoolFactory: string,
  factoryAddress: string,
  chainId: number
): Promise<string> {
  console.log('\n📦 Step 2b: Deploying SushiSwapKeeperTaker...');

  const takerArtifactPath = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    'takers',
    'SushiSwapKeeperTaker.sol',
    'SushiSwapKeeperTaker.json'
  );
  const takerArtifact = require(takerArtifactPath);
  const SushiSwapKeeperTaker = new ethers.ContractFactory(
    takerArtifact.abi,
    takerArtifact.bytecode,
    deployer
  );

  // Get gas configuration
  const gasConfig = getGasConfig(chainId);
  const deployOptions: any = {
    gasLimit: gasConfig.gasLimit,
  };

  if (gasConfig.gasPrice) {
    deployOptions.gasPrice = gasConfig.gasPrice;
  }

  // Deploy with factory authorization
  const taker = await SushiSwapKeeperTaker.deploy(
    ajnaPoolFactory, // Ajna pool factory
    factoryAddress, // Authorized factory
    deployOptions
  );
  console.log(
    '✅ SushiSwap taker deployment tx:',
    taker.deployTransaction.hash
  );

  await taker.deployed();
  console.log('🎉 SushiSwapKeeperTaker deployed to:', taker.address);

  return taker.address;
}

async function deployCurveKeeperTaker(
  deployer: ethers.Wallet,
  ajnaPoolFactory: string,
  factoryAddress: string,
  chainId: number
): Promise<string> {
  console.log('\n📦 Step 2c: Deploying CurveKeeperTaker...');

  const takerArtifactPath = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    'takers',
    'CurveKeeperTaker.sol',
    'CurveKeeperTaker.json'
  );
  const takerArtifact = require(takerArtifactPath);

  const CurveKeeperTaker = new ethers.ContractFactory(
    takerArtifact.abi,
    takerArtifact.bytecode,
    deployer
  );

  // Get gas configuration
  const gasConfig = getGasConfig(chainId);
  const deployOptions: any = {
    gasLimit: gasConfig.gasLimit,
  };

  if (gasConfig.gasPrice) {
    deployOptions.gasPrice = gasConfig.gasPrice;
  }

  // Deploy with factory authorization
  const taker = await CurveKeeperTaker.deploy(
    ajnaPoolFactory, // Ajna pool factory
    factoryAddress, // Authorized factory
    deployOptions
  );

  console.log('✅ Curve taker deployment tx:', taker.deployTransaction.hash);
  await taker.deployed();
  console.log('🎉 CurveKeeperTaker deployed to:', taker.address);

  return taker.address;
}

async function deployLifiKeeperTaker(
  deployer: ethers.Wallet,
  ajnaPoolFactory: string,
  factoryAddress: string,
  chainId: number
): Promise<string> {
  console.log('\n📦 Step 2d: Deploying LifiKeeperTaker...');

  const takerArtifactPath = path.join(
    __dirname,
    '..',
    'artifacts',
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

async function configureFactory(
  deployer: ethers.Wallet,
  factoryAddress: string,
  addresses: DeploymentAddresses
): Promise<void> {
  console.log('\n⚙️  Step 3: Configuring factory with takers...');

  const factoryArtifact = require(
    path.join(
      __dirname,
      '..',
      'artifacts',
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

  // Register UniswapV3 taker (LiquiditySource.UNISWAPV3 = 2)
  if (addresses.uniswapTaker) {
    const setUniTakerTx = await factory.setTaker(2, addresses.uniswapTaker);
    console.log('✅ UniswapV3 configuration tx:', setUniTakerTx.hash);
    await setUniTakerTx.wait();
    console.log('🎉 Factory configured with UniswapV3 taker');
  }

  // Register SushiSwap taker (LiquiditySource.SUSHISWAP = 3)
  if (addresses.sushiTaker) {
    const setSushiTakerTx = await factory.setTaker(3, addresses.sushiTaker);
    console.log('✅ SushiSwap configuration tx:', setSushiTakerTx.hash);
    await setSushiTakerTx.wait();
    console.log('🎉 Factory configured with SushiSwap taker');
  }

  // Register Curve taker (LiquiditySource.CURVE = 4)
  if (addresses.curveTaker) {
    const setCurveTakerTx = await factory.setTaker(
      LiquiditySource.CURVE,
      addresses.curveTaker
    );
    console.log('✅ Curve configuration tx:', setCurveTakerTx.hash);
    await setCurveTakerTx.wait();
    console.log('🎉 Factory configured with Curve taker');
  }

  // Register LI.FI taker (LiquiditySource.LIFI = 5)
  if (addresses.lifiTaker) {
    const setLifiTakerTx = await factory.setTaker(
      LiquiditySource.LIFI,
      addresses.lifiTaker
    );
    console.log('✅ LI.FI configuration tx:', setLifiTakerTx.hash);
    await setLifiTakerTx.wait();
    console.log('🎉 Factory configured with LI.FI taker');
  }
  // ADD DELAY AFTER CONFIGURATION
  await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
}

async function configureLifiAllowlists(
  deployer: ethers.Wallet,
  takerAddress: string,
  config: KeeperConfig,
  chainId: number
): Promise<void> {
  if (!hasProductionLifiConfig(config)) {
    return;
  }

  console.log('\n⚙️  Step 3b: Configuring LI.FI taker allowlists...');

  const takerArtifactPath = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    'takers',
    'LifiKeeperTaker.sol',
    'LifiKeeperTaker.json'
  );
  const takerArtifact = require(takerArtifactPath);
  const taker = new ethers.Contract(takerAddress, takerArtifact.abi, deployer);

  const { callTargets, approvalSpenders, selectorAllowlist } =
    getLifiProductionAllowlists(config, chainId);
  const configuredCallTargets = toLowerSet(callTargets);
  const configuredApprovalSpenders = toLowerSet(approvalSpenders);
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
  const currentCallTargetSet = toLowerSet(currentCallTargets);
  const currentApprovalSpenderSet = toLowerSet(currentApprovalSpenders);

  for (const target of currentCallTargets) {
    if (!configuredCallTargets.has(target.toLowerCase())) {
      const tx = await taker.setCallTarget(target, false);
      console.log(`Disabled stale LI.FI call target ${target} tx:`, tx.hash);
      await tx.wait();
    }
  }

  for (const spender of currentApprovalSpenders) {
    if (!configuredApprovalSpenders.has(spender.toLowerCase())) {
      const tx = await taker.setApprovalSpender(spender, false);
      console.log(
        `Disabled stale LI.FI approval spender ${spender} tx:`,
        tx.hash
      );
      await tx.wait();
    }
  }

  const selectorTargets = new Map<string, string>();
  for (const target of [...currentCallTargets, ...callTargets]) {
    selectorTargets.set(target.toLowerCase(), target);
  }

  for (const target of Array.from(selectorTargets.values())) {
    const configuredSelectors = toLowerSet(
      selectorAllowlist[target.toLowerCase()] ?? []
    );
    const currentSelectors = normalizeLifiSelectorsForTarget(
      target,
      await taker.getAllowedCallSelectors(target),
      `on-chain LI.FI selector allowlist for ${target}`,
      false
    );

    for (const selector of currentSelectors) {
      if (!configuredSelectors.has(selector.toLowerCase())) {
        const tx = await taker.setCallSelector(target, selector, false);
        console.log(
          `Disabled stale LI.FI selector ${selector} for ${target} tx:`,
          tx.hash
        );
        await tx.wait();
      }
    }
  }

  for (const target of callTargets) {
    if (currentCallTargetSet.has(target.toLowerCase())) {
      continue;
    }
    const tx = await taker.setCallTarget(target, true);
    console.log(`✅ LI.FI call target ${target} tx:`, tx.hash);
    await tx.wait();
  }

  for (const spender of approvalSpenders) {
    if (currentApprovalSpenderSet.has(spender.toLowerCase())) {
      continue;
    }
    const tx = await taker.setApprovalSpender(spender, true);
    console.log(`✅ LI.FI approval spender ${spender} tx:`, tx.hash);
    await tx.wait();
  }

  for (const [target, selectors] of Object.entries(selectorAllowlist)) {
    const currentSelectors = toLowerSet(
      normalizeLifiSelectorsForTarget(
        target,
        await taker.getAllowedCallSelectors(target),
        `on-chain LI.FI selector allowlist for ${target}`,
        false
      )
    );
    for (const selector of selectors) {
      if (currentSelectors.has(selector.toLowerCase())) {
        continue;
      }
      const tx = await taker.setCallSelector(target, selector, true);
      console.log(`✅ LI.FI selector ${selector} for ${target} tx:`, tx.hash);
      await tx.wait();
    }
  }

  assertExactSet(
    'LI.FI call target allowlist',
    callTargets,
    normalizeLifiAddressAllowlist(await taker.getAllowedCallTargets(), {
      label: 'on-chain LI.FI call target allowlist',
    })
  );
  assertExactSet(
    'LI.FI approval spender allowlist',
    approvalSpenders,
    normalizeLifiAddressAllowlist(await taker.getAllowedApprovalSpenders(), {
      label: 'on-chain LI.FI approval spender allowlist',
    })
  );
  for (const target of callTargets) {
    assertExactSet(
      `LI.FI selector allowlist for ${target}`,
      selectorAllowlist[target.toLowerCase()] ?? [],
      normalizeLifiSelectorsForTarget(
        target,
        await taker.getAllowedCallSelectors(target),
        `on-chain LI.FI selector allowlist for ${target}`
      )
    );
  }

  console.log(
    `🎉 LI.FI allowlists configured: targets=${callTargets.length}, spenders=${approvalSpenders.length}, selectorTargets=${Object.keys(selectorAllowlist).length}`
  );
}

async function verifyDeployment(
  deployer: ethers.Wallet,
  addresses: DeploymentAddresses
): Promise<void> {
  console.log('\n🔍 Step 4: Verifying deployment...');

  if (!addresses.factory) {
    throw new Error('Factory address is missing from deployment');
  }

  const factoryArtifact = require(
    path.join(
      __dirname,
      '..',
      'artifacts',
      'contracts',
      'factories',
      'AjnaKeeperTakerFactory.sol',
      'AjnaKeeperTakerFactory.json'
    )
  );
  const factory = new ethers.Contract(
    addresses.factory,
    factoryArtifact.abi,
    deployer
  );

  // Verify factory configuration
  const hasUniswapTaker = await factory.hasConfiguredTaker(2);
  const registeredTaker = await factory.takerContracts(2);
  const factoryOwner = await factory.owner();

  console.log('📋 Verification Results:');
  console.log(`- Factory Owner: ${factoryOwner}`);
  console.log(`- Expected Owner: ${deployer.address}`);
  console.log(`- UniswapV3 Configured: ${hasUniswapTaker}`);
  console.log(`- Registered Taker: ${registeredTaker}`);
  console.log(`- Expected Taker: ${addresses.uniswapTaker}`);

  // Verify taker authorization
  if (addresses.uniswapTaker) {
    const takerArtifact = require(
      path.join(
        __dirname,
        '..',
        'artifacts',
        'contracts',
        'takers',
        'UniswapV3KeeperTaker.sol',
        'UniswapV3KeeperTaker.json'
      )
    );
    const taker = new ethers.Contract(
      addresses.uniswapTaker,
      takerArtifact.abi,
      deployer
    );

    const takerOwner = await taker.owner();
    const authorizedFactory = await taker.authorizedFactory();

    console.log(`- Taker Owner: ${takerOwner}`);
    console.log(`- Authorized Factory: ${authorizedFactory}`);
    console.log(`- Expected Factory: ${addresses.factory}`);

    // Validation checks
    if (!hasUniswapTaker || registeredTaker !== addresses.uniswapTaker) {
      throw new Error('❌ Factory configuration verification failed');
    }

    if (authorizedFactory !== addresses.factory) {
      throw new Error('❌ Taker authorization verification failed');
    }

    if (takerOwner !== deployer.address || factoryOwner !== deployer.address) {
      throw new Error('❌ Owner verification failed');
    }
  }

  if (addresses.lifiTaker) {
    const hasLifiTaker = await factory.hasConfiguredTaker(LiquiditySource.LIFI);
    const registeredLifiTaker = await factory.takerContracts(
      LiquiditySource.LIFI
    );
    console.log(`- LI.FI Configured: ${hasLifiTaker}`);
    console.log(`- Registered LI.FI Taker: ${registeredLifiTaker}`);
    console.log(`- Expected LI.FI Taker: ${addresses.lifiTaker}`);

    const takerArtifact = require(
      path.join(
        __dirname,
        '..',
        'artifacts',
        'contracts',
        'takers',
        'LifiKeeperTaker.sol',
        'LifiKeeperTaker.json'
      )
    );
    const taker = new ethers.Contract(
      addresses.lifiTaker,
      takerArtifact.abi,
      deployer
    );

    const takerOwner = await taker.owner();
    const authorizedFactory = await taker.authorizedFactory();

    console.log(`- LI.FI Taker Owner: ${takerOwner}`);
    console.log(`- LI.FI Authorized Factory: ${authorizedFactory}`);
    console.log(`- Expected Factory: ${addresses.factory}`);

    if (
      !hasLifiTaker ||
      registeredLifiTaker.toLowerCase() !== addresses.lifiTaker.toLowerCase()
    ) {
      throw new Error('❌ LI.FI factory configuration verification failed');
    }

    if (authorizedFactory.toLowerCase() !== addresses.factory.toLowerCase()) {
      throw new Error('❌ LI.FI taker authorization verification failed');
    }

    if (
      takerOwner.toLowerCase() !== deployer.address.toLowerCase() ||
      factoryOwner.toLowerCase() !== deployer.address.toLowerCase()
    ) {
      throw new Error('❌ LI.FI owner verification failed');
    }
  }

  console.log('✅ All verification checks passed');
}

function generateConfigUpdate(
  addresses: DeploymentAddresses,
  configPath: string,
  chainName: string
): void {
  console.log('\n🎉 DEPLOYMENT COMPLETE!');
  console.log('\n📝 Update your configuration file:');
  console.log(`📁 File: ${configPath}`);
  console.log('\n```typescript');
  console.log('// ADD/UPDATE these lines in your config:');

  if (
    addresses.factory ||
    addresses.uniswapTaker ||
    addresses.sushiTaker ||
    addresses.curveTaker ||
    addresses.lifiTaker
  ) {
    console.log('takers: {');
  }
  if (addresses.factory) {
    console.log(`  factory: '${addresses.factory}',`);
  }

  if (
    addresses.uniswapTaker ||
    addresses.sushiTaker ||
    addresses.curveTaker ||
    addresses.lifiTaker
  ) {
    console.log('  contracts: {');
    if (addresses.uniswapTaker) {
      console.log(`    UniswapV3: '${addresses.uniswapTaker}',`);
    }
    if (addresses.sushiTaker) {
      console.log(`    SushiSwap: '${addresses.sushiTaker}',`);
    }
    if (addresses.curveTaker) {
      console.log(`    Curve: '${addresses.curveTaker}',`);
    }
    if (addresses.lifiTaker) {
      console.log(`    Lifi: '${addresses.lifiTaker}',`);
    }
    console.log('  },');
  }
  if (
    addresses.factory ||
    addresses.uniswapTaker ||
    addresses.sushiTaker ||
    addresses.curveTaker ||
    addresses.lifiTaker
  ) {
    console.log('},');
  }
  console.log('```');

  console.log('\n📋 Deployed Contract Addresses:');
  if (addresses.factory) {
    console.log(`🏭 AjnaKeeperTakerFactory: ${addresses.factory}`);
  }
  if (addresses.uniswapTaker) {
    console.log(`🦄 UniswapV3KeeperTaker: ${addresses.uniswapTaker}`);
  }
  if (addresses.sushiTaker) {
    console.log(`🍣 SushiSwapKeeperTaker: ${addresses.sushiTaker}`);
  }
  if (addresses.curveTaker) {
    console.log(`🌊 CurveKeeperTaker: ${addresses.curveTaker}`);
  }
  if (addresses.lifiTaker) {
    console.log(`🔁 LifiKeeperTaker: ${addresses.lifiTaker}`);
  }

  console.log('\n🚀 Next Steps:');
  console.log('1. Update your config file with the addresses above');
  if (addresses.lifiTaker) {
    console.log(
      `2. Run the LI.FI route-shape gate: AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true npm run lifi-route-canary -- --config ${configPath}`
    );
    console.log(
      `3. Run the LI.FI callback-path fork gate: AJNA_AGENT_LIFI_FORK_CANARY_CONFIG=${configPath} npm run lifi-fork-execution-canary`
    );
    console.log(
      '4. For non-Base LI.FI production support, run an equivalent reviewed chain-specific fork canary before live use'
    );
    console.log(
      `5. After both LI.FI gates pass, test startup with: yarn start --config ${configPath}`
    );
  } else {
    console.log(`2. Test with: yarn start --config ${configPath}`);
    console.log('3. Expected result: "Type: factory, Valid: true"');
  }
  console.log(`Factory system deployment complete for ${chainName}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 1) {
    console.error(
      'Usage: npx ts-node scripts/deploy-factory-system.ts <config-file-path>'
    );
    console.error(
      'Example: npx ts-node scripts/deploy-factory-system.ts hemi-conf-settlement.ts'
    );
    console.error('\n Prerequisites:');
    console.error('1. Compile contracts: yarn compile');
    console.error('2. Have your keystore.json file ready');
    console.error('3. Ensure sufficient ETH balance (recommended: >0.01 ETH)');
    process.exit(1);
  }

  const configPath = args[0];

  try {
    console.log('🚀 Universal Factory System Deployment');
    console.log('=====================================');

    // Step 1: Load and validate configuration
    console.log(`📖 Loading configuration from: ${configPath}`);
    const config = await readConfigFile(configPath);
    await validateConfig(config);

    // Step 2: Detect chain information
    const chainInfo = await detectChainInfo(config);
    console.log(
      `🌐 Target Network: ${chainInfo.name} (Chain ID: ${chainInfo.chainId})`
    );
    validateDetectedChainLifiProductionConfig(config, chainInfo);

    // Step 3: Load wallet from keystore
    console.log('\n🔐 Loading wallet from keystore...');
    const keystoreJson = readFileSync(config.signer.keystore, 'utf8');
    const pswd = await getKeystorePassword();

    const wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, pswd);
    console.log('👤 Loaded wallet:', wallet.address);

    // Step 4: Connect to network
    const provider = new ethers.providers.JsonRpcProvider(
      config.network.rpcUrl
    );
    const deployer = wallet.connect(provider);

    const balance = await deployer.getBalance();
    console.log(
      '💰 Account balance:',
      ethers.utils.formatEther(balance),
      'ETH'
    );

    // Balance check for Hemi - much lower gas costs
    const minRequiredBalance = ethers.utils.parseEther('0.0005'); // 0.0005 ETH minimum for Hemi
    if (balance.lt(minRequiredBalance)) {
      console.warn('⚠️  WARNING: Low balance detected!');
      console.warn('💡 You may need more ETH for deployment');
    } else {
      console.log('✅ Balance sufficient for Hemi deployment');
    }

    // Step 5: Verify network matches
    const networkCheck = await provider.getNetwork();
    if (networkCheck.chainId !== chainInfo.chainId) {
      throw new Error(
        `Network mismatch! Config suggests ${chainInfo.chainId}, connected to ${networkCheck.chainId}`
      );
    }

    console.log('\n📋 Deployment Configuration:');
    console.log(`- Network: ${chainInfo.name} (${chainInfo.chainId})`);
    console.log(`- Ajna Pool Factory: ${config.ajna.erc20PoolFactory}`);
    console.log(`- Deployer: ${deployer.address}`);

    // Step 6: Execute deployment (CORRECT ORDER)
    const addresses: DeploymentAddresses = {};

    // Deploy factory FIRST
    addresses.factory = await deployFactory(
      deployer,
      config.ajna.erc20PoolFactory,
      chainInfo.chainId
    );

    // ADD DELAY AFTER FACTORY DEPLOYMENT
    await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay

    // Deploy Uniswap V3 taker if factory SwapRouter02 routing is configured
    if (config.dex?.uniswapV3?.router) {
      addresses.uniswapTaker = await deployUniswapTaker(
        deployer,
        config.ajna.erc20PoolFactory,
        addresses.factory, // Pass factory address for authorization
        chainInfo.chainId
      );
      // ADD DELAY AFTER UNISWAP DEPLOYMENT
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
    }

    // Deploy SushiSwap taker if configured
    if (config.dex?.sushiswap) {
      addresses.sushiTaker = await deploySushiSwapTaker(
        deployer,
        config.ajna.erc20PoolFactory,
        addresses.factory,
        chainInfo.chainId
      );
      // ADD DELAY AFTER UNISWAP DEPLOYMENT
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
    }

    // Deploy curve taker if configured
    if (config.dex?.curve) {
      addresses.curveTaker = await deployCurveKeeperTaker(
        deployer,
        config.ajna.erc20PoolFactory,
        addresses.factory,
        chainInfo.chainId
      );
      // ADD DELAY AFTER CURVE DEPLOYMENT
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
    }

    // Deploy LI.FI taker only for production configs. Canary configs are
    // for route-shape discovery and fork validation, not live registration.
    if (hasProductionLifiConfig(config)) {
      addresses.lifiTaker = await deployLifiKeeperTaker(
        deployer,
        config.ajna.erc20PoolFactory,
        addresses.factory,
        chainInfo.chainId
      );
      // ADD DELAY AFTER LI.FI DEPLOYMENT
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
    }
    // ADD DELAY BEFORE CONFIGURATION
    console.log('\n⏳ Waiting before configuration...');
    await new Promise((resolve) => setTimeout(resolve, 3000)); // 3 second delay

    // Step 7: Configure factory
    if (!addresses.factory) {
      throw new Error('Missing factory address for configuration');
    }
    await configureFactory(deployer, addresses.factory, addresses);
    if (addresses.lifiTaker) {
      await configureLifiAllowlists(
        deployer,
        addresses.lifiTaker,
        config,
        chainInfo.chainId
      );
    }

    // Step 8: Verify everything works
    await verifyDeployment(deployer, addresses);

    // Step 9: Generate configuration update instructions
    generateConfigUpdate(addresses, configPath, chainInfo.name);
  } catch (error: any) {
    console.error('\n💥 Deployment failed:', error.message);

    // Provide helpful troubleshooting tips
    if (error.message?.includes('insufficient funds')) {
      console.log('\n💡 Tip: Add more ETH to your wallet for deployment');
      console.log('💰 Recommended: 0.01+ ETH for large contract deployments');
    } else if (error.message?.includes('nonce')) {
      console.log('\n💡 Tip: Try again - might be a nonce issue');
      console.log('🔄 Or wait a few seconds and retry');
    } else if (error.message?.includes('gas')) {
      console.log('\n💡 Tip: Gas issues detected');
      console.log('⛽ The script now uses manual gas limits');
      console.log('💰 You may need more ETH for the deployment');
      console.log('🔄 Try adding more ETH and retrying');
    } else if (error.message?.includes('Contract artifacts not found')) {
      console.log('\n💡 Tip: Compile contracts first: yarn compile');
    } else if (error.message?.includes('Cannot find module')) {
      console.log('\n💡 Tip: Make sure contracts are compiled: yarn compile');
    } else if (error.message?.includes('incorrect password')) {
      console.log('\n💡 Tip: Check your keystore password and try again');
    }

    process.exit(1);
  }
}

// Handle script execution
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: any) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

export default main;
