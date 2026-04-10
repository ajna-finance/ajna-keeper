export type {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
} from './discovery-handler-types';

import {
  handleDiscoveredSettlementTarget as handleDiscoveredSettlementTargetImpl,
  type HandleDiscoveredSettlementTargetParams,
} from './discovery-settlement-handler';
import {
  handleDiscoveredTakeTarget as handleDiscoveredTakeTargetImpl,
  type HandleDiscoveredTakeTargetParams,
} from './discovery-take-handler';

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
