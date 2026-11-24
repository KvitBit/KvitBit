---
name: verify-numbering
description: Model-check gapless document numbering (core-ports D1, S3, S4) and number overrides (D4) with TLC over every statement interleaving of competing issue and override transactions, and replay the model's traces on the real Documents.issue and Documents.edit. Use before merging any change to packages/core/src/modules/numbering/**, packages/core/src/store/numbering.ts, counters, reservations or transactions in packages/core/src/store/{CoreStore,memory}.ts, the issue, numbering and override steps of packages/core/src/modules/documents/{lifecycle,service}.ts, the documents NUMBER_PER_KIND index, the number_reservations or numbering_counters tables, or formal/numbering/**.
---

# Verify document numbering

**Property.** For every interleaving of competing issue transactions and number overrides across two counter periods, each able to roll back at any statement where it is not waiting: no two issued documents share a number, a number never moves to a second document, every number a document ever carried stays reserved, every sequence below a period's counter is reserved (no gap), every reservation belongs to a number some document carried (a rollback leaves none behind), an issue is never offered a number the documents index has to reject, the counter is exactly one past the last sequence an issue allocated, an override never moves a counter, and no set of transactions waits on each other forever.

**Harm.** Two tax documents with one number, a number given again after an override, or a gap the issuer cannot explain breaks rule D1 (gapless per series and period, every assigned number reserved forever) on documents the Workspace has already sent to customers and the tax office.

Two checks, both in `formal/manifest.json`, plus the Postgres-schema test below:

- `numbering.allocator`: TLC model `formal/numbering/Numbering.tla`. A bounded model check: every state within the bounds below is explored. It describes the code, it does not run it.
- `packages/core/test/numberReservationFk.pglite.test.ts` (part of `bun run --filter @kvitbit/core test`, not in the manifest): runs issue from input, a Credit Note, a Payment Tax Document and a Final Invoice on the real core, records every `documents` insert/update and `tryReserve` in order, and replays them as SQL in one transaction on the committed migration in PGlite. It asserts that Postgres accepts every statement (`number_reservations_document_fk`) and that each reservation follows its document's insert; a control replays the same statements with each reservation moved before its row and expects `23503 … number_reservations_document_fk`. One session, so no contention.
- `numbering.replay`: `formal/numbering/numbering.replay.test.ts` runs model traces on the real `Documents.issue` (from a stored draft or from input) and `Documents.edit` with `patch.number`, on `DocumentsTestLayer` over the in-memory store. After each step it reads the stored documents back through `Documents.get`, asserts that the outcome, stored numbers and counters equal an executable copy of the model's serial transitions (`modelStep`), and checks every invariant on the real store (document history comes from the stored rows read after each step). It is a serial in-memory projection, not a check of concurrent Postgres behaviour. 11 hand-written traces: 10 are serial projections of traces within the TLC bounds (the issue from input among them), and 1 (an override of an override) is beyond them. The memory store enforces `number_reservations_document_fk` like Postgres (a reservation for a document with no row is a defect), so every replayed issue also checks that the document row exists before its number is reserved. Plus 100 seeded traces of 6 steps: a sampled property test, not exhaustive, that mixes issues from input and several overrides, so it checks the code against the model's serial transitions rather than against a TLC bound. The model's document revisions are tracked independently of the stored rows, and the stored revisions are asserted against them.

## Does my change touch it?

Yes, if it changes any of:

- `packages/core/src/modules/numbering/service.ts`: `allocate` (the counter-lock, format, `tryReserve`, skip, `counters.set` loop), `override`, `view`, `resolve`, `counterKey`.
- `packages/core/src/store/numbering.ts`: `reserveNumber` (used by `override`); `allocateNumber` (exported, not called: `allocate` has its own copy of the loop; keep both in step).
- `packages/core/src/store/CoreStore.ts` `counters` / `reservations` / `transaction` contracts, `packages/core/src/store/memory.ts` implementations of them.
- `packages/core/src/modules/documents/lifecycle.ts`: `numbered`, `issue`, the D4 branch of `editIssued`; `service.ts` `edit` (row lock and revision check); `record.ts` `NUMBER_PER_KIND`.
- `packages/core/src/modules/documents/support.ts` `withDraftRow` / `insertNumbered` (insert the unnumbered draft row, allocate, compare-and-set to the issued record), and their callers: `lifecycle.ts` issue from input, `credit.ts` `issueCreditNote`, `payments.ts` `issuePaymentTaxDocument`, `final.ts` `issueFinalInvoice` and `previewFinalInvoice`, `corrections.ts` `previewCorrection`.
- The `number_reservations` or `numbering_counters` keys or foreign keys in `packages/db/drizzle/**`, or a new Postgres `CoreStore`.
- Rules D1, S3, S4, D4, W3 in `docs/design/core-ports.md`.

