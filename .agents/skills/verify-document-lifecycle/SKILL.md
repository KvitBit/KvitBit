---
name: verify-document-lifecycle
description: "Model-check the Proforma -> Payment Tax Document -> Final Invoice -> Credit Note lifecycle (cancel, lock, payments, PTDs, the Final Invoice, corrections, payment removal, competing transactions and aborts) with TLC, and replay its traces on the real core. Use before merging any change to packages/core/src/modules/documents/{lifecycle,transitions,final,credit,corrections,payments}.ts, packages/core/src/modules/payments/**, the row locks or transaction frames in packages/core/src/store/, or rules D3a, D5-D8, P2-P4, S4 in docs/design/core-ports.md."
---

# Verify the document lifecycle

ADR-0005 Tier 1 checks for `@kvitbit/core`. A bounded TLA+ model (`formal/lifecycle/DocumentLifecycle.tla`) explores every order of the lifecycle and payment actions on one Proforma, including an in-flight Final Invoice issue racing an in-flight PTD correction and transactions that abort. A replay harness (`formal/lifecycle/lifecycle.replay.test.ts`) drives the real `Documents` and `Payments` services on `TestCore` along the model's traces and checks the model's invariants on the stored state after every step.

Terms: a bounded TLC pass is **verification within the bounds below**, not a proof for every size. The replay is a set of fixed traces, not exhaustive.

## Run

From the repo root (Bun 1.4.2 per `packageManager`, last run with Bun 1.4.4; JDK 17 from `.mise.toml`; tla2tools 1.7.4 fetched and checksummed by `formal/toolchain/toolchain.ts`):

```sh
bun run verify:formal --only lifecycle.model --only lifecycle.replay
```

Expected: `PASSED: 2 passed`, about 13 s in total (model base 3 s and five mutants about 1-3 s each; replay 1 s, 16 tests). Nightly (`--wide`) runs `DocumentLifecycle_wide.cfg` (3 payment slots, about 22 s). The replay alone: `bun test ./formal/lifecycle/lifecycle.replay.test.ts`.

Read every TLC result, pass or violation, with the `/statechart` skill: it prints a violation's shortest path in plain words and charts a passing model. TLC logs land in `formal/.cache/logs/`.

## Does my change touch this?

Yes, if the diff touches a covered file, a guarded symbol, or what they call: `DocumentsRepo.lock`/`update` (row lock and revision CAS), `CoreStore.transaction`, `withIdempotency` around these methods, `NumberingSeries.allocate` inside them, or the Postgres adapter's `SELECT ... FOR UPDATE`. `formal/manifest.json` (entries `lifecycle.model`, `lifecycle.replay`) holds the exact list with sha256 digests; `bun run verify:formal --check-digests` names drifted files.

| Check | Covered files (`packages/core/src/`) | Guarded symbols |
|---|---|---|
| `lifecycle.model` (TLC) and `lifecycle.replay` | `modules/documents/{transitions,lifecycle,final,corrections,credit,payments}.ts`, `modules/payments/service.ts`, `store/memory.ts` | `TRANSITIONS`, `guard`, `paymentsBlockCancel`, `hasFinalInvoice`, `hasDependents`, `cancel`, `lock`, `unlock`, `editIssued`, `issueFinalInvoice`, `deductionLines`, `plan` (final.ts, corrections.ts), `loadForCredit`, `correct`, `withinRemainder`, `issueCreditNote`, `settlementOf`, `isFullyCredited`, `DocumentPayments.lock`/`settle`, `issuePaymentTaxDocument`, `removalBlocked`, `Payments.record`/`remove` |

The VAT, rounding and CZK amounts of these documents are `verify-vat-numbering-math`'s; this skill abstracts amounts to units per bucket.

## What the checks promise

Each property is an INVARIANT or PROPERTY of `DocumentLifecycle.cfg`; the replay's `Lab.check` asserts the same names on real state.

| Property | Promise | Harm if broken |
|---|---|---|
| `LegalTransitions` (action) | Statuses move draft -> issued -> cancelled only; a Final Invoice never disappears; credits, reversals and a cancelled document's lock are sticky; payments go none -> live -> removed. | A document reappears or leaves a final state, so numbers, VAT and history disagree. |
| `CancelledProformaUnpaid` | A cancelled Proforma has no recorded payments and no Final Invoice (D6). | Money received stays booked on a voided document; the buyer's advance disappears from the books. |
| `CancelledFinalUnpaid`, `CancelledIsLocked` | A cancelled Final Invoice has no own payments; cancelled means locked (D5, D6). | A voided invoice keeps cash or accepts edits. |
| `OneFinalInvoice`, `FinalInvoiceOfPaidProforma` | One Final Invoice per Proforma, and only for a paid one (D8). | The supply is invoiced, and its VAT declared, twice. |
| `PtdPerPayment`, `NoPtdAfterFinal` | A vat_payer's payment on the Proforma issues exactly its own PTD; payments on the Final Invoice and a non_vat_payer's issue none; no PTD appears after the Final Invoice (P2, D8). | Advance VAT is declared twice or not at all. |
| `RemovedPaymentReversed` | A removed advance has its PTD fully credited and the Final Invoice that deducted it reversed (P3). | VAT declared on a PTD, or deducted on a Final Invoice, for money that was never kept. |
| `CreditWithinOriginal` | Cumulative Credit Notes never exceed the original per VAT bucket (D7). | A Credit Note refunds more VAT than was charged. |
| `DeductionsCurrent` (H2) | While a Final Invoice deducts a PTD, the PTD's uncredited amount equals what the Final Invoice deducts (D8, §37a). | The advance's VAT is deducted on the Final Invoice and also reversed by a PTD Credit Note: the VAT return under-declares. |
| `FrozenWhenDepended` (action) | The Proforma's lines change only while nothing depends on them (D3a). | PTDs and the Final Invoice no longer match the Proforma they follow. |

