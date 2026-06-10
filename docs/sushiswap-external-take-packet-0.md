# Sushi Aggregator Packet 0: Hot-File Guard Bootstrap

## Purpose

Add the mechanical hot-file growth checker before any Sushi removal or aggregator
refactor packet touches already-large central files.

This packet is tooling-only. It must not change runtime behavior, config
semantics, deployment behavior, contract code, or route selection.

## Scope

- Add `scripts/check-hot-file-growth.mjs` or an equivalent repo-local test.
- The checker must compare the current packet diff against an explicit base ref.
- The checker must cover:
  - `src/config/validation.ts`
  - `src/take/external-take/route.ts`
  - `src/take/external-take/quote-approval.ts`
  - `src/discovery/route-preflight.ts`
  - `scripts/deploy-factory-system.ts`
- The checker must fail on:
  - missing or wrong base ref
  - per-file added-line growth in any covered hot file
  - additions above 10 lines in any covered hot file
  - `scripts/deploy-factory-system.ts` reaching 1000 lines
  - final total-line violations for covered files
- The checker may be bypassed only by a packet closeout record that lists the
  file, added lines, reason, and why a focused helper or provider-neutral module
  cannot own the logic.
- Do not add Sushi-specific logic, route policy logic, provider ids, config
  fields, or deployment behavior in Packet 0.

## Tests

- Checker passes on an unchanged tree against the declared base ref.
- Checker fails when a fixture diff adds lines to each covered hot file.
- Checker fails when `scripts/deploy-factory-system.ts` would reach or exceed
  1000 lines.
- Checker fails when run without the required base ref or with the wrong base
  ref.
- Checker output identifies the file, added lines, final line count, and violated
  rule.
- Packet diff contains no runtime/config/contract/Sushi behavior changes.

## Acceptance

- Packet 0 lands before Packet 1.
- Every later packet can run the hot-file checker before touching hot files.
- Hot-file exceptions require explicit human closeout justification.
- No production behavior changes.
