import dotenv from 'dotenv';
import { HardhatUserConfig } from 'hardhat/config';
import '@typechain/hardhat';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-verify';

dotenv.config();

function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function alchemyRpcUrl(network: string): string {
  return `https://${network}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
}

function baseRpcUrl(): string {
  return (
    optionalEnv('AJNA_AGENT_RPC_URL', 'AJNA_RPC_URL_BASE', 'BASE_RPC_URL') ??
    alchemyRpcUrl('base-mainnet')
  );
}

function forkBlockNumber(
  envName: string,
  fallback?: number
): number | undefined {
  const rawValue = process.env[envName];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return fallback;
  }
  if (rawValue.trim().toLowerCase() === 'latest') {
    return undefined;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${envName} must be a positive integer or "latest"`);
  }
  return value;
}

const forkConfigs: Record<string, { url: string; blockNumber?: number }> = {
  mainnet: {
    url: alchemyRpcUrl('eth-mainnet'),
    blockNumber: 21731352,
  },
  base: {
    url: baseRpcUrl(),
    blockNumber: forkBlockNumber('BASE_FORK_BLOCK', 30000000),
  },
  avalanche: {
    url: alchemyRpcUrl('avax-mainnet'),
  },
};

const forkNetwork = process.env.FORK_NETWORK || 'mainnet';
const forkConfig = forkConfigs[forkNetwork];
if (!forkConfig) {
  throw new Error(
    `Unknown FORK_NETWORK: "${forkNetwork}". Valid: ${Object.keys(forkConfigs).join(', ')}`
  );
}

const config: HardhatUserConfig = {
  // Integration tests are deterministic local-network tests, but hardhat's
  // default 40s mocha timeout flakes on the slower LI.FI fixtures when the
  // machine is under load (each test deploys a full factory/taker stack).
  mocha: {
    timeout: 120000,
  },
  //solidity: '0.8.28',
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      metadata: {
        bytecodeHash: 'none', // Helps with verification
      },
    },
  },
  paths: {
    tests: './tests/integration',
  },
  networks: {
    hardhat: {
      chainId: Number(process.env.HARDHAT_CHAIN_ID ?? 31337),
      forking: {
        url: forkConfig.url,
        ...(forkConfig.blockNumber
          ? { blockNumber: forkConfig.blockNumber }
          : {}),
      },
      chains: {
        8453: {
          hardforkHistory: {
            shanghai: 0,
          },
        },
      },
    },
    avalanche: {
      chainId: 43114,
      url: alchemyRpcUrl('avax-mainnet'),
    },
    base: {
      chainId: 8453,
      url: baseRpcUrl(),
    },
    hemi: {
      url: `https://boldest-soft-moon.hemi-mainnet.quiknode.pro/${process.env.QUICKNODE_API_KEY}`,
      chainId: 43111, // Hemi mainnet chain ID
      accounts: {
        mnemonic: process.env.MNEMONIC || 'your mnemonic here',
      },
      gasPrice: 1000000000, // 1 gwei
      gas: 8000000, // 8M gas limit
    },
  },
  sourcify: { enabled: true },
  //etherscan: { apiKey: process.env.ETHERSCAN_API_KEY },
  etherscan: {
    apiKey: {
      avalanche: 'verifyContract', // Snowtrace uses this generic key
      snowtrace: 'verifyContract', // Alternative name
    },
    customChains: [
      {
        network: 'avalanche',
        chainId: 43114,
        urls: {
          apiURL:
            'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api',
          browserURL: 'https://snowtrace.io',
        },
      },
    ],
  },
};

export default config;
