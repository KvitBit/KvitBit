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

Expected: `PASSED: 2 passed`, about 16 s in total (model base 3 s and twelve mutants about 1 s each; replay 1 s, 30 tests). Nightly (`--wide`) runs `DocumentLifecycle_wide.cfg` (3 payment slots, 530,520 distinct states, about 50 s). The replay alone: `bun test ./formal/lifecycle/lifecycle.replay.test.ts`.

Read every TLC result, pass or violation, with the `/statechart` skill: it prints a violation's shortest path in plain words and charts a passing model. TLC logs land in `formal/.cache/logs/`.

## Does my change touch this?

Yes, if the diff touches a covered file, a guarded symbol, or what they call: `DocumentsRepo.lock`/`update` (row lock and revision CAS), `CoreStore.transaction`, `withIdempotency` around these methods, `NumberingSeries.allocate` inside them, or the Postgres adapter's `SELECT ... FOR UPDATE`. `formal/manifest.json` (entries `lifecycle.model`, `lifecycle.replay`) holds the exact list with sha256 digests; `bun run verify:formal --check-digests` names drifted files.

| Check | Covered files (`packages/core/src/`) | Guarded symbols |
|---|---|---|
| `lifecycle.model` (TLC) and `lifecycle.replay` | `modules/documents/{transitions,lifecycle,final,corrections,credit,payments,service,compose}.ts`, `modules/payments/service.ts`, `store/memory.ts` | `TRANSITIONS`, `Documents.edit`, `guard`, `paymentsBlockCancel`, `hasFinalInvoice`, `hasDependents`, `cancel`, `lock`, `unlock`, `editIssued`, `issueFinalInvoice`, `deductionLines`, `plan` (final.ts, corrections.ts), `loadForCredit`, `correct`, `withinRemainder`, `issueCreditNote`, `settlementOf`, `isFullyCredited`, `DocumentPayments.lock`/`settle`, `issuePaymentTaxDocument`, `removalBlocked`, `Payments.record`/`remove` |

The VAT, rounding and CZK amounts of these documents are `verify-vat-numbering-math`'s; this skill abstracts amounts to units per bucket. `compose.ts` is covered because it computes the Final Invoice's deduction lines that the replay compares with the PTDs; the replay uses prices without VAT only (`pricesIncludeVat` is not covered here).

## What the checks promise

Each property is an INVARIANT or PROPERTY of `DocumentLifecycle.cfg`. The replay's `Lab.check` asserts, on the real state after each step: `OneFinalInvoice`, `FinalInvoiceOfPaidProforma`, `PtdPerPayment` (real payment -> PTD links), `CancelledProformaUnpaid`, `CancelledFinalUnpaid` (status cancelled, or a storno the harness saw succeed), `CancelledIsLocked`, `RemovedPaymentReversed` (which payments the Final Invoice deducted is harness bookkeeping), `CreditWithinOriginal` (PTDs and the Final Invoice's supply), `DeductionsCurrent`. It holds no history, so `LegalTransitions` and `FrozenWhenDepended` are replayed only as expected outcomes of single steps (a refused edit, a refused cancel); `NoPtdAfterFinal` only through `PtdPerPayment` (payments after the Final Invoice carry no PTD).

