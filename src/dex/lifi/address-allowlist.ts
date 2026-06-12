// Compatibility re-exports: the canonical provider-neutral implementation
// lives in src/take/aggregator-calldata/allowlist.ts (Packet 2B).
export {
  normalizeTakerAddressAllowlist as normalizeLifiAddressAllowlist,
  normalizeTakerAddressAllowlistSet as normalizeLifiAddressAllowlistSet,
} from '../../take/aggregator-calldata/allowlist';
