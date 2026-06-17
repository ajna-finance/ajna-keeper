// This harness targets a Base fork by design. These addresses are Ajna's Base
// mainnet deployment and must stay aligned with the fixture creator.
export const BASE_AJNA_CONFIG = {
  erc20PoolFactory: '0x214f62B5836D83f3D6c4f71F174209097B1A779C',
  erc721PoolFactory: '0xeefEC5d1Cc4bde97279d01D88eFf9e0fEe981769',
  poolUtils: '0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa',
  positionManager: '0x59710a4149A27585f1841b5783ac704a08274e64',
  ajnaToken: '0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47',
  grantFund: '',
  burnWrapper: '',
  lenderHelper: '',
};

// Canonical home is src/dex/oneinch-aggregator/route-canary-env.ts; re-exported
// here so no-spend scripts keep a single import surface (scripts -> src).
export { BASE_ONEINCH_ROUTER } from '../../src/dex/oneinch-aggregator/route-canary-env';

// Sentinel URL for harness mode. If anything bypasses the fixture subgraph
// override, the .invalid TLD fails loudly instead of hitting a live subgraph.
export const FIXTURE_SUBGRAPH_SENTINEL_URL =
  'http://fixture-subgraph.override.invalid';
