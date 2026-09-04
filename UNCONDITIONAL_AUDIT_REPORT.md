# GMX Synthetics — Unconditional Contracts Audit

```text
report_id: GMX-SYNTHETICS-MAIN-UNCONDITIONAL-2026-09-04
audited_repository: thedotdev-cpu/gmx-synthetics
audited_main_commit: a85ea3491c19c93bb4b5a002d9b358fb769b7849
audited_contracts_tree: a36efa6203096804bb46f42e4fc0d5a2035e34a2
audit_branch: audit/unconditional-main-a85ea349
verification: full source inventory + corpus/analyzer triage + targeted repository tests
```

## Result

No Critical or High issue survived the strict unconditional gate.

| ID | Severity | Finding | Verification |
|---|---|---|---|
| U-01 | Medium | Swap-path pool mutations retroactively rewrite elapsed borrowing fees | Source + passing test |
| U-02 | Low | Order callbacks and update events lose material lifecycle state | Source |
| U-03 | Informational | Zero-input swaps bypass `minOutputAmount` and complete successfully | Source |
| U-04 | Informational | Position-impact-pool zeroing branches emit inverted delta signs | Source |
| L-01 | Informational / latent | Fee-batch count reads the wrong typed DataStore collection | Source; no production caller found |

Measured coverage: 309 production-tree Solidity files, 49,729 raw Solidity lines, 2,196 parsed functions, 597 external/public mutators, 430 Solidity files compiled by the repository build, 1,362 supplied candidate records cross-checked, and 1,297 Slither detector records grouped and triaged.

## Strict gate

A live finding is included only when the defective transition exists in the pinned source, is reached through a normal supported or directly exposed path, and is deterministic after valid caller-controlled inputs. Findings requiring compromised roles, malicious configuration, broken external infrastructure, non-standard tokens, donated/unattributed vault balances, insolvency, or an exceptional pre-arranged economic state are excluded. Ordinary feature prerequisites are allowed.

## U-01 — Swap-path pool mutations retroactively rewrite elapsed borrowing fees

**Severity: Medium — confirmed by a passing repository test.**

Pure swap orders are required to store `order.market == address(0)` (`contracts/order/OrderUtils.sol:128-141`). `BaseOrderHandler` loads the real markets only into `swapPathMarkets` and leaves `params.market` empty (`contracts/exchange/BaseOrderHandler.sol:45-74`). `ExecuteOrderUtils` then checkpoints funding and borrowing for that empty market (`contracts/order/ExecuteOrderUtils.sol:53-69`) before `SwapOrderUtils` invokes the swap over the real path (`contracts/order/SwapOrderUtils.sol:60-74`).

`SwapUtils` changes the real market's token-in and token-out pool amounts (`contracts/swap/SwapUtils.sol:329-345`) without checkpointing that market. The borrowing clock remains unchanged. At the next read or checkpoint, `MarketUtils` calculates:

```text
delta = elapsed_seconds * current_borrowing_factor_per_second
```

(`contracts/market/MarketUtils.sol:2739-2757`). The current rate depends on current reserved USD and pool USD (`contracts/market/MarketUtils.sol:2771-2840`). Consequently, the post-swap utilization rate is applied to time that elapsed before the swap.

Correct integration around a state change at `t_s` is:

```text
C(t1) = C(t0) + (t_s - t0) * r_before + (t1 - t_s) * r_after
```

The implementation instead behaves as:

```text
C_actual(t1) = C(t0) + (t1 - t0) * r_after
```

The passing proof test deposits ordinary liquidity, opens a $200,000 long, advances 14 days, confirms positive borrowing debt, executes a separate 100 WNT pure swap through the same market, proves that the real market's borrowing timestamp and cumulative factor did not change, and then proves the displayed debt fell by more than 1% because the changed pool state repriced the entire elapsed interval.

```text
✔ lets a swap rewrite the rate applied to already elapsed borrowing time
1 passing
AUDIT_TEST_RESULT|test/audit/SwapBorrowingRetroactivity.ts|0
```

**Impact:** incorrect trader debt, pool/fee revenue, collateral and liquidation calculations, with outcomes dependent on transaction ordering between swaps and position checkpoints.

