# Ajna Audit Adversarial Review Packet

You are an isolated first-pass reviewer in an adversarial cross-review.

Use `$ajna-audit` for the review, but do not launch Codex, Claude, Gemini,
subagents, or the adversarial cross-review workflow from inside this child run.
The parent runner already launched the independent reviewers.

Do not edit files. This is a read-only first-pass review.

Do not read prior audit reports, `.ajna-audit/` directories, `/tmp/ajna-audit-*` directories, old comparison reports, or prior model findings unless the user request explicitly names them. Start from the current source, diff, tests, specs, and selected Ajna references.

## Target

- Repository: `/home/mike/Projects-2026/ajna-keeper`
- Git root: `/home/mike/Projects-2026/ajna-keeper`
- Branch: `calldata-aggregator-packets-4-5`
- HEAD: `ba02d901fa4bd8882798232092d732639498ea5c`
- Base ref: `master`
- Revision range: ``

## Working Tree Status

```text
?? .ajna-audit/
```

## Diff Scope

Inspect the full diff against base ref `master`.

## User Review Request

```text
Fresh Ajna audit of the calldata-aggregator migration PR (branch vs master) in ajna-keeper (keeper/liquidation bot + taker contracts, NOT ajna-core). Audit BOTH the Solidity taker<->pool integration AND the deployment/config tooling. Contracts: contracts/base/BaseAggregatorCalldataTaker.sol (executes arbitrary allowlisted calldata during the Ajna take callback; recently changed to trust the pool's collateral callback arg instead of balanceOf), KeeperTakerBase.sol, contracts/takers/*, contracts/factories/TakerRouter.sol, contracts/interfaces/IAjnaKeeperTaker.sol. Deploy/config: scripts/deploy-factory-system-cli.ts + scripts/deployment/{lifi-factory-deployment,sushi-aggregator-deployment}.ts (recently added Sushi taker provisioning + a 1inch guard), src/config/external-take-descriptors.ts, src/config/schema.ts. Audit for: (1) take-callback repayment invariant (ceil quote pull for non-18-decimal tokens; quoteAmountDueCeiling backstop); (2) the recently-changed collateral exact-fill check (collateral != amountInTokenUnits using the pool callback arg) - is it correct + donation-immune + does it still reject partial fills; (3) token-scale rounding (floor/ceil); (4) ERC20 parity (fee-on-transfer, USDT approve, forced donation); (5) reentrancy + active-callback binding; (6) approval handling; (7) allowlist enforcement (target/spender/selector/code-existence) - bypass/grief; (8) access control (onlyOwnerOrRouter, factory->router rename completeness); (9) deploy completeness + correctness: does the Sushi deploy module derive+reconcile allowlists correctly and register strictly after verification; is the 1inch guard correct; can an operator end up with a router mapping a source to an unconfigured/under-allowlisted taker. Report concrete findings with file:line, the Ajna invariant or EVM security property, actor/fund impact, and required fix or test. Be rigorous and falsifiable; it is fine to conclude clean.
```

## Required Output

Lead with concrete findings. For each finding include:

- id
- title
- severity
- confidence
- file:line
- Ajna invariant or generic EVM security property
- actor/fund impact
- source evidence
- minimal exploit or failure sequence
- required test or proof
- residual risk

If there are no findings, say so clearly and list the highest-risk surfaces
reviewed plus any tests or proofs still required.
