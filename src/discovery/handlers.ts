export type {
  DiscoveryExecutionConfig,
  DiscoveryExecutionTransportConfig,
  DiscoveryRpcCache,
} from './types';

import {
  handleDiscoveredSettlementTarget as handleDiscoveredSettlementTargetImpl,
  type HandleDiscoveredSettlementTargetParams,
} from './settlement-executor';
import {
  handleDiscoveredTakeTarget as handleDiscoveredTakeTargetImpl,
  type DiscoveredTakeTargetStats,
  type HandleDiscoveredTakeTargetParams,
} from './take-executor';

export async function handleDiscoveredTakeTarget(
  params: HandleDiscoveredTakeTargetParams
): Promise<DiscoveredTakeTargetStats> {
  return await handleDiscoveredTakeTargetImpl(params);
}

export async function handleDiscoveredSettlementTarget(
  params: HandleDiscoveredSettlementTargetParams
): Promise<void> {
  return await handleDiscoveredSettlementTargetImpl(params);
}
