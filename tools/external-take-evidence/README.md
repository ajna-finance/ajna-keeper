# External-Take Evidence Tooling (Packets 2A / 3A)

Tooling-only evidence schema, checker, and Sushi route-shape normalizer for
the calldata-aggregator implementation.
This directory is the single owner of the shared evidence components
(`ProviderResult`, `SampleRow`, `FailureClassification`) and the
discriminated artifact union (`route_shape` for Packet 2A,
`competitiveness` for Packet 3A).

## Boundary

Production `src/**` must never import anything from this directory or the
recorded artifacts. `tests/unit/evidence-tooling-boundary.test.ts` enforces
this. The proposed `ApprovedCalldataAggregatorQuote` field names validated
here are a Packet 2A proposal; Packet 2B owns freezing the production type.

## Recorded decisions

- **Validation mechanism: hand-rolled checks** (`evidence-schema.ts`), no
  schema-validation dependency. Zero new dependencies under the pinned
  toolchain (docs/adr/0001), matching the repo's hand-rolled parser posture.
  Packet 3A must reuse this module and must not introduce a second
  validation mechanism.
- **Entrypoint translation:** the packet doc names
  `scripts/check-calldata-aggregator-evidence.mjs`; following the recorded
  Packet 0 precedent (`check-hot-file-growth.mjs` → `.ts`), the command
  entrypoints are ts-node scripts:
  - `npm run check-calldata-aggregator-evidence` — the committed gate
  - `npm run refresh-sushi-route-shape-evidence` — live read-only refresh
- **Spike quote identity:** fixtures use the burn address
  `0x…dead` as sender so committed evidence is clearly detached from any
  operator wallet.

## Empirical route-shape findings (Packet 2A spike)

- `https://api.sushi.com/swap/v7/{chainId}` answers keylessly with
  `status, tokens, tokenFrom, tokenTo, swapPrice, priceImpact, amountIn,
  assumedAmountOut, gasSpent, tx{from,to,gasPrice,data}`.
- **Proven shape** (selector `0x5f3bd1c8`, all seven matrix chains):
  calldata head words `(tokenIn, amountIn, recipient, tokenOut,
  amountOutMin, route…)` on the RouteProcessor target. The decoded
  `amountOutMin` tracks `assumedAmountOut * (1 - maxSlippage)`.
- The `recipient` query parameter rewrites the encoded recipient word
  (verified); the default recipient is the sender.
- `tx.value` is absent for ERC20 inputs; the normalizer records `'0'` and
  fails closed on any non-zero value.
- The approval spender is the execution target itself: the RouteProcessor
  pulls the input token from the caller.
- **Unproven second shape** (selector `0xd33721a5`): observed only for
  wrapped-native POL input on Polygon; its head layout does not match the
  proven shape, so normalization fails closed and the response is committed
  as the real ambiguous fixture
  (`fixtures/raw/sushi-v7-polygon-wpol-usdc-ambiguous-shape.json`).
  Packet 2B may freeze only the proven shape.

## Fixture layout

- `fixtures/sushi-route-shape.artifact.json` — the typed `route_shape`
  artifact (7-chain matrix rows, observed response shapes, normalized
  fields).
- `fixtures/raw/*.json` — raw provider responses wrapped with request
  context, capture timestamp, `expectedNormalization`
  (`success` | `fail_closed`), and `expectedClassification` for failure
  captures. Raw responses live only in this spike evidence and must not
  cross into execution approval.

Refreshing evidence re-queries the live API (HTTP GET only — no wallet, no
broadcast) and rewrites fixtures plus the artifact; the committed fixtures
and offline unit tests remain the proof the gates rely on.
