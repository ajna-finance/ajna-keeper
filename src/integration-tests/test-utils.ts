import { HARDHAT_RPC_URL, MAINNET_CONFIG } from './test-config';
import { delay } from '../utils';
import { JsonRpcProvider } from '../provider';
import { NonceTracker } from '../nonce';

export const getProvider = () => new JsonRpcProvider(HARDHAT_RPC_URL);

const TEST_RPC_SYNC_RETRIES = 20;
const TEST_RPC_SYNC_DELAY_MS = 50;
const TEST_RPC_RESET_RETRIES = 4;

async function waitForBlockReset(
  provider: JsonRpcProvider,
  expectedBlockNumber: number
) {
  for (let attempt = 0; attempt < TEST_RPC_SYNC_RETRIES; attempt++) {
    if ((await provider.getBlockNumber()) === expectedBlockNumber) {
      return;
    }
    await delay(TEST_RPC_SYNC_DELAY_MS);
  }

  throw new Error(
    `hardhat_reset did not settle at block ${expectedBlockNumber}`
  );
}

async function waitForBalance(
  provider: JsonRpcProvider,
  address: string,
  expectedBalance: bigint
) {
  for (let attempt = 0; attempt < TEST_RPC_SYNC_RETRIES; attempt++) {
    const balanceHex = await provider.send('eth_getBalance', [address, 'latest']);
    if (BigInt(balanceHex) >= expectedBalance) {
      return;
    }
    await delay(TEST_RPC_SYNC_DELAY_MS);
  }

  throw new Error(`hardhat_setBalance did not settle for ${address}`);
}

export const resetHardhat = async () => {
  let lastError: unknown;

  for (let attempt = 0; attempt < TEST_RPC_RESET_RETRIES; attempt++) {
    const provider = getProvider();

    try {
      await provider.send('hardhat_reset', [
        {
          forking: {
            jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
            blockNumber: MAINNET_CONFIG.BLOCK_NUMBER,
          },
        },
      ]);
      await waitForBlockReset(provider, MAINNET_CONFIG.BLOCK_NUMBER);
      NonceTracker.clearNonces();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === TEST_RPC_RESET_RETRIES - 1) {
        break;
      }
      await delay(TEST_RPC_SYNC_DELAY_MS * (attempt + 1) * 5);
    }
  }

  throw lastError;
};

export const setBalance = async (address: string, balance: string) => {
  const provider = getProvider();
  await provider.send('hardhat_setBalance', [address, balance]);
  await waitForBalance(provider, address, BigInt(balance));
};

export const getBalance = (address: string) =>
  getProvider().send('eth_getBalance', [address, 'latest']);

export const impersonateAccount = (address: string) =>
  getProvider().send('hardhat_impersonateAccount', [address]);

export const impersonateSigner = async (address: string) => {
  await impersonateAccount(address);
  const provider = getProvider();
  return provider.getSigner(address);
};

export const mine = () => getProvider().send('evm_mine', []);

export const latestBlockTimestamp = async () => {
  const latestBlock = await getProvider().send('eth_getBlockByNumber', [
    'latest',
    false,
  ]);
  return parseInt(latestBlock.timestamp, 16);
};

export const increaseTime = async (seconds: number) => {
  const provider = getProvider();
  const currTimestamp = await latestBlockTimestamp();
  const nextTimestamp = (currTimestamp + seconds).toString();
  await provider.send('evm_setNextBlockTimestamp', [nextTimestamp]);
  await provider.send('evm_mine', []);
  return await latestBlockTimestamp();
};
