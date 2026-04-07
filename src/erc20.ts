import { Signer, SignerOrProvider } from '@ajna-finance/sdk';
import { BigNumber, Contract, ethers } from 'ethers';
import Erc20Abi from './abis/erc20.abi.json';
import { NonceTracker } from './nonce';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import { logger } from './logging';

// Process-wide decimals cache. Normalize addresses so mixed-case config and runtime
// paths do not trigger duplicate RPC calls.
const cachedDecimals: Map<string, number> = new Map();
const pendingDecimals: Map<string, Promise<number>> = new Map();

function normalizeTokenAddress(tokenAddress: string): string {
  return tokenAddress.toLowerCase();
}

export function clearErc20DecimalCache(): void {
  cachedDecimals.clear();
  pendingDecimals.clear();
}

export async function getDecimalsErc20(
  signer: SignerOrProvider,
  tokenAddress: string
) {
  const normalizedAddress = normalizeTokenAddress(tokenAddress);
  if (cachedDecimals.has(normalizedAddress)) {
    return cachedDecimals.get(normalizedAddress)!;
  }

  if (!pendingDecimals.has(normalizedAddress)) {
    const pending = _getDecimalsErc20(signer, tokenAddress)
      .then((decimals) => {
        cachedDecimals.set(normalizedAddress, decimals);
        pendingDecimals.delete(normalizedAddress);
        return decimals;
      })
      .catch((error) => {
        pendingDecimals.delete(normalizedAddress);
        throw error;
      });
    pendingDecimals.set(normalizedAddress, pending);
  }

  return await pendingDecimals.get(normalizedAddress)!;
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
  amount: BigNumber) {
  logger.debug(`Approving ${amount.toString()} of token ${tokenAddress} for spender ${allowedAddress}`);
  return await NonceTracker.queueTransaction(signer, async (nonce: number) => {
    const contractUnconnected = new Contract(tokenAddress, Erc20Abi, signer);
    const contract = contractUnconnected.connect(signer);
    const tx = await contract.approve(allowedAddress, amount, { nonce: nonce.toString() });
    const receipt = await tx.wait();
    logger.info(`Approved token ${tokenAddress} for ${allowedAddress} | tx: ${receipt.transactionHash}`);
    return receipt;
  });
}

export async function transferErc20(
  signer: Signer,
  tokenAddress: string,
  recipient: string,
  amount: BigNumber
) {
  logger.debug(`Transferring ${amount.toString()} of token ${tokenAddress} to ${recipient}`);
  return await NonceTracker.queueTransaction(signer, async (nonce: number) => {
    const contractUnconnected = new Contract(tokenAddress, Erc20Abi, signer);
    const contract = contractUnconnected.connect(signer);
    const tx = await contract.transfer(recipient, amount, {
      nonce: nonce.toString()
    });
    const receipt = await tx.wait();
    logger.info(`Transferred ${amount.toString()} of token ${tokenAddress} to ${recipient} | tx: ${receipt.transactionHash}`);
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
