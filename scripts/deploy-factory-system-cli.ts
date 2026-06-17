import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import * as path from 'path';
import { password } from '@inquirer/prompts';
import { getManualPools, readConfigFile, KeeperConfig } from '../src/config';
import {
  getLifiProductionDeploymentGateMessages,
  hasProductionLifiConfig,
  validateDetectedChainLifiProductionConfig,
} from './deployment/lifi-factory-deployment';
import { hasOneInchAggregatorAllowlistPolicy } from '../src/config/oneinch-aggregator-policy';
import {
  DEPLOY_DESCRIPTORS,
  deployTaker,
  reconcileTakerAllowlists,
  registerTakerInRouter,
  verifyTakerRegistration,
  type AggregatorDeployDescriptor,
  type DeploymentAddressKey,
} from './deployment/deploy-registry';

/**
 * Universal Factory System Deployment Script
 *
 * Deploys TakerRouter + DEX-specific takers for any chain
 * Usage: npx ts-node scripts/deploy-factory-system.ts <config-file-path>
 *
 * Features:
 * - Chain-agnostic (works on any chain with proper config)
 * - Config-driven (reads all addresses from config file)
 * - Fixed deployment order (factory → taker with factory authorization)
 * - Production LI.FI configs deploy LifiKeeperTaker, apply reviewed allowlists, then register the verified taker
 * - Interactive password input (same as main bot)
 * - Comprehensive validation and error handling
 * - Manual gas limits for problematic networks
 */

// Derived from the deploy registry's DeploymentAddressKey union so the two
// cannot drift: adding a taker to the registry automatically widens this.
export type DeploymentAddresses = { factory?: string } & Partial<
  Record<DeploymentAddressKey, string>
>;

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

export async function validateConfig(config: KeeperConfig): Promise<void> {
  console.log('Validating configuration...');

  // Check required Ajna addresses
  if (!config.ajna?.erc20PoolFactory) {
    throw new Error('Missing ajna.erc20PoolFactory in config');
  }

  // 1inch is provisioned by the deploy loop only when dex.oneInch carries a
  // production allowlist policy (callTargetAllowlist/approvalSpenderAllowlist/
  // selectorAllowlist), which the loop reconciles + verifies on-chain like
  // LI.FI/Sushi. A dex.oneInch present WITHOUT that policy is quote/discovery-
  // only: fail BEFORE any deployment rather than silently leaving
  // LiquiditySource.ONEINCH mapped to no taker (a runtime TakerNotSet gap).
  if (config.dex?.oneInch && !hasOneInchAggregatorAllowlistPolicy(config.dex.oneInch)) {
    throw new Error(
      'dex.oneInch is configured without an aggregator allowlist policy. Add ' +
        'callTargetAllowlist/approvalSpenderAllowlist/selectorAllowlist to ' +
        'provision the OneInchAggregatorKeeperTaker (it is deployed, allowlist-' +
        'reconciled, and registered automatically), or remove dex.oneInch to ' +
        'deploy the rest of the system.'
    );
  }

  // Check if contract artifacts exist
  const factoryArtifactPath = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    'factories',
    'TakerRouter.sol',
    'TakerRouter.json'
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

async function deployFactory(
  deployer: ethers.Wallet,
  ajnaPoolFactory: string,
  chainId: number
): Promise<string> {
  console.log('\n📦 Step 1: Deploying TakerRouter...');

  const factoryArtifact = require(
    path.join(
      __dirname,
      '..',
      'artifacts',
      'contracts',
      'factories',
      'TakerRouter.sol',
      'TakerRouter.json'
    )
  );
  const TakerRouter = new ethers.ContractFactory(
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
    const factory = await TakerRouter.deploy(
      ajnaPoolFactory,
      deployOptions
    );
    console.log('✅ Factory deployment tx:', factory.deployTransaction.hash);

    console.log('⏳ Waiting for deployment confirmation...');
    await factory.deployed();
    console.log('🎉 TakerRouter deployed to:', factory.address);

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

      const factory = await TakerRouter.deploy(
        ajnaPoolFactory,
        retryOptions
      );
      console.log(
        '✅ Factory deployment tx (retry):',
        factory.deployTransaction.hash
      );

      await factory.deployed();
      console.log('🎉 TakerRouter deployed to:', factory.address);

      return factory.address;
    }

    throw error;
  }
}