### Hypothesis H2: PTD correction interleaving with Final Invoice issue - REFUTED within the bounds

TLC explores an in-flight `issueFinalInvoice` (lock Proforma, lock PTDs and read their Credit Notes, commit) against an in-flight `correct`/`cancel` of a PTD (lock Proforma, lock PTD and read the Final Invoice, commit), each able to abort, in every order with the other actions: `DeductionsCurrent` holds (15,920 states). What prevents it:
- Both transactions row-lock the Proforma first: `final.ts:209`, `corrections.ts:204` (`loadForCredit`; `lifecycle.ts:597` for cancel), so they serialize.
- After the Final Invoice commits, the correction sees its `final_invoice_for` link on the locked Proforma and refuses a PTD the live Final Invoice deducts: `corrections.ts:206-214` (`deductedBy`), `:235`; `lifecycle.ts:599`.
- Before it, the Final Invoice reads each PTD's Credit Notes after locking the PTD (`final.ts:65-69`), so it deducts the remainder.

Mutant `no-proforma-lock` (the PTD's Proforma read without its lock) breaks `DeductionsCurrent` in 8 steps: issue the Proforma; a payment arrives (PTD issued); Final Invoice issue locks the Proforma and reads the PTD; the PTD correction reads the Proforma (no Final Invoice yet); the Final Invoice commits deducting the whole PTD; the correction locks the PTD, sees no Final Invoice, and commits a Credit Note. The replay runs both serial orders on the real code (`H2: ...` tests).

## Model, bounds, assumptions

- Bounds (base): 2 VAT buckets, 2 payment slots (and so up to 2 PTDs), one Final Invoice slot, at most one `issueFinalInvoice` and one PTD correction in flight, both regimes (vat_payer, non_vat_payer) from `Init`. 15,920 distinct states, depth 26. Wide: 3 payment slots.
- Atomic steps: every method is one CoreStore transaction. The memory store serializes transactions (`store/memory.ts:4-8,193-200`); the SQL store row-locks with `SELECT ... FOR UPDATE` at READ COMMITTED (`store/CoreStore.ts:1-12`) in S4 order. Only `issueFinalInvoice` and a PTD's `correct`/`cancel` are split at their lock acquisitions, because they read rows they have not locked when they start; every other method locks each row it decides on (the Proforma first, `payments.ts:205-234`) before reading it. Correcting or cancelling the Final Invoice locks only the Final Invoice (`corrections.ts:202-205`) and is one step.
- A failed transaction writes nothing and releases its locks (`FiAbort`, `CpAbort`; `store/memory.ts` restores the frame, Postgres rolls back).
- Amounts: a payment and its PTD carry 1 unit per bucket; the Final Invoice's supply 1 unit per bucket; a Credit Note credits 0 or 1 unit per bucket, non-zero. PTD slot i belongs to payment slot i.
- Not modelled: the Document Lock of a PTD (it only disables `correct`/`cancel`, so it cannot break a safety property), edits other than the Proforma's lines, a Final Invoice patch, `send`/`share`/delivery, idempotent replays (`verify-idempotency-cas`), more than one Proforma, a regime change between payments, invoices that are not Final Invoices.
- Deadlock: checked. `Done` (no request in flight) is the only stutter, so a lock cycle between in-flight transactions would still be reported.

### Replay harness

16 tests, vat_payer and non_vat_payer, on a fresh `TestCore` each (`TestClock` at 2026-11-23T09:00Z, CNB fixings 2026-11-20 and 2026-11-23 at 25.000): the shortest path to each model action, both serial orders of H2, the D7 cap, and two crash points. `Lab.check` asserts the invariants above after every step.
- Crash points: `FixtureRates.unavailable` makes `Payments.record` on a EUR Proforma fail inside `issuePaymentTaxDocument` after the payment row and the settle were written, and makes `issueFinalInvoice` fail in `compose`; the tests assert that nothing was kept, then retry successfully.
- Required seams that do not exist (not added; product code is out of scope): a failure injection for `NumberingSeries.allocate` or `DocumentsRepo.insert` inside `issueCreditNote` (a Credit Note abort, `CpAbort`) and inside `issueFinalInvoice` after the insert (an abort after the Final Invoice row is written, before the Proforma link). Today such aborts are covered only by the model and by the memory store's frame rollback.
- Not covered by the replay: the in-flight overlaps themselves. The memory store runs transactions one at a time, so Postgres locking is assumed, not tested. A pg-contention test (`*.contention.ts`, Postgres 17) should cover: (1) `issueFinalInvoice` and `correct`/`cancel` of a PTD of the same Proforma started together: exactly one order wins and `DeductionsCurrent` holds; (2) `Payments.record` on the Proforma racing `issueFinalInvoice`: the payment lands on the Proforma with a PTD the Final Invoice deducts, or on the Final Invoice, never in between; (3) `Payments.remove` racing `issueFinalInvoice` and racing a full Credit Note of the Final Invoice; (4) two `issueFinalInvoice` calls: one `Conflict{duplicate}` (unique `document_relations_one_final_invoice_per_proforma`); (5) `cancel` of the Proforma racing `Payments.record`; (6) no `40P01` deadlock under S4 order in any of these.

## When a check fails

- A base TLC violation, or a replay test failing in `Lab.check`: read the TLC trace with `/statechart`, then replay it on the real code as a test (one step per action, through `Lab`). If the real code shows it, it is a **real bug**: keep the property, report the counterexample in the code's words with file:line, and do not change product code unless asked. If the real code refuses a step the model allows, suspect the model first.
- A replay test failing on an expected outcome (`conflict(...)`, `invalid(...)`, a status): the code's behavior changed. If the rule in `docs/design/core-ports.md` changed with it, that is **drift**: update the model guard and the replay expectation together, citing the rule. If not, it is a bug.
- The harness fails before its assertions (a setup call to `Workspaces`, `Contacts` or `Documents.issue` fails): **harness drift** in an API it uses; fix the harness, not the properties.
- A mutant passes (`expected violation`): the property it targets no longer constrains the model. Fix the model; never delete the mutant.

## Updating

1. Change the model only for an intended rule change, and cite the file:line it now follows in the action's comment. Keep every property and mutant.
2. Run the command above until green; read the base result and each mutant's trace with `/statechart`.
3. Repeat the able-to-fail break for each property you touched: scratch-break the real code, run the replay, see it fail, `git checkout` the file, see it pass.
4. Update bounds, covered files and symbols here and in `formal/manifest.json`, then `bun run verify:formal --update-digests --only lifecycle.model --only lifecycle.replay` and rerun.
5. Move the sync commit forward only after you confirm the model and harness describe the covered code at the new commit. For gaps left by earlier changes, use `/maintain-formal-verification-skill`.

## Coverage record

- Sync commit: `77a5bb7` (product code unchanged by this work). Checked with tla2tools 1.7.4, Java 17.0.21, Bun 1.4.4 on 2026-11-24.
- Mutants (`bun run verify:formal --only lifecycle.model`), each a genuine invariant violation of a property the base and wide configs declare:

| Mutant | Break | Violates |
|---|---|---|
| `cancel-with-payments` | cancel ignores recorded payments | `CancelledProformaUnpaid` |
| `duplicate-final` | no `hasFinalInvoice` check | `OneFinalInvoice` |
| `remove-with-deduction` | removal ignores a live Final Invoice | `RemovedPaymentReversed` |
| `no-proforma-lock` | PTD correction without the Proforma lock (H2) | `DeductionsCurrent` |
| `credit-over-cap` | no D7 per-bucket cap | `CreditWithinOriginal` |

- Able-to-fail gate on the real code (2026-11-24, at `77a5bb7`): each break was applied to the file, `bun test ./formal/lifecycle/lifecycle.replay.test.ts` failed as shown, `git checkout` restored the file, and the run was green again (16 pass).

| Break | File | Caught by |
|---|---|---|
| `paymentsBlockCancel` check disabled | `modules/documents/lifecycle.ts:602` | `Lab.check` `CancelledProformaUnpaid` (live payments on a cancelled Proforma), 2 tests |
| `hasFinalInvoice` duplicate check disabled | `modules/documents/final.ts:130` | `Lab.check` `OneFinalInvoice` (2 `final_invoice_for` links; the memory store has no unique link index) |
| `removalBlocked` Final Invoice check disabled | `modules/documents/payments.ts:497` | `Lab.check` `RemovedPaymentReversed` (non_vat_payer cash advance removed under a live Final Invoice); with a vat_payer the open PTD still blocks the removal |
| `deductedBy` dropped from the correction plan | `modules/documents/corrections.ts:235` | `Lab.check` `DeductionsCurrent` (PTD credited under a live Final Invoice) |
