// src/smart-dex-manager.ts
import { Signer } from 'ethers';
import { PoolConfig, LiquiditySource } from './config-types';
import { logger } from './logging';

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
  pools?: Array<{ take?: { liquiditySource?: any } }>;
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

  /**
   * Analyzes the configuration to determine what type of deployment is available
   * Priority order: factory > single > none
   */
  async detectDeploymentType(): Promise<DeploymentType> {
    // Factory pattern deployment - new approach for multi-DEX support
    if (this.config.keeperTakerFactory && this.config.takerContracts) {
      logger.debug('Smart Detection: Factory deployment detected - multi-DEX support available');
      return 'factory';
    }
    
    // Single contract deployment - existing approach for major chains
    if (this.config.keeperTaker) {
      logger.debug('Smart Detection: Single contract deployment detected - using existing 1inch integration');
      return 'single';
    }
    
    // No DEX integration available - arbTake and settlement only
    logger.warn('Smart Detection: No DEX integration configured - arbTake and settlement only');
    return 'none';
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

  /**
   * Validates that the detected deployment type has all required configuration
   * Helps catch configuration errors early
   */
  async validateDeployment(): Promise<{ valid: boolean; errors: string[] }> {
    const deploymentType = await this.detectDeploymentType();
    const errors: string[] = [];

    switch (deploymentType) {
      case 'single':
        if (!this.config.keeperTaker) {
          errors.push('Single deployment requires keeperTaker address');
        }
        // Check if any pools are configured for takes
        const poolsWithTakes = (this.config.pools || []).filter(p => p.take?.liquiditySource);
        if (poolsWithTakes.length > 0) {
          // Validate 1inch-specific requirements
          if (!this.config.oneInchRouters) {
            errors.push('Pools configured for takes but oneInchRouters missing');
          }
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
        // No validation needed - arbTake/settlement doesn't require external contracts
        logger.debug('No external take capability - this is valid for arbTake/settlement only operation');
        break;
    }

    return {
      valid: errors.length === 0,
      errors
    };
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
