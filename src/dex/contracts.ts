import { ethers, providers, Signer } from 'ethers';
import { getDecimalsErc20 } from '../erc20';

export interface DexContractServices {
  makeContract(
    address: string,
    abi: ethers.ContractInterface,
    signerOrProvider: Signer | providers.Provider
  ): ethers.Contract;
  getDecimals(signer: Signer, tokenAddress: string): Promise<number>;
}

export const defaultDexContractServices: DexContractServices = {
  makeContract: (address, abi, signerOrProvider) =>
    new ethers.Contract(address, abi, signerOrProvider),
  getDecimals: getDecimalsErc20,
};
