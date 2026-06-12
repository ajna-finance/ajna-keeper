# ADR 0001: Pinned ethers v5 / OpenZeppelin 4.9 toolchain

Status: accepted (2026-06-12). Revisit trigger: before the next major feature
after the SushiSwap aggregator roadmap (`docs/sushiswap-external-take-plan.md`)
ships, or earlier if a security advisory lands against a pinned major.

## Decision

The repo deliberately stays on:

- `ethers` v5 (with `@typechain/ethers-v5` typegen targets)
- `@openzeppelin/contracts` 4.9.x (`security/ReentrancyGuard.sol` path,
  `safeApprove` API)
- TypeScript `target: es5`, mocha + ts-node test toolchain

These are coupled: migrating ethers to v6 drags the typechain target, every
test helper (`BigNumber` vs native `bigint`, `providers.*` namespaces,
`receipt.events` parsing), the dex router modules, and the deployment scripts
in one move. OpenZeppelin 5.x removes `safeApprove` and moves
`ReentrancyGuard`, touching every taker contract. Neither migration changes
on-chain behavior the keeper needs today, and both carry regression risk on a
codebase whose taker surface was just audit-hardened (PR #17).

## Known costs accepted until the revisit

- `@nomicfoundation/hardhat-ethers` (an ethers-v6-era plugin) is imported by
  `hardhat.config.ts` but unused at runtime (tests use raw ethers v5 against
  `network.provider`); its v6 type declarations do not typecheck against
  ethers v5, which is why `tsconfig.json` sets `skipLibCheck: true`. Project
  code remains fully type-checked via `npm run typecheck`. The migration that
  retires this mismatch is the ethers v6 move.
- `safeApprove` deprecation warnings from OZ 4.9 are expected; the
  `_safeApproveWithReset` zero-first pattern in `KeeperTakerBase` is the
  supported usage and is regression-tested against a strict-approval token.

## What this ADR is not

Not a freeze on patch/minor updates within the pinned majors, and not an
endorsement of drifting further (e.g., do not add new ethers-v6-only
dependencies while pinned to v5).
