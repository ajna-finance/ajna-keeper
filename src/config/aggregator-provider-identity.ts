import { CalldataAggregatorProviderId, LiquiditySource } from './schema';
import type {
  CalldataAggregatorLiquiditySource,
  ExternalTakeTakerContractKey,
} from './external-take-registry';

/**
 * The single shared identity registry for calldata-aggregator providers
 * (SushiSwap aggregator roadmap, Packet 2B). INERT METADATA ONLY: provider
 * id, canonical path, label, execution family, liquidity source id, taker
 * contract key, and config key. Deployment validation, canary behavior,
 * allowlist policy, quote parsing, API clients, and route-source semantics
 * live in provider-local modules or narrowly owned shared modules — never
 * here. Do not add a second source/path identity map with overlapping
 * fields.
 *
 * Packet 2B's provider union is only `lifi`. Packet 3B adds the Sushi
 * identity in the same diff that adds Sushi support; do not predeclare
 * inactive provider descriptors.
 */
export interface AggregatorProviderIdentity {
  readonly providerId: CalldataAggregatorProviderId;
  readonly canonicalPath: 'calldata_aggregator';
  readonly executionFamily: 'calldata_aggregator';
  readonly label: string;
  readonly liquiditySource: CalldataAggregatorLiquiditySource;
  readonly takerContractKey: ExternalTakeTakerContractKey;
  readonly configKey: string;
}

export const AGGREGATOR_PROVIDER_IDENTITIES = {
  lifi: {
    providerId: 'lifi',
    canonicalPath: 'calldata_aggregator',
    executionFamily: 'calldata_aggregator',
    label: 'LI.FI',
    liquiditySource: LiquiditySource.LIFI,
    takerContractKey: 'Lifi',
    configKey: 'lifi',
  },
  sushi_aggregator: {
    providerId: 'sushi_aggregator',
    canonicalPath: 'calldata_aggregator',
    executionFamily: 'calldata_aggregator',
    label: 'Sushi Aggregator',
    liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
    takerContractKey: 'SushiAggregator',
    configKey: 'sushiAggregator',
  },
} satisfies Record<CalldataAggregatorProviderId, AggregatorProviderIdentity>;

export const CALLDATA_AGGREGATOR_PROVIDER_IDS: readonly CalldataAggregatorProviderId[] =
  Object.keys(AGGREGATOR_PROVIDER_IDENTITIES) as CalldataAggregatorProviderId[];

export function isCalldataAggregatorProviderId(
  value: unknown
): value is CalldataAggregatorProviderId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(AGGREGATOR_PROVIDER_IDENTITIES, value)
  );
}

export function getAggregatorProviderIdentity(
  providerId: CalldataAggregatorProviderId
): AggregatorProviderIdentity {
  return AGGREGATOR_PROVIDER_IDENTITIES[providerId];
}

export function resolveCalldataAggregatorProviderForSource(
  source: LiquiditySource | undefined
): CalldataAggregatorProviderId | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const providerId of CALLDATA_AGGREGATOR_PROVIDER_IDS) {
    if (AGGREGATOR_PROVIDER_IDENTITIES[providerId].liquiditySource === source) {
      return providerId;
    }
  }
  return undefined;
}

export function formatCalldataAggregatorProviderIds(): string {
  return CALLDATA_AGGREGATOR_PROVIDER_IDS.join(', ');
}