export async function configureFactory(
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
      'TakerRouter.sol',
      'TakerRouter.json'
    )
  );
  const factory = new ethers.Contract(
    factoryAddress,
    factoryArtifact.abi,
    deployer
  );

  // Register the direct-DEX takers by iterating their descriptors — no magic
  // source ids, no hand-unrolled per-DEX branch. Each registers at its
  // canonical descriptor.source (UNISWAPV3=2, CURVE=4) with no allowlist step.
  for (const descriptor of DEPLOY_DESCRIPTORS) {
    if (descriptor.category !== 'direct_dex') {
      continue;
    }
    const takerAddress = addresses[descriptor.addressKey];
    if (!takerAddress) {
      continue;
    }
    const setTakerTx = await factory.setTaker(descriptor.source, takerAddress);
    console.log(`✅ ${descriptor.label} configuration tx:`, setTakerTx.hash);
    await setTakerTx.wait();
    console.log(`🎉 Factory configured with ${descriptor.label} taker`);
  }

  // Aggregator taker registration is intentionally NOT done here. The deploy
  // loop registers each aggregator taker only AFTER reconcileTakerAllowlists has
  // applied and exactly verified its call-target/approval-spender/selector
  // allowlists, so the router never maps an aggregator source to a taker whose
  // on-chain allowlists are incomplete or unverified.
  // ADD DELAY AFTER CONFIGURATION
  await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
}

export async function verifyDeployment(
  deployer: ethers.Wallet,
  addresses: DeploymentAddresses
): Promise<void> {
  console.log('\n🔍 Step 4: Verifying deployment...');

  if (!addresses.factory) {
    throw new Error('Factory address is missing from deployment');
  }

  // Verify every deployed taker through the shared registry check: router
  // configuration (hasConfiguredTaker + registered address), taker -> router
  // authorization, and owner. This gives Sushi (the B-S1 gap) and Curve the
  // same post-registration verification LI.FI and Uniswap already had, instead
  // of the former hand-unrolled Uniswap+LI.FI-only branches.
  for (const descriptor of DEPLOY_DESCRIPTORS) {
    const takerAddress = addresses[descriptor.addressKey];
    if (!takerAddress) {
      continue;
    }
    await verifyTakerRegistration({
      descriptor,
      deployer,
      factoryAddress: addresses.factory,
      takerAddress,
    });
  }

  console.log('✅ All verification checks passed');
}

