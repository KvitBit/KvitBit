---
name: verify-numbering
description: Model-check gapless document numbering (core-ports D1, S3, S4) and number overrides (D4) with TLC over every statement interleaving of competing issue and override transactions, and replay the model's traces on the real Documents.issue and Documents.edit. Use before merging any change to packages/core/src/modules/numbering/**, packages/core/src/store/numbering.ts, counters, reservations or transactions in packages/core/src/store/{CoreStore,memory}.ts, the issue, numbering and override steps of packages/core/src/modules/documents/{lifecycle,service}.ts, the documents NUMBER_PER_KIND index, the number_reservations or numbering_counters tables, or formal/numbering/**.
---

# Verify document numbering

**Property.** For every interleaving of competing issue transactions and number overrides across two counter periods, each able to roll back at any statement where it is not waiting: no two issued documents share a number, a number never moves to a second document, every number a document ever carried stays reserved, every sequence below a period's counter is reserved (no gap), every reservation belongs to a number some document carried (a rollback leaves none behind), an issue is never offered a number the documents index has to reject, the counter is exactly one past the last sequence an issue allocated, an override never moves a counter, and no set of transactions waits on each other forever.

**Harm.** Two tax documents with one number, a number given again after an override, or a gap the issuer cannot explain breaks rule D1 (gapless per series and period, every assigned number reserved forever) on documents the Workspace has already sent to customers and the tax office.

Two checks, both in `formal/manifest.json`:

- `numbering.allocator`: TLC model `formal/numbering/Numbering.tla`. A bounded model check: every state within the bounds below is explored. It describes the code, it does not run it.
- `numbering.replay`: `formal/numbering/numbering.replay.test.ts` runs model traces on the real `Documents.issue` (from a stored draft or from input) and `Documents.edit` with `patch.number`, on `DocumentsTestLayer` over the in-memory store. After each step it reads the stored documents back through `Documents.get`, asserts that the outcome, stored numbers and counters equal an executable copy of the model's serial transitions (`modelStep`), and checks every invariant on the real store (document history comes from the stored rows read after each step). It is a serial in-memory projection, not a check of concurrent Postgres behaviour. 11 hand-written traces: 9 are serial projections of traces within the TLC bounds, 1 (an override of an override) is beyond them, and 1 (an issue from input that commits) holds only in memory, where there is no foreign key. Plus 100 seeded traces of 6 steps: a sampled property test, not exhaustive, that mixes issues from input and several overrides, so it checks the code against the model's serial transitions rather than against a TLC bound. The model's document revisions are tracked independently of the stored rows, and the stored revisions are asserted against them.

## Does my change touch it?

Yes, if it changes any of:

- `packages/core/src/modules/numbering/service.ts`: `allocate` (the counter-lock, format, `tryReserve`, skip, `counters.set` loop), `override`, `view`, `resolve`, `counterKey`.
- `packages/core/src/store/numbering.ts`: `reserveNumber` (used by `override`); `allocateNumber` (exported, not called: `allocate` has its own copy of the loop; keep both in step).
- `packages/core/src/store/CoreStore.ts` `counters` / `reservations` / `transaction` contracts, `packages/core/src/store/memory.ts` implementations of them.
- `packages/core/src/modules/documents/lifecycle.ts`: `numbered`, `issue`, the D4 branch of `editIssued`; `service.ts` `edit` (row lock and revision check); `record.ts` `NUMBER_PER_KIND`.
- The `number_reservations` or `numbering_counters` keys or foreign keys in `packages/db/drizzle/**`, or a new Postgres `CoreStore`.
- Rules D1, S3, S4, D4, W3 in `docs/design/core-ports.md`.

`bun run verify:formal --check-digests` names `numbering.allocator` or `numbering.replay` when a covered file changed.

## Run

```sh
bun run verify:formal --only numbering.allocator --only numbering.replay   # PR bound, about 11 s
bun run verify:formal --wide --only numbering.allocator                    # nightly bound
```

