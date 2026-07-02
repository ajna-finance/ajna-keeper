import { KeeperConfig } from '../../../src/config';
import { BASE_CONFIG } from './discovery-runtime-fixture';

// Extends the shared BASE_CONFIG with a discovery block; renamed to avoid
// mixing it up with the discovery-runtime-fixture export of the same shape.
export const DISCOVERY_BASE_CONFIG: KeeperConfig = {
  ...BASE_CONFIG,
  discovery: {
    enabled: true,
    take: true,
    settlement: true,
    logSkips: true,
    defaults: {
      take: {
        minCollateral: 0.1,
        hpbPriceFactor: 0.98,
      },
      settlement: {
        enabled: true,
        minAuctionAge: 3600,
        maxBucketDepth: 50,
        maxIterations: 5,
        checkBotIncentive: true,
      },
    },
  },
};
