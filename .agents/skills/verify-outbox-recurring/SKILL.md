---
name: verify-outbox-recurring
description: "Model-check recurring issuance and the delivery outbox (one document per schedule occurrence, the schedule advance, delivery workflow start after commit, OutboxReconcile recovery, at-least-once email) with TLA+, and replay the model's paths on the real @kvitbit/core. Use before merging any change to packages/core/src/modules/recurring/**, packages/core/src/modules/documents/deliveries/**, CoreStore.afterCommit or transaction frames in packages/core/src/store/, formal/outbox/**, or the J1-J4 rules in docs/design/core-ports.md, and when an email or a recurring invoice goes missing or out twice."
---

# Verify the recurring issuance outbox

ADR-0005 Tier 1 check for `@kvitbit/core` (core-ports 7.2, 7.3 and rules J1-J4). Two checks:

- `outbox.recurring`: a bounded TLC run of `formal/outbox/OutboxRecurring.tla`. Within its bounds it covers every interleaving of recurring job runs, crashes, duplicate starts and provider failures.
- `outbox.replay`: `formal/outbox/outbox.replay.test.ts` drives the real core (`CoreModulesLive` on TestCore's memory ports and fakes) along the model's paths. Each test name lists the model actions it replays.

Terms: a bounded TLC pass is verification within the stated bounds. The replay tests are example tests of the real code, not verification.

## Run

From the repo root (TLC 1.7.4 and JDK 17 come from `formal/toolchain/`; Bun 1.4.2 per `packageManager`, last run with Bun 1.4.4):

```sh
bun run verify:formal --only outbox.recurring --only outbox.replay
```

Expected: `PASSED: 2 passed`, about 13 s. The base passes, all five mutants report a violation, and the replay gives 9 pass, 0 fail. The base explores 2,415 distinct states; the TLC log's last line gives that count. The runner prints the count from TLC's first progress line, so it can show fewer. The nightly wide bounds run with `bun run verify:formal --wide --only outbox.recurring` (about 110 s, 124,811 distinct states). To run one harness alone: `bun test ./formal/outbox/outbox.replay.test.ts`. TLC logs are in `formal/.cache/logs/outbox.recurring.*.log`.

Read every TLC result, pass or counterexample, with the `/statechart` skill. Run it on `formal/outbox/OutboxRecurring.tla` with the config in question, from a scratch folder outside the repo. Its report gives the shortest path to each broken rule as steps in plain words. A view module that labels the states per occurrence ("email queued", "email claimed", "delivery job died") makes the paths readable. The base has more states than the chart budget, so `/statechart` draws only bug paths.

## Does my change touch this?

Yes, if the diff touches a file below, or anything that changes what one transaction does in it. That includes the schedule row lock, `updateSchedule`'s revision check, the `schedule_runs` or `documents(schedule_id, occurrence)` unique indexes, the order of writes inside `issue` or `send`, where `jobs.start` is called, and how `claim`, `dispatch`, `giveUp` or `deliver` treat each status. `formal/manifest.json` lists the exact `coveredFiles` with sha256s. `bun run verify:formal --check-digests` names a covered file that changed.

| Covered file (packages/core/src/) | Guarded symbols |
|---|---|
| `modules/recurring/issuance.ts` | `RecurringIssuance.issue` (239-312), `.send` (315-359), `.run` (363), `.pendingSends` (393), `.sweep` (410) |
| `modules/recurring/repo.ts`, `sweep.ts` | `lockSchedule`, `updateSchedule` (CAS), `findRun`/`insertRun`/`updateRun`, `pendingSendRuns`, `issueEligibility`, `occurrenceAfter` |
| `modules/documents/deliveries/send.ts` | the queued insert (210), `afterCommit(jobs.start(...))` (242) |
| `modules/documents/deliveries/steps.ts` | `claim` (67), `dispatch` (84), the record transaction (122-143), `giveUp` (158), `deliver` (171) |
| `modules/documents/deliveries/jobs.ts`, `repo.ts` | `DeliveryJobs.start`, `DeliveriesRepo.lock`/`update` |
| `store/memory.ts`, `store/CoreStore.ts` | `transaction` frames: rollback (162-165), hooks passed to the parent (166-168), `drainAfterCommit` after the outermost commit (180-197); `afterCommit` |

## What it promises

Each property is declared in `OutboxRecurring.cfg` (and `_wide.cfg`).

| Property | Promise | Harm if broken |
|---|---|---|
| `OneDocumentPerOccurrence` | A schedule issues at most one document per occurrence, across concurrent runs, retries and crashes. | The customer is billed twice and a document number is used up. |
| `NextFollowsIssued` | `next_occurrence` advances by compare-and-set, one occurrence per issued document. | An occurrence is skipped (never billed) or billed again. |
| `OneDeliveryPerOccurrence` | An issued run queues one delivery, and its run row records it. | The invoice email goes out twice, or the run shows no delivery. |
| `StartedOnlyCommitted` | A DocumentDelivery workflow starts only for a delivery row that committed (J1). | A workflow runs for a delivery that rolled back. |
| `SentImpliesAccepted` | A delivery is marked `sent` only after the provider accepted it. | The app shows "sent" for an email that never left. |
| `EveryOccurrenceIssued` (liveness) | Every due occurrence eventually gets its document. | A recurring invoice silently never appears. |
| `NoLostSend` (liveness) | Every occurrence's email ends `sent` or `failed` after a rejection or giveUp. It is never left `queued` or `sending` (at least once, duplicates allowed). | An invoice is issued and the customer never gets the email, with nothing visible failing. |

Model actions and the code they stand for. Each is one transaction or one external call:

- `SweepStart`, `DupStart`: RecurringSweep starts `run` for the next occurrence. A duplicate or stale start is a workflow retry, a second tick, or a run that read an older `next_occurrence`.
- `IssueCommit`: the issue transaction. It takes the lock, then replays an issued run or skips an ineligible one. Otherwise it calls `Documents.issue` plus `links.link` (savepoint), upserts the run as `issued`/`pending`, and advances `next_occurrence` with CAS.
- `SendCommit`: the send transaction. Under the lock, `Documents.send` (savepoint) inserts a `queued` delivery and registers `afterCommit(jobs.start)`, and the run records `queued`. A queued run replays.
- `Hook`: the afterCommit drain starts DocumentDelivery, keyed by the delivery id. A start for a live execution attaches to it, so the model gives each delivery one execution slot.
- `Claim`, `Dispatch(ok | not_accepted | unknown | rejected)`, `Record`, `GiveUp`: the delivery steps. `unknown` means the provider got the message but the call reported a failure.
- `ReconcileRecurring`: OutboxReconcile through `pendingSends`, which reruns `run`. `ReconcileDelivery`: OutboxReconcile (J1a) re-executes `deliver` for a `queued` or `sending` delivery whose execution is not live.
- `CrashWorker`, `CrashDelivery`: a process dies. Open transactions roll back and pending afterCommit hooks are lost. The crash points are a recurring job (any step), and a delivery execution at `claim`, `dispatch` (claimed, before the provider call: H3), `record` (after the provider call) and `giveup`.

## Hypothesis H3 (crash between claim and send): REFUTED, bounded, assuming the J1a reconcile

The base run covers every placement of up to 2 crashes, including a crash at `dispatch`, and `NoLostSend` holds. The code that prevents the loss is:

1. `claim` changes only `queued` rows (`steps.ts:73`). A `sending` row stays `sending`, and `claim` returns it.
2. `deliver` dispatches any non-terminal status (`steps.ts:171-174`).
3. `dispatch` sends a `sending` row (`steps.ts:88`) with `idempotencyKey: row.id` (`steps.ts:115`), so a re-dispatch reuses the original key.

The replay test "H3: ..." shows it on the real code. After `claim` the row is `sending` and the provider has 0 attempts. `deliver` then sends it once, with the delivery id as key.

**Gap: core has nothing that re-starts the delivery.** At 77a5bb7, core has no OutboxReconcile query for `queued` or `sending` deliveries. `DeliveriesRepo` (`modules/documents/deliveries/repo.ts:21-62`) offers no cross-tenant pending-rows query; only `recurring/repo.ts` `pendingSendRuns` exists for the recurring half. The database has `deliveries_pending_idx` (`packages/db/drizzle/20261123175822_init/migration.sql:826`), but no core code reads it. Workflows and crons are "defined later" (`issuance.ts:2-3`, `jobs.ts:3-4`). Until integration adds that cron, the H3 crash loses the email. Mutant `no-reconcile-h3` gives that path (6 steps, as `/statechart` reports it):

1. A run of occurrence #1 starts, the issue transaction commits, and the send transaction queues the email.
2. The delivery job starts after commit.
3. The job claims the email (`sending`).
4. The job's process dies before the provider call.
5. The delivery stays `sending` forever.

A crash between the send commit and the workflow start leaves the delivery `queued` forever (mutant `no-reconcile-lost-start`; replay "CrashWorker before Hook"). Integration must implement J1a for deliveries, and this check assumes it does.

## Mutants (each must fail)

All are `.cfg` files over the same spec. Each turns off guards through constants, so the base is the code and every mutant is one break.

| Mutant | Guard removed | Fails with |
|---|---|---|
| `no-occurrence-guard` | `LockSchedule`, `CasAdvance`, `UniqueLink` (each alone is enough to keep the invariant) | `OneDocumentPerOccurrence`: two runs read `next = 1`, both issue |
| `no-replay-guard` | `ReplayGuard` (`issuance.ts:246-248`) | `NoLostSend`: a crash after the issue commit; every rerun is Skipped `not_next`, so the send is never queued |
| `start-before-commit` | `StartAfterCommit` (`send.ts:242`) | `StartedOnlyCommitted`: the job starts, then the send transaction rolls back |
| `no-reconcile-h3` | `DeliveryReconcile`, crash only at `dispatch` | `NoLostSend`: the path above (deadlock allowed so TLC reports the liveness break) |
| `no-reconcile-lost-start` | `DeliveryReconcile`, crash only in a recurring job | `NoLostSend`: the afterCommit start is lost, the delivery stays `queued` |

Temporal mutants declare only `NoLostSend` under `PROPERTIES`, so their temporal violation can only be that property.

## Bounds and assumptions

- Base: 1 occurrence, 2 recurring workers, 2 crashes at any crash point, 1 duplicate or stale start, 1 provider failure, and 1 dispatch attempt per execution (so one retryable failure leads to giveUp). Wide (nightly): 2 occurrences, same budgets. Mutants run with 1 occurrence and 1 crash.
- Fairness is per component: the sweep and the recurring reconcile get strong fairness (lock waits make them flicker), the delivery reconcile, each job execution and each delivery execution get weak fairness. Crashes, duplicate starts and provider failures get no fairness and are bounded.
- Each transaction is one atomic step, which holds because the schedule row lock serializes them and the memory store runs one transaction at a time (`memory.ts:196`). Postgres locking is not checked.
- J3 re-checks (document cancelled, reminder no longer due), pauses on Documents failures, the catch-up cap, detach and edits are left out: the document stays sendable and the schedule active. Reminders and invitations are not modelled.
- The provider is assumed not to dedupe, so `smtp` counts every acceptance. The CaptureEmailSender fake does dedupe by key, and the replay asserts the key.
- DocumentDelivery attach-by-key is modelled from J1, because no workflow is defined in core yet.

## Replay harness and seams

The replay tests use TestCore's `InMemoryCorePorts`, `CoreReposMemory` and `TestCoreFakes` under the real `CoreModulesLive`, with a TestClock at 2026-11-23T09:00Z. The crash seams all exist in the code:

- A `RecurringRepo` wrapper whose `updateRun` dies once inside the send transaction.
- A `DeliveryJobs` whose `start` dies: the hook failure is only logged, and the commit stands. The test prints a `CoreStore.afterCommit failed` log line on purpose.
- An `EmailSender` wrapper that dies after the provider accepted.
- For H3, the dispatch step is simply not run after `claim`.

Seams that core lacks (do not patch product code for them; integration owns them):

- No J1a query for `queued`/`sending` deliveries. The harness plays OutboxReconcile by calling `DocumentsModule.deliver(workspaceId, deliveryId)`.
- The System caller seal (`packages/core/src/internal/system.ts`) is in no package export, so `formal/tsconfig.json` cannot map it. The harness imports `systemCaller` by relative path, the way core's own tests do.
- No workflow engine in core, so attach-by-key and Activity retries are not exercised. The harness calls `deliver`, `dispatch` and `giveUp` itself.

The pg-contention job (`*.contention.ts`) should later cover:

- Two `issue` transactions, and `issue` against `send`, on one schedule under `SELECT ... FOR UPDATE`.
- The `updateSchedule` revision CAS, and the `schedule_runs` and `documents(schedule_id, occurrence)` unique indexes, under READ COMMITTED.
- A `claim` row lock against a concurrent record transaction.
- A reconcile re-dispatch that overlaps a live dispatch (two dispatches read `sending`).
- afterCommit hooks firing only after the real COMMIT, never inside a savepoint.
- `pendingSendRuns` and the future delivery reconcile query racing a committing send.

## When a check fails

- **Base violation (exit 12/13 on `OutboxRecurring.cfg`)**: read the path with `/statechart`, then replay it in `outbox.replay.test.ts` one step per action. If the real code does it too, it is a bug. Report the counterexample in the code's nouns and keep the property strict. If the real code does not, the model drifted from the code; fix the model and say which action was wrong.
- **A mutant passes**: the model no longer depends on that guard, usually because an edit made the guard's action unreachable. Fix the model.
- **A replay test fails**: compare its steps with the action list above. A deliberate behavior change (for example claim now skipping `sending` rows) is drift: update the model action, the replay and this skill in one change. Anything else is a bug.
- **Digest drift only** (`--check-digests`): run `/maintain-formal-verification-skill` and classify the check as in sync, updated, bug or blocked.

## Updating

1. For an intended change, update the action in `OutboxRecurring.tla` (cite file:line), the matching replay test, and this skill in the same change.
2. Rerun both checks, `bun run verify:formal --wide --only outbox.recurring`, and the able-to-fail breaks below for the actions you touched.
3. Run `bun run verify:formal --update-digests --only outbox.recurring --only outbox.replay`, in a commit separate from product fixes.
4. Move the sync commit only after you confirm that the model describes the covered code at the new commit.

## Coverage record

- Sync commit: `77a5bb7` (product code unchanged at 611b68e). Tools: tla2tools 1.7.4, Java 17 (Temurin 17.0.21.1), Bun 1.4.4.
- Runs on 2026-11-24 from the repo root, all exit 0:

  | Command | Result |
  |---|---|
  | `bun run verify:formal --only outbox.recurring --only outbox.replay` | 12.9 s. Base passed with 2,415 distinct states (5.6 s). `no-occurrence-guard` breaks `OneDocumentPerOccurrence` after 51 states; `no-replay-guard` is a temporal violation after 551 states; `start-before-commit` breaks `StartedOnlyCommitted` after 13; `no-reconcile-h3` is temporal after 157; `no-reconcile-lost-start` is temporal after 310. Replay: 9 pass. |
  | `bun run verify:formal --wide --only outbox.recurring` | Wide base passed with 124,811 distinct states (99.7 s; 109.3 s with the mutants). |
  | The no-occurrence-guard config with only one of `LockSchedule`, `CasAdvance`, `UniqueLink` on (three TLC runs) | Each passes every property: any one guard keeps one document per occurrence. |

- `/statechart` paths, read for every mutant: `no-occurrence-guard`, 4 steps (two runs both issue #1); `no-replay-guard`, 8 steps, ending in a loop where reconcile reruns and each rerun is Skipped; `start-before-commit`, 3 steps; `no-reconcile-h3`, 6 steps, ending "email claimed (delivery job died)" forever; `no-reconcile-lost-start`, 4 steps, ending "email queued (no delivery job)" forever.
- Able-to-fail gate on the real code (scratch break, run `bun test ./formal/outbox/outbox.replay.test.ts`, `git checkout` the file, 9 pass again):

  | Break | File | Caught by |
  |---|---|---|
  | Replay guard off: `if (false && Option.isSome(existing))` | `modules/recurring/issuance.ts:246` | 3 fail: "DupStart, IssueCommit(replay)...", "CrashWorker after IssueCommit, ReconcileRecurring...", "CrashWorker inside SendCommit..." (the rerun is Skipped) |
  | Delivery started inside the transaction: `yield* jobs.start(...)` without `afterCommit` | `modules/documents/deliveries/send.ts:242` | 2 fail: "CrashWorker inside SendCommit..." (`started` has the rolled-back id: expected length 0, received 1), "CrashWorker before Hook..." |
  | Reconcile recovery off: `claim` returns `skipped` for a `sending` row | `modules/documents/deliveries/steps.ts:73` | 2 fail: "H3: ..." and "CrashDelivery(record)..." (nothing re-sends the claimed email) |