Exit 0 means: the base model passed, each of the five mutants below failed with its declared violation, and the replay passed. TLC logs are in `formal/.cache/logs/numbering.allocator.*.log`. Read every TLC result (a counterexample from a failing base, or a mutant's trace) with the `/statechart` skill: it tells the shortest violating path as steps in plain words.

Mutants (each must fail; selected by the `Mutant` constant in the cfg):

| Mutant cfg | Breaks | Must violate |
|---|---|---|
| `Numbering_mutant_no_reservation.cfg` | `allocate` uses the counter without `tryReserve` (no reservation, no skip) | `ReservedForever` |
| `Numbering_mutant_counter_kept_on_rollback.cfg` | `counters.set` survives the rollback | `Gapless` |
| `Numbering_mutant_release_old_number.cfg` | an override frees the old number | `ReservedForever` |
| `Numbering_mutant_override_moves_counter.cfg` | an override raises the counter | `OverrideKeepsCounter` (action property) |
| `Numbering_mutant_rollback_keeps_reservation.cfg` | a rollback leaves its reservations | `NoOrphanReservation` |

## How the model maps to the code

One model step is one SQL statement under Postgres READ COMMITTED on the committed schema (`packages/db/drizzle/20261123175822_init/migration.sql`):

| Model action | Code |
|---|---|
| `IDocLock` | `repo.lock(draft)` and its revision check in `issue` (`lifecycle.ts:163`); an issue from input has no row yet and locks nothing |
| `ILock` | `store.counters.lock(key)` (`service.ts:361`), `SELECT … FOR UPDATE` on `numbering_counters` |
| `ITry` | `Numbering.format` + `store.reservations.tryReserve`; taken → `sequence++`; past `MaxSeq` → exhausted; a free key for a document with no row yet → `number_reservations_document_fk` aborts the transaction |
| `ISet` | `store.counters.set(key, sequence + 1)` (`service.ts:377`) |
| `IWrite` | `repo.update` (draft) / `repo.insert` (input) with the number; `NUMBER_PER_KIND` → `Conflict{duplicate}` |
| `OStart` | the client reads the issued document and sends its revision as `expectedRevision` |
| `OLock` | `repo.getForUpdate(id, expectedRevision)` in `Documents.edit` (`documents/service.ts:55`): waits on the row lock, then a changed revision → `Conflict{revision_changed}`, a draft → illegal, the same number → no reservation, but the edit still commits and the revision grows by one |
| `OReserve` | `NumberingSeries.override` → `reserveNumber` → `tryReserve`; taken → `Conflict{duplicate}` |
| `OUpdate` / `OCommit` | `repo.update` with the new number, commit; the old reservation stays |
| `Crash` | a transaction that is not waiting fails; the store rolls back every write |

`tryReserve` is modeled as `INSERT … ON CONFLICT DO NOTHING` on the primary key `number_reservations(workspace_id, kind, number)`: a key another open transaction inserted makes the statement wait until that transaction ends; a conflicting key inserts no row, so no foreign key is checked.

A waiting transaction cannot crash in the model, so a wait cycle has no step out and TLC reports `Deadlock reached`. Proof that this works: a scratch copy whose `ICommit` keeps the counter lock fails with `Deadlock reached` (2026-11-24).

The in-memory store runs one top-level transaction at a time (`store/memory.ts` header) and has no foreign keys. On it only serial projections of model traces exist, with the foreign-key check passing; that is what the replay drives. A trace in which one transaction waits on another replays as the waited-on transaction finishing first.

## Bounds

- Base (`Numbering.cfg`): issues from stored drafts `{i1, i2}`, override `{o1}`, periods `{p1, p2}`, `MaxSeq = 3`, one document `d0` issued before the run as `<<p1, 1>>`. The override targets any stored document and any number of the series' number space, with the revision it read. 29,127 distinct states.
- Wide (`Numbering_wide.cfg`, nightly): adds an issue from input `{i3}`. 324,673 distinct states, about 25 s. A second override (an override of an override) is outside every TLC bound: with `{o1, o2}` and `{i1, i2, i3}` TLC had 28.6 million distinct states and 0.8 million queued after 30 minutes, too large even for nightly. The replay covers that case as a serial trace only.
- Deadlock is checked (see above).

## Assumptions and what is not covered

- One Workspace, one DocumentKind, one `YYYY-NNNN` series. Reservation keys carry workspace and kind, so others are separate; distinct sequences formatting to distinct numbers is `verify-vat-numbering-math`'s.
- No Postgres `CoreStore` exists yet. The base pass covers the code only if that store implements `counters.lock` as a row lock and `tryReserve` as the waiting unique insert above. The pg-contention job (`*.contention.ts`) must check that, see below.
- The issue from input is in the wide bound only: on the committed schema it always aborts at its first free key (finding below), so it adds no behaviour to the base's invariants until that is fixed. When it is fixed, model the fix in `ITry` and move `i3` into the base.
- Not modeled: `configure` with `nextNumber` (an intended gap, W3), pattern changes, series switches, Credit Note, Payment Tax Document and correction numbering (same `allocate`, other callers), exhaustion past `Numbering.MAX_COUNTER` in the replay (the model covers exhaustion at `MaxSeq`), override numbers outside the series' number space (they never meet the allocator), and S4 deadlock retries.

### For the pg-contention job

On Postgres 17, with real concurrent sessions, it should cover:
- an issue waiting on an open override reservation of its next number, then skipping the number after the override commits, and taking it after the override rolls back;
- an override waiting on an open issue reservation, then `Conflict{duplicate}`;
- an edit of a draft being issued waiting on the row lock, then `Conflict{revision_changed}`;
- two issues in one period serializing on the `numbering_counters` row, and two in different periods not blocking each other;
- a rollback after `counters.set` restoring the counter;
- `tryReserve` never aborting the transaction on a taken key (ON CONFLICT DO NOTHING, not a caught `23505`);
- an issue from input, a Credit Note and a Payment Tax Document reserving before their row exists (the finding below);
- the lock order (document, then counter, rule S4) never deadlocking against an override;
- S4 retries surfacing `Unavailable{database}` after three attempts.

## Findings

- **Issue from input fails on Postgres (real code against the committed schema).** `Documents.issue({input})` allocates for a new document id (`lifecycle.ts:186` → `numbered` → `allocate` → `tryReserve`) before it inserts the document row (`lifecycle.ts:188`). `number_reservations_document_fk` (`migration.sql:926`, not deferrable) requires the row to exist, so the reservation insert fails with SQLSTATE 23503. `ON CONFLICT DO NOTHING` does not cover a foreign-key failure, so the transaction aborts. That also breaks the `tryReserve` contract "never aborts the transaction" (`CoreStore.ts:121-125`). Reproduced on PGlite from the committed migration: with a workspace row present, `INSERT INTO number_reservations … ON CONFLICT DO NOTHING` for a missing document fails with `23503 … number_reservations_document_fk`. The same order is in `credit.ts:389` → `400` (Credit Note) and `payments.ts:430` → `438` (Payment Tax Document), and `previewCorrection` allocates for a document it never inserts (`corrections.ts:359`, inside `rolledBack`). The memory store has no foreign keys, so tests pass. The model keeps this failure (wide bound, outcome `fk_violation`); it is reported, not patched.

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
5. The documents `NUMBER_PER_KIND` index (`record.ts:236`, mapped to `Conflict{duplicate}` at `lifecycle.ts:178, 194, 479`) is a second guard that the model also includes.

The issue-from-input path does not race; it fails outright on Postgres (Findings).

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

- Sync commit: `77a5bb7` (the product code is unchanged from there to `611b68e`).
- Tools: tla2tools 1.7.4, Java 17, Bun 1.4.2 (pins in `formal/toolchain/toolchain.json`).
- Covered files: `packages/core/src/modules/numbering/service.ts`, `packages/core/src/store/numbering.ts`, `packages/core/src/store/CoreStore.ts`, `packages/core/src/store/memory.ts` (replay), `packages/core/src/modules/documents/lifecycle.ts`, `packages/core/src/modules/documents/service.ts`, `packages/core/src/modules/documents/record.ts`, `packages/db/drizzle/20261123175822_init/migration.sql` (model). Digests are in the manifest.
- Able-to-fail, recorded 2026-11-24, each reverted with `git checkout` and re-run green:
  - `numbering/service.ts:376` `if (reserved)` → `if (reserved || !reserved)` (a taken candidate is used, not skipped): `--check-digests` names both checks; the replay fails 4 of 12, first at the outcome assert: after `d0` is overridden to `2026-0002`, the next issue is `Conflict{duplicate}` (the `NUMBER_PER_KIND` index) where the model issues `2026-0003`.
  - `numbering/service.ts:377` `counters.set` removed (the counter never advances): the replay fails 12 of 12 at the counter assert (model `2026: 2`, real `nextCounter` 1).
  - `documents/lifecycle.ts:421` the override's result discarded (the new number is reserved, the document keeps its old one): the replay fails 4 of 12; the stored document reads `2026-0001` where the model has the overridden number.
  - Model mutants: all five fail via `verify:formal` with their declared violations; a scratch copy whose `ICommit` keeps the counter lock fails with `Deadlock reached`.