**Fix:** before the first pool mutation, checkpoint every unique real market in `swapPathMarkets` using prices from the same authenticated oracle batch. Do not checkpoint the zero-address placeholder. Enforce the invariant: every mutation of an input to a time-dependent rate first persists accrual under the pre-mutation state.

## U-02 — Order callbacks and update events lose material lifecycle state

**Severity: Low — source confirmed.**

`IncreaseOrderUtils` obtains the actual post-swap `collateralToken` and `collateralIncrementAmount`, uses them to mutate the position, then returns an empty `EventLogData` (`contracts/order/IncreaseOrderUtils.sol:18-35,84-98`). By contrast, swap execution returns `outputToken` and `outputAmount`, and decrease execution returns both output legs and adjusted deltas.

Further, cancellation emits `reason` / `reasonBytes` but passes an empty cancellation callback payload; freeze sets `executionFee = 0` and `isFrozen = true` but passes empty event data (`contracts/order/OrderUtils.sol:305-322,371-381`). Updating an order unfreezes it and changes its execution fee (`contracts/exchange/OrderHandler.sol:130-168`), while `OrderUpdated` emits neither `isFrozen` nor `executionFee` (`contracts/order/OrderEventUtils.sol:65-96`).

**Impact:** callback automation and event-sourced indexers cannot reconstruct the canonical transition and may retain stale frozen/fee state or account for requested rather than actual post-swap collateral.

**Fix:** populate increase callback data with actual collateral token and amount; include lifecycle reason fields in cancellation/freeze callback data; emit all changed mutable fields, ideally old and new values, in `OrderUpdated`.

## U-03 — Zero-input swaps bypass `minOutputAmount`

**Severity: Informational — source confirmed.**

`SwapUtils.swap` returns immediately when `amountIn == 0`, before any minimum-output check (`contracts/swap/SwapUtils.sol:77-97`). A zero-collateral swap order can still pass `validateNonEmptyOrder` by setting the otherwise unused `sizeDeltaUsd` field nonzero (`contracts/order/BaseOrderUtils.sol:374-383`). It then completes, emits `OrderExecuted`, and calls the success callback with zero output despite a positive `minOutputAmount`.

**Fix:** enforce order-type-specific non-emptiness at creation; swap orders must have positive input and irrelevant fields should be rejected. Apply the minimum-output check on every return path.

## U-04 — Impact-pool zeroing events use inverted signs

**Severity: Informational — source confirmed.**

When a negative impact exceeds the position-impact pool, storage is set to zero but `PositionImpactPoolAmountUpdated` emits the removed amount as positive. The corresponding branch that clears the lent pool does the same, and `reduceLentAmount` decrements storage while emitting a positive reduction (`contracts/market/MarketUtils.sol:1085-1131`; `contracts/market/PositionImpactPoolUtils.sol:205-216`). The event schema explicitly calls the signed field `delta` (`contracts/market/MarketEventUtils.sol:202-247`).

**Impact:** event-sourced accounting reconstructs an increase while canonical storage decreased.

**Fix:** emit a negative delta for every decrement/zeroing transition and test `previousValue + emittedDelta == nextValue`.

## L-01 — Fee-batch count uses the wrong typed collection

`FEE_BATCH_LIST` is maintained as a bytes32 set, but `getFeeBatchCount` calls `getAddressCount` (`contracts/fee/FeeBatchStoreUtils.sol:22-106`). No production caller was found, so this is latent rather than live. Replace it with `getBytes32Count` before integration.

## Executed exclusions

Two tests passed but are not unconditional findings: a delegated subaccount can self-select as UI-fee receiver, and auto-top-up can reimburse a delegated subaccount for a fee already embedded in the principal's WNT collateral transfer. Both require the principal to explicitly create and authorize the adverse subaccount. A third callback execution-fee-capture hypothesis failed and was rejected.

Previous `release_2.2.1` TWAP findings were not carried over: the current pinned `main` contracts tree contains no TWAP creation path. Vault-delta races, router balance sweeps, malformed provider/configuration cases, exotic tokens, exact-balance funding edges and other contingent paths were also excluded under the strict gate.

## Verification limitation

This is an exhaustive source inventory and targeted executable audit, not a formal proof of absence. U-01 was reproduced against the repository fixture rather than economically quantified against current live deployment parameters. Its Medium severity reflects a demonstrated reachable accounting rewrite without claiming unsupported current-mainnet profitability.
