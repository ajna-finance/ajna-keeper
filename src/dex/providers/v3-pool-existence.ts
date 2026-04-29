import { BigNumber, ethers, Signer } from 'ethers';
import { logger } from '../../logging';
import {
  PoolExistenceCache,
  POOL_EXISTS_CACHE_TTL_MS,
  UNINITIALIZED_POOL_CACHE_TTL_MS,
} from './pool-existence-cache';

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

export class InitializedV3PoolExistenceChecker {
  private factoryContract?: ethers.Contract;
  private readonly poolExistenceCache = new PoolExistenceCache();

  constructor(
    private readonly signer: Signer,
    private readonly factoryAddress: string,
    private readonly label: string
  ) {}

  async poolExists(
    tokenA: string,
    tokenB: string,
    feeTier: number
  ): Promise<boolean> {
    try {
      return await this.poolExistenceCache.getOrCreate(
        tokenA,
        tokenB,
        feeTier,
        async () => {
          const poolAddress = await this.getFactoryContract().getPool(
            tokenA,
            tokenB,
            feeTier
          );
          const exists = await this.isPoolInitialized(poolAddress);
          this.logResult({
            tokenA,
            tokenB,
            feeTier,
            poolAddress,
            exists,
          });
          return {
            exists,
            ttlMs: exists
              ? POOL_EXISTS_CACHE_TTL_MS
              : UNINITIALIZED_POOL_CACHE_TTL_MS,
          };
        }
      );
    } catch (error) {
      logger.debug(`Error checking ${this.label} pool existence: ${error}`);
      throw error;
    }
  }

  private getFactoryContract(): ethers.Contract {
    if (!this.factoryContract) {
      this.factoryContract = new ethers.Contract(
        this.factoryAddress,
        V3_FACTORY_ABI,
        this.signer
      );
    }
    return this.factoryContract;
  }

  private async isPoolInitialized(poolAddress: string): Promise<boolean> {
    if (poolAddress === ethers.constants.AddressZero) {
      return false;
    }
    const poolContract = new ethers.Contract(poolAddress, V3_POOL_ABI, this.signer);
    const slot0 = await poolContract.slot0();
    return BigNumber.from(slot0.sqrtPriceX96 ?? slot0[0]).gt(0);
  }

  private logResult(params: {
    tokenA: string;
    tokenB: string;
    feeTier: number;
    poolAddress: string;
    exists: boolean;
  }): void {
    if (params.exists) {
      logger.debug(
        `${this.label} initialized pool found: ${params.tokenA}/${params.tokenB} fee=${params.feeTier} at ${params.poolAddress}`
      );
      return;
    }
    if (params.poolAddress !== ethers.constants.AddressZero) {
      logger.debug(
        `${this.label} pool is not initialized at the current slot0 price: ${params.tokenA}/${params.tokenB} fee=${params.feeTier} at ${params.poolAddress}`
      );
      return;
    }
    logger.debug(
      `${this.label} pool NOT found: ${params.tokenA}/${params.tokenB} fee=${params.feeTier}`
    );
  }
}
