---
name: verify-numbering
description: Model-check gapless document numbering (core-ports S3, S4) and number overrides (D4) with TLC over every statement interleaving of competing issue and override transactions, and replay the model's traces on the real NumberingSeries service. Use before merging any change to packages/core/src/modules/numbering/**, packages/core/src/store/numbering.ts, counters, reservations or transactions in packages/core/src/store/{CoreStore,memory}.ts, the numbering and override steps of packages/core/src/modules/documents/lifecycle.ts, the documents NUMBER_PER_KIND index, the number_reservations or numbering_counters tables, or formal/numbering/**.
---

# Verify document numbering

**Property.** For every interleaving of two issue transactions and one number override (two overrides nightly) across two counter periods, each able to roll back at any statement: no two issued documents share a number, a number never moves to a second document, every number a document ever carried stays reserved, every sequence below a period's counter is reserved (no gap), the counter is exactly one past the last sequence an issue allocated, and an override never moves a counter.

**Harm.** Two tax documents with one number, a number given again after an override, or a gap the issuer cannot explain breaks rule D1 (gapless per series and period, every assigned number reserved forever) on documents the Workspace has already sent to customers and the tax office.

Two checks, both in `formal/manifest.json`:

- `numbering.allocator`: TLC model `formal/numbering/Numbering.tla`. A bounded model check: every state within the bounds below is explored. It describes the code, it does not run it.
- `numbering.replay`: `formal/numbering/numbering.replay.test.ts` runs the model's traces on the real `NumberingSeries.allocate` / `override` inside `CoreStore.transaction` on the in-memory store, asserts the real outcome, number and counters equal an executable copy of the model's transitions, and checks every invariant on the real store after each step. 8 hand-extracted traces, plus 200 seeded traces of 8 steps (a sampled property test, not exhaustive).

## Does my change touch it?

Yes, if it changes any of:

- `packages/core/src/modules/numbering/service.ts`: `allocate` (the counter-lock, format, `tryReserve`, skip, `counters.set` loop), `override`, `view`, `resolve`, `counterKey`.
- `packages/core/src/store/numbering.ts`: `reserveNumber` (used by `override`); `allocateNumber` (exported, not called: `allocate` has its own copy of the loop; keep both in step).
- `packages/core/src/store/CoreStore.ts` `counters` / `reservations` / `transaction` contracts, `packages/core/src/store/memory.ts` implementations of them.
- `packages/core/src/modules/documents/lifecycle.ts`: `numbered`, `issue`, the D4 branch of `editIssued`; `record.ts` `NUMBER_PER_KIND`.
- The `number_reservations` or `numbering_counters` keys in `packages/db/drizzle/**`, or a new Postgres `CoreStore`.
- Rules D1, S3, S4, D4, W3 in `docs/design/core-ports.md`.

`bun run verify:formal --check-digests` names `numbering.allocator` or `numbering.replay` when a covered file changed.

## Run

```sh
bun run verify:formal --only numbering.allocator --only numbering.replay   # PR bound, about 11 s
bun run verify:formal --wide --only numbering.allocator                    # nightly bound, about 130 s
```

Exit 0 means: the base model passed, each of the four mutants below failed with its declared violation, and the replay passed. TLC logs are in `formal/.cache/logs/numbering.allocator.*.log`. Read every TLC result (a counterexample from a failing base, or a mutant's trace) with the `/statechart` skill: it tells the shortest violating path as steps in plain words.

Mutants (each must fail; selected by the `Mutant` constant in the cfg):

| Mutant cfg | Breaks | Must violate |
|---|---|---|
| `Numbering_mutant_no_reservation.cfg` | `allocate` uses the counter without `tryReserve` (no reservation, no skip) | `ReservedForever` |
| `Numbering_mutant_counter_kept_on_rollback.cfg` | `counters.set` survives the rollback | `Gapless` |
| `Numbering_mutant_release_old_number.cfg` | an override frees the old number | `ReservedForever` |
| `Numbering_mutant_override_moves_counter.cfg` | an override raises the counter | `OverrideKeepsCounter` (action property) |

## How the model maps to the code

One model step is one SQL statement under Postgres READ COMMITTED, the store the `CoreStore` contract describes:

| Model action | Code |
|---|---|
| `ILock` | `store.counters.lock(key)` (`service.ts` `allocate`), `SELECT … FOR UPDATE` on `numbering_counters` |
| `ITry` | `Numbering.format` + `store.reservations.tryReserve`; taken → `sequence++`; past `MaxSeq` → exhausted |
| `ISet` | `store.counters.set(key, sequence + 1)` |
| `IWrite` | `repo.insert` / `repo.update` with the number; `NUMBER_PER_KIND` unique index → `Conflict{duplicate}` |
| `OLock` | `repo.getForUpdate` of the issued document before `editIssued`; same number → no override |
| `OReserve` | `NumberingSeries.override` → `reserveNumber` → `tryReserve`; taken → `Conflict{duplicate}` |
| `OUpdate` / `OCommit` | `repo.update` with the new number, commit; the old reservation stays |
| `Crash` | the transaction fails at any open statement; the store rolls back every write |

`tryReserve` is modeled as `INSERT … ON CONFLICT DO NOTHING` on the primary key `number_reservations(workspace_id, kind, number)`: a key another open transaction inserted makes the statement wait until that transaction ends.

The in-memory store runs one top-level transaction at a time (`store/memory.ts` header), so on it only serial projections of model traces exist; that is what the replay drives. A trace in which one transaction waits on another replays as the waited-on transaction finishing first.

## Bounds

- Base (`Numbering.cfg`): issuers `{i1, i2}`, overriders `{o1}`, periods `{p1, p2}`, `MaxSeq = 3`, one document `d0` issued before the run as `<<p1, 1>>`; the override picks any document and any number of the series' number space. 21,225 distinct states.
- Wide (`Numbering_wide.cfg`, nightly): overriders `{o1, o2}` (an override of an override). 1,708,647 distinct states.
- Deadlock is checked: the model stutters only once every transaction is done, so a lock or reservation wait cycle fails the base.

## Assumptions and what is not covered

- One Workspace, one DocumentKind, one `YYYY-NNNN` series. Reservation keys carry workspace and kind, so others are separate; distinct sequences formatting to distinct numbers is `verify-vat-numbering-math`'s.
- No Postgres `CoreStore` exists yet. The base pass covers the code only if that store implements `counters.lock` as a row lock and `tryReserve` as the waiting, non-aborting unique insert above. The pg-contention job (`*.contention.ts`) must check that, see below.
- Not modeled: `configure` with `nextNumber` (an intended gap, W3), pattern changes, series switches, exhaustion past `Numbering.MAX_COUNTER` in the replay (the model covers exhaustion at `MaxSeq`), override numbers outside the series' number space (they never meet the allocator), S4 deadlock retries, and the documents-level path in the replay (it calls `NumberingSeries` directly and mirrors `editIssued`'s same-number shortcut).

