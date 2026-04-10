import { KeeperConfig } from '../config-types';
import {
  resolveSubgraphConfig,
  SubgraphConfigInput,
  WithSubgraph,
} from '../read-transports';

export interface SettlementStatus {
  auctionExists: boolean;
  bondsLocked: boolean;
  bondsClaimable: boolean;
  needsSettlement: boolean;
  canWithdrawBonds: boolean;
}

export interface SettlementResult {
  success: boolean;
  completed: boolean;
  iterations: number;
  reason: string;
}

export interface AuctionToSettle {
  borrower: string;
  kickTime: number;
  debtRemaining: import('ethers').BigNumber;
  collateralRemaining: import('ethers').BigNumber;
}

export interface SettlementNeedResult {
  needs: boolean;
  reason: string;
  details?: any;
}

export interface SettlementIncentiveResult {
  hasIncentive: boolean;
  reason: string;
}

export type SettlementReadConfig = WithSubgraph<
  Pick<KeeperConfig, 'dryRun' | 'delayBetweenActions'>
>;

export type SettlementConfigInput = SubgraphConfigInput<
  Pick<KeeperConfig, 'dryRun' | 'delayBetweenActions'>
>;

export function resolveSettlementReadConfig(
  config: SettlementConfigInput
): SettlementReadConfig {
  return resolveSubgraphConfig(config);
}
