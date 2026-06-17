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
Fresh Ajna audit of the calldata-aggregator migration PR (branch vs master). This is the ajna-keeper repo (keeper/liquidation bot + taker contracts), NOT ajna-core. Focus on the TAKER CONTRACT <-> Ajna pool integration surface: contracts/base/BaseAggregatorCalldataTaker.sol (executes arbitrary allowlisted calldata during the Ajna take callback), contracts/base/KeeperTakerBase.sol, contracts/takers/* (Lifi/OneInchAggregator/SushiAggregator/Curve/UniswapV3), contracts/factories/TakerRouter.sol (renamed from AjnaKeeperTakerFactory), contracts/interfaces/IAjnaKeeperTaker.sol. Audit for: (1) the Ajna take callback (atomicSwapCallback) repayment invariant - the taker must ensure the pool can pull quoteAmountDue (ceil-rounded for non-18-decimal quote tokens; there was a prior bug PR #17 around ceil-divided quote pulls - verify the quoteAmountDueCeiling backstop is correct); (2) token-scale conversion and rounding (floor vs ceil) for non-18-decimal collateral and quote tokens; (3) ERC20 parity / non-standard tokens (fee-on-transfer, missing-return, USDT-style approve); (4) reentrancy and the active-callback binding (_activeCallbackPool/_activeCallbackDataHash set/cleared around pool.take, nonReentrant on the callback); (5) approval handling (safe-approve-with-reset to the allowlisted spender); (6) the allowlist enforcement (call target, approval spender, selector, code-existence) - can a malicious-but-allowlisted aggregator target drain or grief; (7) access control (onlyOwnerOrRouter) and the factory->router rename completeness; (8) the immutable source identity and the single parameterized AggregatorSwapExecuted event. Report concrete findings with file:line, the Ajna invariant or EVM security property impacted, actor/fund impact, and required fix or test. Be rigorous and falsifiable.
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