`bun run verify:formal --check-digests` names `numbering.allocator` or `numbering.replay` when a covered file changed.

## Run

```sh
bun run verify:formal --only numbering.allocator --only numbering.replay   # PR bound, about 11 s
bun run verify:formal --wide --only numbering.allocator                    # nightly bound
```

Exit 0 means: the base model passed, each of the six mutants below failed with its declared violation, and the replay passed. TLC logs are in `formal/.cache/logs/numbering.allocator.*.log`. Read every TLC result (a counterexample from a failing base, or a mutant's trace) with the `/statechart` skill: it tells the shortest violating path as steps in plain words.

Mutants (each must fail; selected by the `Mutant` constant in the cfg):

| Mutant cfg | Breaks | Must violate |
|---|---|---|
| `Numbering_mutant_no_reservation.cfg` | `allocate` uses the counter without `tryReserve` (no reservation, no skip) | `ReservedForever` |
| `Numbering_mutant_counter_kept_on_rollback.cfg` | `counters.set` survives the rollback | `Gapless` |
| `Numbering_mutant_release_old_number.cfg` | an override frees the old number | `ReservedForever` |
| `Numbering_mutant_override_moves_counter.cfg` | an override raises the counter | `OverrideKeepsCounter` (action property) |
| `Numbering_mutant_rollback_keeps_reservation.cfg` | a rollback leaves its reservations | `NoOrphanReservation` |
| `Numbering_mutant_reserve_before_insert.cfg` | an issue from input reserves before it inserts its row (the order before F2) | `NoFkAbort` |

## How the model maps to the code

One model step is one SQL statement under Postgres READ COMMITTED on the committed schema (`packages/db/drizzle/20261123175822_init/migration.sql`):

| Model action | Code |
|---|---|
| `IDocLock` | `repo.lock(draft)` and its revision check in `issue` (`lifecycle.ts:163`) |
| `IInsert` | issue from input: `insertNumbered` → `withDraftRow` inserts the unnumbered draft row (`lifecycle.ts:187`, `support.ts:144-162`); the uncommitted row is the transaction's own, like a row lock |
| `ILock` | `store.counters.lock(key)` (`service.ts:361`), `SELECT … FOR UPDATE` on `numbering_counters` |
| `ITry` | `Numbering.format` + `store.reservations.tryReserve`; taken → `sequence++`; past `MaxSeq` → exhausted; a free key for a document with no row yet → `number_reservations_document_fk` aborts the transaction (unreachable since `IInsert`; invariant `NoFkAbort`) |
| `ISet` | `store.counters.set(key, sequence + 1)` (`service.ts:377`) |
| `IWrite` | `repo.update` of the draft row with the number (both paths; for input the compare-and-set in `insertNumbered`); `NUMBER_PER_KIND` → `Conflict{duplicate}`. An issue from input commits at revision 2 |
| `OStart` | the client reads the issued document and sends its revision as `expectedRevision` |
| `OLock` | `repo.getForUpdate(id, expectedRevision)` in `Documents.edit` (`documents/service.ts:55`): waits on the row lock, then a changed revision → `Conflict{revision_changed}`, a draft → illegal, the same number → no reservation, but the edit still commits and the revision grows by one |
| `OReserve` | `NumberingSeries.override` → `reserveNumber` → `tryReserve`; taken → `Conflict{duplicate}` |
| `OUpdate` / `OCommit` | `repo.update` with the new number, commit; the old reservation stays |
| `Crash` | a transaction that is not waiting fails; the store rolls back every write |

`tryReserve` is modeled as `INSERT … ON CONFLICT DO NOTHING` on the primary key `number_reservations(workspace_id, kind, number)`: a key another open transaction inserted makes the statement wait until that transaction ends; a conflicting key inserts no row, so no foreign key is checked.

A waiting transaction cannot crash in the model, so a wait cycle has no step out and TLC reports `Deadlock reached`. Proof that this works: a scratch copy whose `ICommit` keeps the counter lock fails with `Deadlock reached` (2026-11-24).

The in-memory store runs one top-level transaction at a time (`store/memory.ts` header) and enforces `number_reservations_document_fk` (a defect where Postgres aborts): in `tryReserve` for a free key whose document has no row in that Workspace, and in `remove` of a document a reservation references (`store.test.ts` "in-memory CoreStore: number_reservations_document_fk"). On it only serial projections of model traces exist; that is what the replay drives. A trace in which one transaction waits on another replays as the waited-on transaction finishing first.

## Bounds

- Base (`Numbering.cfg`): one issue from a stored draft `{i1}`, one issue from input `{i3}`, override `{o1}`, periods `{p1, p2}`, `MaxSeq = 3`, one document `d0` issued before the run as `<<p1, 1>>`. The override targets any stored document and any number of the series' number space, with the revision it read. 22,845 distinct states, about 3 s.
- Wide (`Numbering_wide.cfg`, nightly): issues from drafts `{i1, i2}` and from input `{i3}`. 527,834 distinct states, about 65 s (2026-11-24). A second override (an override of an override) is outside every TLC bound: with `{o1, o2}` and `{i1, i2, i3}` TLC had 28.6 million distinct states and 0.8 million queued after 30 minutes, too large even for nightly. The replay covers that case as a serial trace only.
- Two issues from drafts competing in the PR bound moved to the wide bound when the issue from input joined the base (F2): the input issue takes the same counter lock and reservation path, and 3 issuers in the base cost about 65 s.
- Deadlock is checked (see above).

## Assumptions and what is not covered

- One Workspace, one DocumentKind, one `YYYY-NNNN` series. Reservation keys carry workspace and kind, so others are separate; distinct sequences formatting to distinct numbers is `verify-vat-numbering-math`'s.
- No Postgres `CoreStore` exists yet. The base pass covers the code only if that store implements `counters.lock` as a row lock and `tryReserve` as the waiting unique insert above. The pg-contention job (`*.contention.ts`) must check that, see below.
- Not modeled: `configure` with `nextNumber` (an intended gap, W3), pattern changes, series switches, Credit Note, Payment Tax Document, Final Invoice and correction numbering (same `allocate` through the same `insertNumbered` order as the issue from input; their statement order on the real schema is the PGlite test's), exhaustion past `Numbering.MAX_COUNTER` in the replay (the model covers exhaustion at `MaxSeq`), override numbers outside the series' number space (they never meet the allocator), and S4 deadlock retries.

### For the pg-contention job

On Postgres 17, with real concurrent sessions, it should cover:
- an issue waiting on an open override reservation of its next number, then skipping the number after the override commits, and taking it after the override rolls back;
- an override waiting on an open issue reservation, then `Conflict{duplicate}`;
- an edit of a draft being issued waiting on the row lock, then `Conflict{revision_changed}`;
- two issues in one period serializing on the `numbering_counters` row, and two in different periods not blocking each other;
- a rollback after `counters.set` restoring the counter;
- `tryReserve` never aborting the transaction on a taken key (ON CONFLICT DO NOTHING, not a caught `23505`);
- an issue from input, a Credit Note, a Payment Tax Document and a Final Invoice under contention (their single-session statement order is the PGlite test's);
- the lock order (document, then counter, rule S4) never deadlocking against an override;
- S4 retries surfacing `Unavailable{database}` after three attempts.

## Findings

- **Resolved (F2, `0d117d3`): issue from input, Credit Note, PTD and Final Invoice reserved their number before their document row existed.** On Postgres `number_reservations_document_fk` (`migration.sql:926`, not deferrable) failed that insert with SQLSTATE 23503 and aborted the transaction, which also broke the `tryReserve` contract "never aborts the transaction" (`CoreStore.ts:121-125`). The previews (`previewCorrection`, `previewFinalInvoice`) allocated for a document they never inserted. Now every new numbered document goes through `insertNumbered` (draft row first, then allocate, then the compare-and-set to issued, so it ends at revision 2), and the previews insert the draft row inside their rolled-back savepoint. The model's `IInsert` makes `fk_violation` unreachable (`NoFkAbort`; mutant `reserve_before_insert` restores the old order and violates it), the memory store enforces the foreign key, and the PGlite test checks all four flows on the committed migration.

## H1: number override racing allocation

Council hypothesis H1 ("a number override racing allocation under the S3 locking order"): **refuted within the bounds, for duplicate or reused numbers**, given the modeled protocol: an atomic counter row lock, a waiting insert-only reservation key, and transaction rollback. That is a statement about the code's protocol, not evidence that a future Postgres `CoreStore` conforms to it (pg-contention job). The base explores every interleaving. Each of these was confirmed reachable:
- an issue waits in `ITry` on an override's open reservation of its next number;
- an override waits in `OReserve` on an issue's;
- an issue commits after skipping a number an override took;
- an override of a draft being issued waits on its row lock and ends in `revision_changed`.

Every invariant holds and there is no deadlock. What prevents the race:

1. `allocate` locks the period counter before it formats a candidate (`service.ts:361`), so two issues of one period never hold the same candidate; an issue from a draft holds the draft's row lock first (`lifecycle.ts:163`, rule S4).
2. Each candidate is claimed with `reservations.tryReserve` on the `(workspace, kind, number)` key, which overrides use too (`service.ts:369`; `override` → `reserveNumber`, `service.ts:386`, `store/numbering.ts:63-70`). The key is the primary key (`migration.sql:709`), and the memory store checks and inserts it in one step (`memory.ts:388-392`). Whichever transaction claims the key first wins, and the other sees it taken.
3. A taken candidate is skipped (`service.ts:376`, loop at 361) instead of reused, and the counter advances only past the claimed sequence (`service.ts:377`).
4. An override never touches the counter (`service.ts:383-395`), and reservations are insert-only, so the old number stays taken. `Documents.edit` locks the document and checks its revision before the override (`documents/service.ts:55`).
5. The documents `NUMBER_PER_KIND` index (`record.ts:236`, mapped to `Conflict{duplicate}` at `lifecycle.ts:178, 480` and in `support.ts` `insertNumbered`) is a second guard that the model also includes.

The issue from input is in the base bound and races like an issue from a draft; its own row is inserted before its counter lock, so the lock order stays document then counter (S4).

## Drift or bug?

1. Run the checks. A TLC failure: read it with `/statechart` and compare each step with the mapping table above.
2. If the steps match the code and the code breaks the property, it is a real bug. Report the counterexample in the code's terms (which transaction locked, reserved, wrote or rolled back what), with file:line. Do not weaken the invariant or the model.
3. If the code changed on purpose (a new statement, a different lock, a new caller of `tryReserve`), the model is stale. Update the action and the mapping table, rerun, and make each mutant fail again.
4. A replay failure prints the step and the model's expected outcome, stored numbers or counters next to the real ones. Disagreement with the model on a serial trace is a bug in the code or a stale mirror (`modelStep`). Decide which from D1/S3/D4 in `docs/design/core-ports.md`, not from the code.

## Update

After an intended change:
1. Edit `Numbering.tla` (keep one action per statement), then `modelStep` and the traces in the replay.
2. Rerun both checks.
3. Break the change once in the real code, see the replay fail, and revert the break.
4. Run `bun run verify:formal --update-digests --only numbering.allocator --only numbering.replay`.
5. Move the sync commit below, only after you confirm that the model describes the code at the new commit.

## Coverage record

- Sync commit: `fcb0f29` (integration: in sync, `documents/service.ts` only lost its boundary cast and `store/memory.ts` only gained the F3/F4 delivery query; model, mutants and replay rerun green). Before: `0d117d3` (F2: model, replay and this skill re-confirmed against it on 2026-11-24; the manifest's `syncCommit` and digests are updated separately with `--update-digests`). Before: `77a5bb7`.
- Tools: tla2tools 1.7.4, Java 17, Bun 1.4.2 (pins in `formal/toolchain/toolchain.json`).
- Covered files: `packages/core/src/modules/numbering/service.ts`, `packages/core/src/store/numbering.ts`, `packages/core/src/store/CoreStore.ts`, `packages/core/src/store/memory.ts` (replay), `packages/core/src/modules/documents/lifecycle.ts`, `packages/core/src/modules/documents/service.ts`, `packages/core/src/modules/documents/record.ts`, `packages/core/src/modules/documents/support.ts` (`insertNumbered`, `withDraftRow`; listed in the manifest, digest pending `--update-digests`), `packages/db/drizzle/20261123175822_init/migration.sql` (model). Digests are in the manifest.
- Able-to-fail, recorded 2026-11-24, each reverted with `git checkout` and re-run green:
  - `numbering/service.ts:376` `if (reserved)` → `if (reserved || !reserved)` (a taken candidate is used, not skipped): `--check-digests` names both checks; the replay fails 4 of 12, first at the outcome assert: after `d0` is overridden to `2026-0002`, the next issue is `Conflict{duplicate}` (the `NUMBER_PER_KIND` index) where the model issues `2026-0003`.
  - `numbering/service.ts:377` `counters.set` removed (the counter never advances): the replay fails 12 of 12 at the counter assert (model `2026: 2`, real `nextCounter` 1).
  - `documents/lifecycle.ts:422` the override's result discarded (the new number is reserved, the document keeps its old one): the replay fails 4 of 12; the stored document reads `2026-0001` where the model has the overridden number.
  - F2: `support.ts` `insertNumbered` changed back to allocate first and then `repo.insert` the issued record (reserve before insert): the replay fails 2 of 12 (the issue-from-input trace and the sampled traces) on the memory store's `number_reservations_document_fk` defect; with the memory check also disabled, the PGlite test fails 4 of 4 at its SQL replay (run before the order assertion) with Postgres `23503 … number_reservations_document_fk`.
  - Memory FK: the `tryReserve` check disabled fails `store.test.ts` "a free number for a document with no row…"; the `remove` check disabled fails "a document a reservation references cannot be removed…".
  - Model mutants: all six fail via `verify:formal` with their declared violations; a scratch copy whose `ICommit` keeps the counter lock fails with `Deadlock reached`.