| Property | Promise | Harm if broken |
|---|---|---|
| `LegalTransitions` (action) | Statuses move draft -> issued -> cancelled only; a Final Invoice never disappears; credits, reversals and a cancelled document's lock are sticky; payments go none -> live -> removed. | A document reappears or leaves a final state, so numbers, VAT and history disagree. |
| `CancelledProformaUnpaid` | A cancelled Proforma has no recorded payments and no Final Invoice (D6). | Money received stays booked on a voided document; the buyer's advance disappears from the books. |
| `CancelledFinalUnpaid`, `CancelledIsLocked` | A cancelled Final Invoice (status cancelled, or a tax Final Invoice's storno by full Credit Note) has no own payments; cancelled means locked (D5, D6). | A voided invoice keeps cash or accepts edits. |
| `OneFinalInvoice`, `FinalInvoiceOfPaidProforma` | One Final Invoice per Proforma, and only for a paid one (D8). | The supply is invoiced, and its VAT declared, twice. |
| `PtdPerPayment`, `NoPtdAfterFinal` | A vat_payer's payment on the Proforma issues exactly its own PTD; payments on the Final Invoice and a non_vat_payer's issue none; no PTD appears after the Final Invoice (P2, D8). | Advance VAT is declared twice or not at all. |
| `RemovedPaymentReversed` | A removed advance has its PTD fully credited and the Final Invoice that deducted it reversed (P3). | VAT declared on a PTD, or deducted on a Final Invoice, for money that was never kept. |
| `CreditWithinOriginal` | Cumulative Credit Notes never exceed the original per VAT bucket (D7). | A Credit Note refunds more VAT than was charged. |
| `DeductionsCurrent` (H2) | While a Final Invoice deducts a PTD, the PTD's uncredited amount equals what the Final Invoice deducts (D8, §37a). | The advance's VAT is deducted on the Final Invoice and also reversed by a PTD Credit Note: the VAT return under-declares. |
| `FrozenWhenDepended` (action) | The Proforma's lines change only while nothing depends on them (D3a). | PTDs and the Final Invoice no longer match the Proforma they follow. |

### Hypothesis H2: PTD correction interleaving with Final Invoice issue - REFUTED within the bounds

TLC explores an in-flight `issueFinalInvoice` (lock Proforma, lock PTDs and read their Credit Notes, commit) against an in-flight `correct`/`cancel` of a PTD (lock Proforma, lock PTD and read the Final Invoice, commit), each able to abort, in every order with the other actions: `DeductionsCurrent` holds (24,800 distinct states). What prevents it:
- Both transactions row-lock the Proforma first: `final.ts:209`, `corrections.ts:204` (`loadForCredit`; `lifecycle.ts:597` for cancel), so they serialize.
- After the Final Invoice commits, the correction sees its `final_invoice_for` link on the locked Proforma and refuses a PTD the live Final Invoice deducts: `corrections.ts:206-214` (`deductedBy`), `:235`; `lifecycle.ts:599`.
- Before it, the Final Invoice reads each PTD's Credit Notes after locking the PTD (`final.ts:65-69`), so it deducts the remainder.

Mutant `no-proforma-lock` (the PTD's Proforma read without its lock) breaks `DeductionsCurrent` in 8 steps: issue the Proforma; a payment arrives (PTD issued); Final Invoice issue locks the Proforma and reads the PTD; the PTD correction reads the Proforma (no Final Invoice yet); the Final Invoice commits deducting the whole PTD; the correction locks the PTD, sees no Final Invoice, and commits a Credit Note. The replay runs both serial orders on the real code (`H2: ...` tests).

## Model, bounds, assumptions

- Bounds (base): 2 VAT buckets, 2 payment slots (and so up to 2 PTDs), one Final Invoice slot, at most one `issueFinalInvoice` and one PTD correction in flight, both regimes (vat_payer, non_vat_payer) from `Init`; `identified_person` is out of scope. 24,800 distinct states, depth 26. Wide: 3 payment slots.
- Scope: a bounded lifecycle and concurrency slice, not every clause of D5-D8, P2 and P3. `DeductionsCurrent` only bites on vat_payer traces (a non_vat_payer has no PTDs). `LegalTransitions` covers the part of the transition table the model represents. In the model `PtdPerPayment` checks the payment-slot-to-PTD-slot mapping; the replay checks the real payment -> PTD links. `duplicate-final` shows the count reacts to a second issue; the model keeps one Final Invoice record.
- Atomic steps: every method is one CoreStore transaction. The memory store serializes transactions (`store/memory.ts:4-8,193-200`); the SQL adapter is assumed to row-lock with `SELECT ... FOR UPDATE` at READ COMMITTED (`store/CoreStore.ts:1-12`) in S4 order, the Proforma first (`docs/design/core-ports.md:1445-1447`). A method is one step when what it decides on cannot change under it. Either it holds the lock that every writer of that row takes: `Payments.remove` reads the PTD without a lock, but every PTD writer locks the Proforma first, which `remove` holds (`payments.ts:205-233,483-503`). Or the value only moves one way: `loadForCredit` reads the Final Invoice without a lock, but it can only become reversed, which only lifts a block. Correcting or cancelling the Final Invoice locks only the Final Invoice (`corrections.ts:202-205`) and is one step. The two H2 methods, `issueFinalInvoice` and a PTD's `correct`/`cancel`, are split at their lock acquisitions so the mutant can run them without the Proforma lock.
- A failed transaction writes nothing and releases its locks (`FiAbort`, `CpAbort`; `store/memory.ts` restores the frame, Postgres rolls back).
- Amounts: a payment and its PTD carry 1 unit per bucket; the Final Invoice's supply 1 unit per bucket; a Credit Note credits 0 or 1 unit per bucket, non-zero. PTD slot i belongs to payment slot i.
- Not modelled: the Credit Note that a tax document's cancel issues beyond "the remainder is credited", the Document Lock of a PTD (it only disables `correct`/`cancel`, so it cannot break a safety property), edits other than the Proforma's lines, a Final Invoice patch, `send`/`share`/delivery, idempotent replays (`verify-idempotency-cas`), more than one Proforma, a regime change between payments, invoices that are not Final Invoices.
- Deadlock: TLC's deadlock check is on, but it cannot see a lock cycle between in-flight transactions, because `FiAbort` and `CpAbort` are always enabled while one is in flight. Lock cycles are not checked by this model. The argument instead (S4, not verified): both split transactions take the Proforma lock first and the PTD lock second, and every other method takes the Proforma before the Final Invoice (`payments.ts:205-226`), so no two requests take locks in opposite orders.

### Replay harness

30 tests, vat_payer and non_vat_payer, on a fresh `TestCore` each (`TestClock` at 2026-11-23T09:00Z, CNB fixings 2026-11-20 and 2026-11-23 at 25.000): the shortest path to each model action (`Shortest path per model action`), guard traces, both serial orders of H2, the D7 cap for PTDs and the Final Invoice, and four crash points. `Lab.check` asserts the invariants above after every step; for the Final Invoice the cap compares its Credit Notes' supply lines with its own supply lines per bucket.
- Crash points: `FixtureRates.unavailable` makes `Payments.record` on a EUR Proforma fail inside `issuePaymentTaxDocument` after the payment row and the settle were written, and makes `issueFinalInvoice` fail in `compose`. A numbering series at its last counter (`Workspaces.configureSeries` with `nextNumber: 2147483646`) makes a PTD Credit Note (`CpAbort`) and a Final Invoice (`FiAbort`) fail at allocation with `Conflict{illegal_transition, numbering.pattern_invalid}`. Each test asserts nothing was kept.
- Required seam that does not exist (not added; product code is out of scope): a failure after a row is written and before commit, e.g. after `issueFinalInvoice` inserts the Final Invoice and before it links the Proforma (`final.ts:214-234`), or after `issueCreditNote` inserts the Credit Note and before it updates the original (`credit.ts:400-428`). Today those aborts are covered only by the model and the memory store's frame rollback.
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

- Sync commit: `eecb9be`. In sync: `2fa0670`, `5669f20` and `eecb9be` change only how a Final Invoice's net bucket VAT is converted to CZK (`compose.ts`), the CZK VAT of the partial-credit cap (`corrections.ts`) and which open buckets a remainder Credit Note turns into supply lines (`credit.ts`, document-currency buckets only) (F1, `verify-vat-numbering-math`); the deduction lines, locks, transitions and bucket-level D7 caps this model abstracts are unchanged. Base, mutants and the 30-test replay rerun green at eecb9be. Checked with tla2tools 1.7.4, Java 17.0.21, Bun 1.4.4 on 2026-11-24.
- Mutants (`bun run verify:formal --only lifecycle.model`), each a genuine invariant violation of a property the base and wide configs declare:

| Mutant | Break | Violates |
|---|---|---|
| `cancel-with-payments` | cancel ignores recorded payments | `CancelledProformaUnpaid` |
| `cancel-final-with-payments` | storno of a tax Final Invoice ignores its own payments | `CancelledFinalUnpaid` |
| `duplicate-final` | no `hasFinalInvoice` check (the issue count reacts; one Final Invoice record is kept) | `OneFinalInvoice` |
| `remove-with-deduction` | removal ignores a live Final Invoice | `RemovedPaymentReversed` |
| `no-proforma-lock` | PTD correction without the Proforma lock (H2) | `DeductionsCurrent` |
| `credit-over-cap` | no D7 per-bucket cap | `CreditWithinOriginal` |
| `reissue-cancelled` | issue accepts a cancelled Proforma | `LegalTransitions` (action) |
| `edit-with-payments` | lines edit ignores the Proforma's payments | `FrozenWhenDepended` (action) |
| `cancel-unlocked` | cancel leaves the Proforma unlocked | `CancelledIsLocked` |
| `ptd-after-final` | a payment on the Proforma after its Final Invoice issues a PTD | `NoPtdAfterFinal` |
| `no-ptd` | a vat_payer's payment on the Proforma issues no PTD | `PtdPerPayment` |
| `final-unpaid` | `issueFinalInvoice` skips the payments check | `FinalInvoiceOfPaidProforma` |

- Able-to-fail gate on the real code (2026-11-24, at `77a5bb7`): each break was applied to the file, `bun test ./formal/lifecycle/lifecycle.replay.test.ts` failed as shown, `git checkout` restored the file, and the run was green again (30 pass). Rows 1-4 were rerun on the 29-test harness and row 1 again on the 30-test one; row 7 came from review round 1, rows 5-6 from the diff council, rows 8-9 from review round 2; the `deductedBy` row was rerun after `DeductionsCurrent` started summing signed deduction amounts.

| Break | File | Caught by |
|---|---|---|
| `paymentsBlockCancel` check disabled | `modules/documents/lifecycle.ts:602` | `Lab.check` `CancelledProformaUnpaid` (live payments on a cancelled Proforma), 2 tests |
| `hasFinalInvoice` duplicate check disabled | `modules/documents/final.ts:130` | `Lab.check` `OneFinalInvoice` (2 `final_invoice_for` links; the memory store has no unique link index) |
| `removalBlocked` Final Invoice check disabled | `modules/documents/payments.ts:497` | `Lab.check` `RemovedPaymentReversed` (non_vat_payer cash advance removed under a live Final Invoice); with a vat_payer the open PTD still blocks the removal |
| `deductedBy` dropped from the correction plan | `modules/documents/corrections.ts:235` | `Lab.check` `DeductionsCurrent` (PTD credited under a live Final Invoice) |
| `hasDependents` ignores the Proforma's payments | `modules/documents/transitions.ts:161` | the expected `Conflict{illegal_transition}` of a lines edit on a paid Proforma (`FrozenWhenDepended` as a step outcome) |
| `issuePaymentTaxDocument` returns no PTD for a vat_payer | `modules/documents/payments.ts:384` | `Lab.check` `PtdPerPayment` (a vat_payer's payment on the Proforma without its PTD) |
| D7 cap skipped for Invoices (`withinRemainder` only when `kind !== "invoice"`) | `modules/documents/corrections.ts:253` | `Lab.check` `CreditWithinOriginal` for the Final Invoice (its supply line credited twice) |
| `plan` payments check disabled (Final Invoice for an unpaid Proforma) | `modules/documents/final.ts:139` | `Lab.check` `FinalInvoiceOfPaidProforma` (a Final Invoice with no deduction line) |
| A partial Credit Note line stored at the original rate + 1 | `modules/documents/corrections.ts:132-139` (`partialSpec`) | `Lab.check` `CreditWithinOriginal` for the Final Invoice (credited bucket the Final Invoice does not have), 3 tests |

- Able-to-fail evidence per property: every property in the base config has a mutant that violates it (table above). Real-code breaks also catch `CancelledProformaUnpaid`, `CancelledFinalUnpaid` (row 1, through the storno), `OneFinalInvoice`, `RemovedPaymentReversed`, `DeductionsCurrent`, `CreditWithinOriginal`, `PtdPerPayment`, `FinalInvoiceOfPaidProforma` and `FrozenWhenDepended` (as a step outcome). `TypeOK` is the model's type check, not a promise of the code.
