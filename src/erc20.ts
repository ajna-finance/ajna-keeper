import { Signer, SignerOrProvider } from '@ajna-finance/sdk';
import { BigNumber, Contract, ethers, providers } from 'ethers';
import Erc20Abi from './abis/erc20.abi.json';
import { NonceTracker } from './nonce';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import { logger } from './logging';

// Process-wide decimals cache. Include chainId when available so multi-chain
// keepers do not reuse same-address token metadata across networks.
const MAX_CACHED_DECIMAL_ENTRIES = 4096;
const cachedDecimals: Map<string, number> = new Map();
const pendingDecimals: Map<string, Promise<number>> = new Map();
let pendingChainIds: WeakMap<
  object,
  Promise<number | undefined>
> = new WeakMap();

function normalizeTokenAddress(tokenAddress: string): string {
  return tokenAddress.toLowerCase();
}

async function resolveChainIdUncached(
  signerOrProvider: SignerOrProvider
): Promise<number | undefined> {
  const candidate = signerOrProvider as SignerOrProvider & {
    getChainId?: () => Promise<number>;
    provider?: providers.Provider;
    network?: { chainId?: number };
    _network?: { chainId?: number };
    getNetwork?: () => Promise<{ chainId: number }>;
  };

  try {
    if (typeof candidate.getChainId === 'function') {
      return await candidate.getChainId();
    }
    const provider = (candidate.provider ?? candidate) as {
      network?: { chainId?: number };
      _network?: { chainId?: number };
      getNetwork?: () => Promise<{ chainId: number }>;
    };
    const cachedNetwork = provider.network ?? provider._network;
    if (typeof cachedNetwork?.chainId === 'number') {
      return cachedNetwork.chainId;
    }
    if (typeof provider.getNetwork === 'function') {
      return (await provider.getNetwork()).chainId;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function resolveChainId(
  signerOrProvider: SignerOrProvider,
  chainId?: number
): Promise<number | undefined> {
  if (chainId !== undefined) {
    return chainId;
  }
  if (typeof signerOrProvider !== 'object' || signerOrProvider === null) {
    return undefined;
  }
  const chainIdCache = pendingChainIds;
  const cached = chainIdCache.get(signerOrProvider);
  if (cached) {
    return await cached;
  }
  const pending = resolveChainIdUncached(signerOrProvider).then(
    (resolvedChainId) => {
      if (resolvedChainId === undefined) {
        chainIdCache.delete(signerOrProvider);
      }
      return resolvedChainId;
    }
  );
  chainIdCache.set(signerOrProvider, pending);
  return await pending;
}

function getDecimalsCacheKey(params: {
  chainId?: number;
  tokenAddress: string;
}): string {
  return `${params.chainId ?? 'unknown'}:${normalizeTokenAddress(
    params.tokenAddress
  )}`;
}

function pruneCachedDecimals(): void {
  while (cachedDecimals.size > MAX_CACHED_DECIMAL_ENTRIES) {
    const oldestKey = cachedDecimals.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    cachedDecimals.delete(oldestKey);
  }
}

export function clearErc20DecimalCache(): void {
  cachedDecimals.clear();
  pendingDecimals.clear();
  pendingChainIds = new WeakMap();
}

export async function getDecimalsErc20(
  signer: SignerOrProvider,
  tokenAddress: string,
  chainId?: number
) {
  const resolvedChainId = await resolveChainId(signer, chainId);
  const cacheKey = getDecimalsCacheKey({
    chainId: resolvedChainId,
    tokenAddress,
  });
  if (cachedDecimals.has(cacheKey)) {
    return cachedDecimals.get(cacheKey)!;
  }

  if (!pendingDecimals.has(cacheKey)) {
    const pending = _getDecimalsErc20(signer, tokenAddress)
      .then((decimals) => {
        cachedDecimals.set(cacheKey, decimals);
        pruneCachedDecimals();
        pendingDecimals.delete(cacheKey);
        return decimals;
      })
      .catch((error) => {
        pendingDecimals.delete(cacheKey);
        throw error;
      });
    pendingDecimals.set(cacheKey, pending);
  }

  return await pendingDecimals.get(cacheKey)!;
}

async function _getDecimalsErc20(
  signer: SignerOrProvider,
  tokenAddress: string
) {
  const contract = new Contract(tokenAddress, Erc20Abi, signer);
  const decimals = await contract.decimals();
  return decimals;
}

export async function getBalanceOfErc20(
  signer: Signer,
  tokenAddress: string
): Promise<BigNumber> {
  const contract = new Contract(tokenAddress, Erc20Abi, signer);
  const ownerAddress = await signer.getAddress();
  return await contract.balanceOf(ownerAddress);
}

export async function getAllowanceOfErc20(
  signer: Signer,
  tokenAddress: string,
  allowedAddress: string
): Promise<BigNumber> {
  const contract = new Contract(tokenAddress, Erc20Abi, signer);
  const signerAddress = await signer.getAddress();
  return await contract.allowance(signerAddress, allowedAddress);
}

export async function approveErc20(
  signer: Signer,
  tokenAddress: string,
  allowedAddress: string,
  amount: BigNumber
) {
  logger.debug(
    `Approving ${amount.toString()} of token ${tokenAddress} for spender ${allowedAddress}`
  );
  return await NonceTracker.queueTransaction(signer, async (nonce: number) => {
    const contractUnconnected = new Contract(tokenAddress, Erc20Abi, signer);
    const contract = contractUnconnected.connect(signer);
    const tx = await contract.approve(allowedAddress, amount, {
      nonce: nonce.toString(),
    });
    const receipt = await tx.wait();
    logger.info(
      `Approved token ${tokenAddress} for ${allowedAddress} | tx: ${receipt.transactionHash}`
    );
    return receipt;
  });
}

export async function transferErc20(
  signer: Signer,
  tokenAddress: string,
  recipient: string,
  amount: BigNumber
) {
  logger.debug(
    `Transferring ${amount.toString()} of token ${tokenAddress} to ${recipient}`
  );
  return await NonceTracker.queueTransaction(signer, async (nonce: number) => {
    const contractUnconnected = new Contract(tokenAddress, Erc20Abi, signer);
    const contract = contractUnconnected.connect(signer);
    const tx = await contract.transfer(recipient, amount, {
      nonce: nonce.toString(),
    });
    const receipt = await tx.wait();
    logger.info(
      `Transferred ${amount.toString()} of token ${tokenAddress} to ${recipient} | tx: ${receipt.transactionHash}`
    );
    return receipt;
  });
}

/**
 * Convert from WAD (18 decimals) to token's native decimals
 * Use: When passing Ajna amounts to external DEXs
 * Example: convertWadToTokenDecimals(collateral, 6) for USDC
 */
export function convertWadToTokenDecimals(
  wadAmount: BigNumber,
  tokenDecimals: number
): BigNumber {
  if (tokenDecimals === 18) {
    return wadAmount; // No conversion needed
  }

  if (tokenDecimals < 18) {
    // Scale down: divide by 10^(18 - tokenDecimals)
    const divisor = ethers.BigNumber.from(10).pow(18 - tokenDecimals);
    return wadAmount.div(divisor);
  } else {
    // Scale up: multiply by 10^(tokenDecimals - 18)
    const multiplier = ethers.BigNumber.from(10).pow(tokenDecimals - 18);
    return wadAmount.mul(multiplier);
  }
}

/**
 * Convert from WAD (18 decimals) to token's native decimals, rounding up.
 * Use when the converted value is a repayment, gas, or min-out floor.
 */
export function convertWadToTokenDecimalsCeil(
  wadAmount: BigNumber,
  tokenDecimals: number
): BigNumber {
  if (tokenDecimals === 18) {
    return wadAmount;
  }

  if (tokenDecimals < 18) {
    const divisor = ethers.BigNumber.from(10).pow(18 - tokenDecimals);
    return wadAmount.isZero()
      ? ethers.BigNumber.from(0)
      : wadAmount.add(divisor).sub(1).div(divisor);
  }

  const multiplier = ethers.BigNumber.from(10).pow(tokenDecimals - 18);
  return wadAmount.mul(multiplier);
}

/**
 * Convert from token's native decimals to WAD (18 decimals)
 * Use: When passing DEX results back to Ajna
 */
export function convertTokenDecimalsToWad(
  tokenAmount: BigNumber,
  tokenDecimals: number
): BigNumber {
  if (tokenDecimals === 18) {
    return tokenAmount; // No conversion needed
  }

  if (tokenDecimals < 18) {
    // Scale up: multiply by 10^(18 - tokenDecimals)
    const multiplier = ethers.BigNumber.from(10).pow(18 - tokenDecimals);
    return tokenAmount.mul(multiplier);
  } else {
    // Scale down: divide by 10^(tokenDecimals - 18)
    const divisor = ethers.BigNumber.from(10).pow(tokenDecimals - 18);
    return tokenAmount.div(divisor);
  }
}
