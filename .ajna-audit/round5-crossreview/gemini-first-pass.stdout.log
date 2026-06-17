- id: 1
- title: Denial of Service (Griefing) via forced collateral token donation due to strict zero-balance check
- severity: High
- confidence: High
- file:line: `contracts/base/BaseAggregatorCalldataTaker.sol:95` and `contracts/base/BaseAggregatorCalldataTaker.sol:188`
- Ajna invariant or generic EVM security property: Generic EVM security property (avoiding strict balance equality checks that are susceptible to forced token donations).
- actor/fund impact: An attacker can permanently or repeatedly DoS all calldata-aggregator takers for a specific collateral token by transferring a mere 1 wei of that token directly to the taker contract. This paralyzes the keeper from executing liquidations via these takers, potentially allowing bad debt to accumulate in the Ajna pool or allowing the attacker to secure the liquidation for themselves using a non-vulnerable or alternative taker.
- source evidence:
In `takeWithAtomicSwap`, the taker enforces a strict zero-balance precondition before invoking `pool.take()`:
```solidity
        if (IERC20(details.srcToken).balanceOf(address(this)) != 0) {
            revert StaleSourceBalance();
        }
```
Furthermore, in `_executeAggregatorCall` (which is executed during the `atomicSwapCallback`), the taker strictly expects its balance to perfectly match the off-chain-sized `amountInTokenUnits`:
```solidity
        uint256 sourceBalanceBefore = srcToken.balanceOf(address(this));
        if (sourceBalanceBefore != details.amountInTokenUnits) {
            revert UnexpectedSourceBalance();
        }
```
- minimal exploit or failure sequence:
  1. An attacker identifies that the Ajna keeper relies on a `BaseAggregatorCalldataTaker` deployment (e.g., Lifi or 1inch) for liquidating auctions on a specific Ajna pool.
  2. The attacker transfers 1 wei of the pool's collateral token directly to the calldata taker contract address.
  3. The keeper observes a liquidatable auction, sizes the calldata off-chain, and submits the liquidation transaction calling `takeWithAtomicSwap`.
  4. The transaction immediately reverts with `StaleSourceBalance()` because `balanceOf(address(this))` is 1 wei (not 0).
  5. The keeper's automated liquidation fails. Even if the keeper operator manually calls `recover()` to sweep the 1 wei, the attacker can trivially re-poison the contract by front-running the next liquidation attempt with another 1 wei donation, effectively achieving a permanent DoS at near-zero cost.
- required test or proof: Deploy a `BaseAggregatorCalldataTaker` contract, manually transfer 1 wei of the collateral token to it, and assert that any subsequent call to `takeWithAtomicSwap` for that collateral token reverts with `StaleSourceBalance()`.
- residual risk: None if fixed correctly.

**Recommended Fix:**
The contract should trust the `collateral` amount explicitly passed by the validated Ajna pool to the `atomicSwapCallback`, rather than querying its own `balanceOf(address(this))` to measure the transferred collateral. Since the calling pool is validated via `_validatePool(pool)`, the `collateral` argument accurately and safely represents the exact number of tokens the pool just transferred to the taker.
1. Remove the `StaleSourceBalance` check in `takeWithAtomicSwap`.
2. In `atomicSwapCallback`, verify the `collateral` argument instead of `balanceOf`:
```solidity
    // Change atomicSwapCallback to name the first parameter `collateral`:
    function atomicSwapCallback(
        uint256 collateral,
        uint256 quoteAmountDue,
        bytes calldata data
    ) external override nonReentrant {
        // ...
        _executeAggregatorCall(pool, collateral, quoteAmountDue, swapRouter, details);
    }

    // In _executeAggregatorCall:
    function _executeAggregatorCall(
        IERC20Pool pool,
        uint256 collateral,
        uint256 quoteAmountDue,
        address swapRouter,
        AggregatorSwapDetails memory details
    ) private {
        // ...
        if (collateral != details.amountInTokenUnits) {
            revert UnexpectedSourceBalance();
        }
        // ...
```
*(Note: `CurveKeeperTaker` and `UniswapV3KeeperTaker` already correctly utilize the `collateral` argument directly and do not suffer from this forced donation vulnerability).*

### Additional Review Notes on Requested Audit Surfaces

1. **Callback Repayment Invariant (`quoteAmountDueCeiling`):** Safely covers the ceiling backstop for non-18-decimal tokens. The `+1` token-wei over-ask successfully guards against Ajna core's ceil-divided quote pull while handling the floor-divided `quoteAmountDue` callback parameter.
2. **Token-Scale Conversion & Rounding:** Implemented correctly in `TakerTakeScaling`. `plannedTakeAmount` conservatively floor-divides collateral (matching Ajna core) and `scaleAmountOutMinimum` accurately pro-rates partial fills by rounding up the minimum quote required. 
3. **ERC20 Parity:** Robust. `SafeERC20` handles missing-return tokens, and `_safeApproveWithReset` protects against USDT-style non-zero to non-zero allowance restrictions.
4. **Reentrancy & Callback Binding:** `BaseAggregatorCalldataTaker` appropriately employs `_activeCallbackPool` and `_activeCallbackDataHash` to bind the callback tightly to the initiating transaction, preventing confused deputy attacks from malicious low-level aggregator returns, while `nonReentrant` handles deep call-stack reentrancy.
5. **Allowlist Enforcement:** Solid defense-in-depth in `_validateSwapDetails` utilizing exact pre-call approval sizing (`details.amountInTokenUnits`), `code.length` existence verification, and strict per-target `selector` masking. A malicious aggregator cannot drain funds beyond the isolated collateral strictly approved for the exact take execution.
6. **Access Control:** `TakerRouter` -> `owner` and Taker -> `onlyOwnerOrRouter` configurations correctly prevent unauthorized access, and the renaming completes the migration seamlessly. All direct balance recoveries cascade securely to the EOA owner.
7. **Immutable Source Identity:** Events, particularly `AggregatorSwapExecuted`, properly structure the static liquidity source to track origins correctly.
