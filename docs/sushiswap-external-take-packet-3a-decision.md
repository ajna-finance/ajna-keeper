# Packet 3A Decision: Sushi Competitiveness

<!-- Derived from the checked typed artifact at tools/external-take-evidence/fixtures/sushi-competitiveness.artifact.json. -->

Generated: 2026-06-12T10:27:46.509Z

## Decision: `proceed`

Sushi earns first-class support on 6 scoped chain(s): non-dominated expected output vs the successful incumbent on chain(s) 1, 8453, 42161, 10, 137, 43114; every scoped target/selector/spender has 3 distinct-timestamp/hash stability samples. 1inch rows are missing_credentials and contribute nothing to this decision.

### Packet 3B scope (the only unlocked surface)

- Chains: 1, 8453, 42161, 10, 137, 43114
- Pairs: WETH/USDC, WAVAX/USDC
- Source filters: sushi swap API v7 same-chain routes
- Allowlist (target / selector / spender):
  - 0xac4c6e212a361c968f1725b4d055b47e63f80b75 / 0x5f3bd1c8 / 0xac4c6e212a361c968f1725b4d055b47e63f80b75

## Sample rows

| Chain | Pair | Sushi | LI.FI | 1inch | Assessment |
| --- | --- | --- | --- | --- | --- |
| ethereum (1) | WETH/USDC | success | success | missing_credentials (reproducible) | Sushi expected 1671021010 vs LI.FI 1667187891 USDC raw for 1.0 WETH; 1inch unavailable (missing_credentials). |
| base (8453) | WETH/USDC | success | success | missing_credentials (reproducible) | Sushi expected 1671240812 vs LI.FI 1667140864 USDC raw for 1.0 WETH; 1inch unavailable (missing_credentials). |
| arbitrum (42161) | WETH/USDC | success | success | missing_credentials (reproducible) | Sushi expected 1677047561 vs LI.FI 1672854921 USDC raw for 1.0 WETH; 1inch unavailable (missing_credentials). |
| optimism (10) | WETH/USDC | success | success | missing_credentials (reproducible) | Sushi expected 1670219630 vs LI.FI 1666085653 USDC raw for 1.0 WETH; 1inch unavailable (missing_credentials). |
| polygon (137) | WETH/USDC | success | success | missing_credentials (reproducible) | Sushi expected 1670133848 vs LI.FI 1666063050 USDC raw for 1.0 WETH; 1inch unavailable (missing_credentials). |
| avalanche (43114) | WAVAX/USDC | success | success | missing_credentials (reproducible) | Sushi expected 6611282 vs LI.FI 6599059 USDC raw for 1.0 WAVAX; 1inch unavailable (missing_credentials). |
| hemi (43111) | WETH/USDC.e | success | no_route (reproducible) | missing_credentials (reproducible) | Sushi routes successfully but incumbent failures include credentials/rate-limit/transient classes, which never justify coverage-based proceed for this chain. |

Failure-classification policy: incumbent `missing_credentials`, `rate_limited`, `transient_error`, and `malformed_response` outcomes never count toward a proceed decision (packet-3a.md).
