// Compatibility re-exports: the canonical provider-neutral implementation
// lives in src/take/aggregator-calldata/allowlist.ts (Packet 2B).
export {
  normalizeTakerSelectorAllowlist as normalizeLifiSelectorAllowlist,
  normalizeTakerSelectorAllowlistRecord as normalizeLifiSelectorAllowlistRecord,
} from '../../take/aggregator-calldata/allowlist';
export type { TakerSelectorAllowlist as LifiSelectorAllowlist } from '../../take/aggregator-calldata/allowlist';
