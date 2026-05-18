# Security Policy

## Reporting Vulnerabilities

This repository is maintained by contributors rather than a single designated maintainer. There is no private security inbox or guaranteed response SLA for this project at this time.

For public, non-sensitive issues, open a GitHub issue:

<https://github.com/ajna-finance/ajna-keeper/issues>

For proposed fixes, open a pull request:

<https://github.com/ajna-finance/ajna-keeper/pulls>

## Sensitive Reports

If a report includes an exploitable vulnerability, private key material, API keys, unpublished infrastructure details, or a live-loss scenario, do not include secrets or exploit-ready transaction data in the initial public issue.

Instead:

1. Open a minimal issue that states the affected area, impact class, and that details are sensitive.
2. Offer to provide a private reproduction path to active repository contributors.
3. Open a pull request with a minimized fix when possible, avoiding unnecessary disclosure of active credentials, private infrastructure, or unrelated operational details.

If GitHub private vulnerability reporting is enabled for this repository in the future, prefer that path for sensitive reports.

## Scope

In scope:

- transaction submission, nonce handling, private/relay take transport, and signer safety
- liquidation discovery, take execution, settlement execution, and reward collection logic
- external DEX integration and taker contracts
- configuration validation that could allow unsafe live execution
- secret handling, keystore handling, logging, and operational safety controls

Out of scope:

- market losses caused by normal auction, gas, liquidity, or price movement
- failed transactions caused by intentionally unsupported configuration
- third-party service outages or stale data outside this repository's control
- reports that require access to private keys, production API keys, or privileged infrastructure

## Operator Guidance

Before running live:

- use a dedicated signer account per chain and keeper instance
- use dry-run mode and allow/deny lists before enabling broad discovery
- verify RPC chain ID, subgraph freshness, contract addresses, taker registrations, DEX router addresses, gas caps, and profit thresholds
- keep keystores and API keys out of the repository
- monitor balances, nonces, transaction submission, and keeper logs continuously

See [README.md](README.md) and [production_setup_guide.md](production_setup_guide.md) for setup and production-operation guidance.