### For the pg-contention job

On Postgres 17, with real concurrent sessions, it should cover: an issue waiting on an open override reservation of its next number, then skipping it after the override commits and taking it after the override rolls back; an override waiting on an open issue reservation, then `Conflict{duplicate}`; two issues in one period serializing on the `numbering_counters` row and two in different periods not blocking; a rollback after `counters.set` restoring the counter; `tryReserve` never aborting the transaction on a conflict (ON CONFLICT DO NOTHING, not a caught `23505`); the issue's lock order (document, then counter, rule S4) never deadlocking against an override; and S4 retries surfacing `Unavailable{database}` after three attempts.

## H1: number override racing allocation

Council hypothesis H1 ("a number override racing allocation under the S3 locking order"): **refuted within the bounds.** The base explores every interleaving, including an issue waiting in `ITry` on an override's open reservation of its next number, an override waiting in `OReserve` on an issue's, and an issue committing after skipping a number an override took (each confirmed reachable). Every invariant holds. What prevents the race:

1. `allocate` locks the period counter before it formats a candidate (`service.ts:361`), so two issues of one period never hold the same candidate.
2. Each candidate is claimed with `reservations.tryReserve` on the `(workspace, kind, number)` key, which overrides use too (`service.ts:369`, `override` → `reserveNumber`, `service.ts:386`, `store/numbering.ts:63-70`). The key is the primary key (`migration.sql:709`), and the memory store checks and inserts it in one step (`memory.ts:388-392`). Whichever transaction claims the key first wins, and the other sees it taken.
3. A taken candidate is skipped (`service.ts:376`, loop at 361) instead of reused, and the counter advances only past the claimed sequence (`service.ts:377`).
4. An override never touches the counter (`service.ts:383-395`), and reservations are insert-only, so the old number stays taken.
5. The documents `NUMBER_PER_KIND` index (`record.ts:236`, mapped to `Conflict{duplicate}` at `lifecycle.ts:178, 194, 479`) is a second guard that the model also includes.

## Drift or bug?

1. Run the checks. A TLC failure: read it with `/statechart` and compare each step with the mapping table above.
2. If the steps match the code and the code breaks the property, it is a real bug. Report the counterexample in the code's terms (which transaction locked, reserved, wrote or rolled back what), with file:line. Do not weaken the invariant or the model.
3. If the code changed on purpose (a new statement, a different lock, a new caller of `tryReserve`), the model is stale. Update the action and the mapping table, rerun, and make each mutant fail again.
4. A replay failure prints the step and the model's expected outcome or counters next to the real ones. Disagreement with the model on a serial trace is a bug in the code or a stale mirror (`modelStep`). Decide which from S3/D4 in `docs/design/core-ports.md`, not from the code.

## Update

After an intended change: edit `Numbering.tla` (keep one action per statement), `modelStep` and the traces in the replay, rerun both checks, break the change once in the real code to see the replay fail, revert it, run `bun run verify:formal --update-digests --only numbering.allocator --only numbering.replay`, and move the sync commit below. Only move the sync commit after you confirm that the model describes the code at the new commit.

## Coverage record

- Sync commit: `77a5bb7` (the product code is unchanged from there to `611b68e`).
- Tools: tla2tools 1.7.4, Java 17, Bun 1.4.2 (pins in `formal/toolchain/toolchain.json`).
- Covered files: `packages/core/src/modules/numbering/service.ts`, `packages/core/src/store/numbering.ts`, `packages/core/src/store/CoreStore.ts`, `packages/core/src/store/memory.ts` (replay), `packages/core/src/modules/documents/lifecycle.ts`, `packages/core/src/modules/documents/record.ts`, `packages/db/drizzle/20261123175822_init/migration.sql` (model). Digests are in the manifest.
- Able-to-fail, recorded 2026-11-24, each reverted with `git checkout` and re-run green:
  - `service.ts:376` `if (reserved)` → `if (reserved || !reserved)` (a taken candidate is used, not skipped): `--check-digests` names both checks; the replay fails 5 of 9 tests, first at the outcome assert: after `d0` is overridden to `2026-0002`, the issue gets `2026-0002` instead of `2026-0003`.
  - `service.ts:377` `counters.set` removed (the counter never advances): the replay fails 9 of 9 at the counter assert (the model's counter is one higher than the real `nextCounter`).
  - Model mutants: all four fail via `verify:formal` with their declared violations.
