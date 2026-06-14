import { ChainAddressAllowlist, ChainTargetSelectorAllowlist } from '../../config';

/**
 * Reviewed initial Sushi aggregator scope. These constants are the ONLY
 * chains, pairs, and target/selector/spender values accepted by the default
 * reviewed production config. They are reviewed configuration defaults:
 * runtime code does not read implementation-planning artifacts.
 *
 * Enabling Sushi on any other chain or route requires a new reviewed
 * scope decision BEFORE the config/allowlist change.
 */
export const SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS: readonly number[] = [
  1, 8453, 42161, 10, 137, 43114,
];

/** The single stability-proven RouteProcessor tuple (identical per chain). */
export const SUSHI_AGGREGATOR_PROVEN_TARGET =
  '0xac4c6e212a361c968f1725b4d055b47e63f80b75';
export const SUSHI_AGGREGATOR_PROVEN_SELECTOR = '0x5f3bd1c8';
export const SUSHI_AGGREGATOR_PROVEN_SPENDER =
  SUSHI_AGGREGATOR_PROVEN_TARGET;

export const SUSHI_AGGREGATOR_SCOPED_PAIRS: readonly string[] = [
  'WETH/USDC',
  'WAVAX/USDC',
];

function buildAddressAllowlist(): ChainAddressAllowlist {
  const allowlist: ChainAddressAllowlist = {};
  for (const chainId of SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS) {
    allowlist[chainId] = [SUSHI_AGGREGATOR_PROVEN_TARGET];
  }
  return allowlist;
}

function buildSelectorAllowlist(): ChainTargetSelectorAllowlist {
  const allowlist: ChainTargetSelectorAllowlist = {};
  for (const chainId of SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS) {
    allowlist[chainId] = {
      [SUSHI_AGGREGATOR_PROVEN_TARGET]: [SUSHI_AGGREGATOR_PROVEN_SELECTOR],
    };
  }
  return allowlist;
}

/**
 * The reviewed scoped allowlists for dex.sushiAggregator. Operators should
 * start from these values verbatim; widening them is a reviewed-evidence
 * change, not a config tweak.
 */
export const SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST: ChainAddressAllowlist =
  buildAddressAllowlist();
export const SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST: ChainAddressAllowlist =
  buildAddressAllowlist();
export const SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST: ChainTargetSelectorAllowlist =
  buildSelectorAllowlist();
