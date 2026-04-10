export type {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
} from './types';

import {
  handleDiscoveredSettlementTarget as handleDiscoveredSettlementTargetImpl,
  type HandleDiscoveredSettlementTargetParams,
} from './settlement-executor';
import {
  handleDiscoveredTakeTarget as handleDiscoveredTakeTargetImpl,
  type HandleDiscoveredTakeTargetParams,
} from './take-executor';

export async function handleDiscoveredTakeTarget(
  params: HandleDiscoveredTakeTargetParams
): Promise<void> {
  return await handleDiscoveredTakeTargetImpl(params);
}

export async function handleDiscoveredSettlementTarget(
  params: HandleDiscoveredSettlementTargetParams
): Promise<void> {
  return await handleDiscoveredSettlementTargetImpl(params);
}