export function generateConfigUpdate(
  addresses: DeploymentAddresses,
  configPath: string,
  chainName: string
): void {
  console.log('\n🎉 DEPLOYMENT COMPLETE!');
  console.log('\n📝 Update your configuration file:');
  console.log(`📁 File: ${configPath}`);
  console.log('\n```typescript');
  console.log('// ADD/UPDATE these lines in your config:');

  // Emit the takers: { ... } wrapper whenever ANY taker (or the router) is
  // present, including Sushi/1inch — a Sushi-only or 1inch-only deploy must not
  // print the contracts block without its enclosing takers: { }.
  const hasTakerConfigBlock = Boolean(
    addresses.factory ||
      addresses.uniswapTaker ||
      addresses.curveTaker ||
      addresses.lifiTaker ||
      addresses.sushiAggregatorTaker ||
      addresses.oneInchAggregatorTaker
  );
  if (hasTakerConfigBlock) {
    console.log('takers: {');
  }
  if (addresses.factory) {
    // The deployed TakerRouter address; the runtime config field is takers.router
    // (keeperTakerRouter is sourced from config.takers.router, not .factory).
    console.log(`  router: '${addresses.factory}',`);
  }

  if (
    addresses.uniswapTaker ||
    addresses.curveTaker ||
    addresses.lifiTaker ||
    addresses.sushiAggregatorTaker ||
    addresses.oneInchAggregatorTaker
  ) {
    console.log('  contracts: {');
    if (addresses.uniswapTaker) {
      console.log(`    UniswapV3: '${addresses.uniswapTaker}',`);
    }
    if (addresses.curveTaker) {
      console.log(`    Curve: '${addresses.curveTaker}',`);
    }
    if (addresses.lifiTaker) {
      console.log(`    Lifi: '${addresses.lifiTaker}',`);
    }
    if (addresses.sushiAggregatorTaker) {
      console.log(`    SushiAggregator: '${addresses.sushiAggregatorTaker}',`);
    }
    if (addresses.oneInchAggregatorTaker) {
      console.log(
        `    OneInchAggregator: '${addresses.oneInchAggregatorTaker}',`
      );
    }
    console.log('  },');
  }
  if (hasTakerConfigBlock) {
    console.log('},');
  }
  console.log('```');

  console.log('\n📋 Deployed Contract Addresses:');
  if (addresses.factory) {
    console.log(`🏭 TakerRouter: ${addresses.factory}`);
  }
  if (addresses.uniswapTaker) {
    console.log(`🦄 UniswapV3KeeperTaker: ${addresses.uniswapTaker}`);
  }
  if (addresses.curveTaker) {
    console.log(`🌊 CurveKeeperTaker: ${addresses.curveTaker}`);
  }
  if (addresses.lifiTaker) {
    console.log(`🔁 LifiKeeperTaker: ${addresses.lifiTaker}`);
  }
  if (addresses.sushiAggregatorTaker) {
    console.log(
      `🍣 SushiAggregatorKeeperTaker: ${addresses.sushiAggregatorTaker}`
    );
  }
  if (addresses.oneInchAggregatorTaker) {
    console.log(
      `🟦 OneInchAggregatorKeeperTaker: ${addresses.oneInchAggregatorTaker}`
    );
  }

  console.log('\n🚀 Next Steps:');
  console.log('1. Update your config file with the addresses above');
  if (addresses.lifiTaker) {
    const gateMessages = getLifiProductionDeploymentGateMessages(configPath);
    for (let index = 0; index < gateMessages.length; index++) {
      const message = gateMessages[index];
      console.log(`${index + 2}. ${message}`);
    }
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

    // Descriptor-driven deploy loop (plan M-A): deploy every configured taker
    // in the canonical registry order, storing each at its address key. The
    // per-provider gating (uniswap router present, curve config present, LI.FI
    // production-only, sushi config present) lives in each descriptor's
    // isConfigured predicate.
    const deployContext = {
      deployer,
      ajnaPoolFactory: config.ajna.erc20PoolFactory,
      factoryAddress: addresses.factory,
      chainId: chainInfo.chainId,
      getGasConfig,
    };
    for (const descriptor of DEPLOY_DESCRIPTORS) {
      if (!descriptor.isConfigured(config)) {
        continue;
      }
      addresses[descriptor.addressKey] = await deployTaker(
        descriptor,
        deployContext
      );
      // ADD DELAY AFTER TAKER DEPLOYMENT
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
    }

    // ADD DELAY BEFORE CONFIGURATION
    console.log('\n⏳ Waiting before configuration...');
    await new Promise((resolve) => setTimeout(resolve, 3000)); // 3 second delay

    // Step 7: Configure factory. Direct-DEX takers register together (no
    // allowlists). Each aggregator taker then has its reviewed allowlists
    // reconciled + exactly verified BEFORE it is registered, so the router never
    // maps a source to a taker whose on-chain allowlists are incomplete or
    // unverified — the same ordering invariant the per-provider register*
    // helpers enforced, now driven by the descriptor loop.
    if (!addresses.factory) {
      throw new Error('Missing factory address for configuration');
    }
    await configureFactory(deployer, addresses.factory, addresses);
    for (const descriptor of DEPLOY_DESCRIPTORS) {
      if (descriptor.category !== 'aggregator') {
        continue;
      }
      const aggregator: AggregatorDeployDescriptor = descriptor;
      const takerAddress = addresses[aggregator.addressKey];
      if (!takerAddress) {
        continue;
      }
      const desired = aggregator.normalizeChainPolicy(config, chainInfo.chainId);
      if (desired) {
        await reconcileTakerAllowlists({
          deployer,
          takerAddress,
          desired,
          labelPrefix: aggregator.allowlistLabelPrefix,
        });
      }
      await registerTakerInRouter({
        descriptor: aggregator,
        deployer,
        factoryAddress: addresses.factory,
        takerAddress,
      });
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
