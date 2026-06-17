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
- HEAD: `630dcd42689f92ccf2b17f855846a478ca237f05`
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
Fresh Ajna audit of the calldata-aggregator taker contracts (ajna-keeper, NOT ajna-core). Focus on contracts/base/BaseAggregatorCalldataTaker.sol + KeeperTakerBase.sol + contracts/takers/*: the take callback repayment invariant (ceil quote pull for non-18-decimal tokens), token-scale rounding, ERC20 parity (fee-on-transfer, USDT approve, forced token donation to balance checks), reentrancy + active-callback binding, approval handling, allowlist enforcement (target/spender/selector/code-existence), access control (onlyOwnerOrRouter), and any griefing/DoS vector. Report concrete findings with file:line, the invariant/security property, actor/fund impact, and required fix or test.
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
