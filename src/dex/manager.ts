// src/dex/manager.ts
import { Signer } from 'ethers';
import { PoolConfig, LiquiditySource } from '../config';
import { logger } from '../logging';

/**
 * Deployment types supported by the smart detection system
 * - single: Use existing AjnaKeeperTaker.sol approach (major chains)
 * - factory: Use factory pattern with multiple DEX implementations (newer chains)  
 * - none: No DEX integration available, arbTake/settlement only
 */
export type DeploymentType = 'factory' | 'single' | 'none';

/**
 * Minimal config interface for smart detection - only the fields we actually need
 */
interface SmartDexConfig {
  keeperTaker?: string;
  keeperTakerFactory?: string;
  takerContracts?: { [source: string]: string };
  oneInchRouters?: { [chainId: number]: string };
  [key: string]: unknown;
}

function isFactoryLiquiditySource(
  liquiditySource?: LiquiditySource
): boolean {
  return (
    liquiditySource === LiquiditySource.UNISWAPV3 ||
    liquiditySource === LiquiditySource.SUSHISWAP ||
    liquiditySource === LiquiditySource.CURVE
  );
}


/**
 * Smart DEX Manager - Analyzes configuration and routes to appropriate take implementation
 * 
 * This enables backward compatibility with existing single-contract deployments
 * while supporting multi-DEX factory deployments on newer chains.
 */
export class SmartDexManager {
  private signer: Signer;
  private config: SmartDexConfig;

  constructor(signer: Signer, config: SmartDexConfig) {
    this.signer = signer;
    this.config = config;
  }

  async detectDeploymentTypeForPool(poolConfig: Pick<PoolConfig, 'name' | 'take'>): Promise<DeploymentType> {
    const liquiditySource = poolConfig.take?.liquiditySource;

    if (liquiditySource === LiquiditySource.ONEINCH) {
      if (this.config.keeperTaker) {
        logger.debug(
          `Smart Detection: Using single deployment for 1inch pool ${poolConfig.name}`
        );
        return 'single';
      }
      logger.warn(
        `Smart Detection: 1inch requested for pool ${poolConfig.name} but keeperTaker is not configured`
      );
      return 'none';
    }

    if (isFactoryLiquiditySource(liquiditySource)) {
      if (this.config.keeperTakerFactory && this.config.takerContracts) {
        logger.debug(
          `Smart Detection: Using factory deployment for pool ${poolConfig.name}`
        );
        return 'factory';
      }
      logger.warn(
        `Smart Detection: factory-backed liquidity requested for pool ${poolConfig.name} but factory contracts are not configured`
      );
      return 'none';
    }

    logger.debug(
      `Smart Detection: No external liquidity source configured for pool ${poolConfig.name}`
    );
    return 'none';
  }

  /**
   * Determines if external take (with DEX swap) is possible for this pool configuration
   * Checks both deployment type and pool-specific take settings
   */
  async canTakeLiquidation(poolConfig: PoolConfig): Promise<boolean> {
    const deploymentType = await this.detectDeploymentTypeForPool(poolConfig);
    const liquiditySource = poolConfig.take?.liquiditySource;
    const hasExternalTakeConfig = !!(
      liquiditySource !== undefined && poolConfig.take?.marketPriceFactor
    );
    
    switch (deploymentType) {
      case 'single':
        const canTakeSingle =
          liquiditySource === LiquiditySource.ONEINCH && hasExternalTakeConfig;
        logger.debug(`Single deployment - can take: ${canTakeSingle} for pool ${poolConfig.name}`);
        return canTakeSingle;
        
      case 'factory':
        const canTakeFactory =
          isFactoryLiquiditySource(liquiditySource) && hasExternalTakeConfig;
        logger.debug(`Factory deployment - can take: ${canTakeFactory} for pool ${poolConfig.name}`);
        return canTakeFactory;
        
      case 'none':
        // No external DEX - only arbTake possible
        logger.debug(`No DEX deployment - external takes not possible for pool ${poolConfig.name}`);
        return false;
    }
  }

  async validateDeploymentForPool(
    poolConfig: Pick<PoolConfig, 'name' | 'take'>
  ): Promise<{ valid: boolean; errors: string[] }> {
    const deploymentType = await this.detectDeploymentTypeForPool(poolConfig);
    const errors: string[] = [];
    const liquiditySource = poolConfig.take?.liquiditySource;

    switch (deploymentType) {
      case 'single':
        if (!this.config.keeperTaker) {
          errors.push('Single deployment requires keeperTaker address');
        }
        if (liquiditySource === LiquiditySource.ONEINCH && !this.config.oneInchRouters) {
          errors.push('1inch deployment requires oneInchRouters configuration');
        }
        break;
      case 'factory':
        if (!this.config.keeperTakerFactory) {
          errors.push('Factory deployment requires keeperTakerFactory address');
        }
        if (!this.config.takerContracts || Object.keys(this.config.takerContracts).length === 0) {
          errors.push('Factory deployment requires at least one takerContracts entry');
        }
        break;
      case 'none':
        logger.debug(
          `No external take deployment available for pool ${poolConfig.name}; arbTake-only fallback remains valid`
        );
        break;
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
