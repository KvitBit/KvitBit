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

Expected: `PASSED: 2 passed`, about 40 s. The base passes, all eleven mutants report a violation, and the replay gives 11 pass, 0 fail. The base explores 9,281 distinct states; the TLC log's last line gives that count. The nightly wide bounds run with `bun run verify:formal --wide --only outbox.recurring` (about 3 minutes, 195,456 distinct states). To run one harness alone: `bun test ./formal/outbox/outbox.replay.test.ts`. TLC logs are in `formal/.cache/logs/outbox.recurring.*.log`.

Read every TLC result, pass or counterexample, with the `/statechart` skill. Run it on `formal/outbox/OutboxRecurring.tla` with the config in question, from a scratch folder outside the repo. Its report gives the shortest path to each broken rule as steps in plain words. A view module that labels the states per occurrence ("email queued", "email claimed", "delivery job died") makes the paths readable. The base has more states than the chart budget, so `/statechart` draws only bug paths.

## Does my change touch this?

Yes, if the diff touches a file below, or anything that changes what one transaction does in it. That includes the schedule row lock, `updateSchedule`'s revision check, the `schedule_runs` or `documents(schedule_id, occurrence)` unique indexes, the order of writes inside `issue` or `send`, where `jobs.start` is called, and how `claim`, `dispatch`, `giveUp` or `deliver` treat each status. `formal/manifest.json` lists the exact `coveredFiles` with sha256s. `bun run verify:formal --check-digests` names a covered file that changed.

| Covered file (packages/core/src/) | Guarded symbols |
|---|---|
| `modules/recurring/issuance.ts` | `RecurringIssuance.issue` (239-312), `.send` (315-359), `.run` (363), `.pendingSends` (393), `.sweep` (410) |
| `modules/recurring/repo.ts`, `sweep.ts` | `lockSchedule`, `updateSchedule` (CAS), `findRun`/`insertRun`/`updateRun`, `pendingSendRuns`, `issueEligibility`, `occurrenceAfter` |
| `modules/documents/deliveries/send.ts` | the queued insert (210), `afterCommit(jobs.start(...))` (242) |
| `modules/documents/deliveries/steps.ts` | `claim` (73), `dispatch` (101), the record transaction (139-160), `giveUp` (175), `deliver` (188), `reconcileStaleDeliveries` (208) |
| `modules/documents/deliveries/jobs.ts`, `repo.ts` | `DeliveryJobs.start`, `DeliveriesRepo.lock`/`update`/`findStaleQueuedOrSending` |
| `modules/recurring/links.ts`, `modules/documents/record.ts` | `RecurringDocumentLink.link`, the `documents(schedule_id, occurrence)` unique key (`record.ts:241`) |
| `store/memory.ts`, `store/CoreStore.ts` | `transaction` frames: rollback (166-169), hooks passed to the parent (172-174), `drainAfterCommit` after the outermost commit (184-196); `afterCommit` |

## What it promises

Each property is declared in `OutboxRecurring.cfg` (and `_wide.cfg`).

| Property | Promise | Harm if broken |
|---|---|---|
| `OneDocumentPerOccurrence` | A schedule issues at most one document per occurrence, across concurrent runs, retries and crashes. | The customer is billed twice and a document number is used up. |
| `NextFollowsIssued` | `next_occurrence` advances by compare-and-set, one occurrence per issued document. | An occurrence is skipped (never billed) or billed again. |
| `OneDeliveryPerOccurrence` | An issued run queues one delivery, and its run row records it. | The invoice email goes out twice, or the run shows no delivery. |
| `StartedOnlyCommitted` | A DocumentDelivery workflow starts only for a delivery row that committed (J1). | A workflow runs for a delivery that rolled back. |
| `SentImpliesAccepted` | A delivery is marked `sent` only after the provider accepted it. An `outcome_unknown` reply is explored both ways (taken, not taken), so recording it as sent breaks this. | The app shows "sent" for an email that never left. |
| `FailedOnlyAfterCall` | A delivery is marked `failed` only after a provider call. | An email is given up without ever being tried; `NoLostSend` alone would accept that. |
| `FailedOnlyWhenJustified` | ... and only because the provider rejected it, or an execution used up its `MaxAttempts` retryable attempts; never while a retry remains. | A transient provider hiccup fails an invoice email for good. |
| `EveryOccurrenceIssued` (liveness) | Every due occurrence eventually gets its document. | A recurring invoice silently never appears. |
| `NoLostSend` (liveness) | Every occurrence's email ends `sent` or `failed` after a rejection or giveUp. It is never left `queued` or `sending` (at least once, duplicates allowed). | An invoice is issued and the customer never gets the email, with nothing visible failing. |

Model actions and the code they stand for. Each is one transaction or one external call:

- `SweepStart`, `DupStart`: RecurringSweep starts `run` for the next occurrence. A duplicate or stale start is a workflow retry, a second tick, or a run that read an older `next_occurrence`.
- `IssueCommit`: the issue transaction. It takes the lock, then replays an issued run or skips an ineligible one. Otherwise it calls `Documents.issue` plus `links.link` (savepoint), upserts the run as `issued`/`pending`, and advances `next_occurrence` with CAS.
- `SendCommit`: the send transaction. Under the lock, `Documents.send` (savepoint) inserts a `queued` delivery and registers `afterCommit(jobs.start)`, and the run records `queued`. A queued run replays.
- `Hook`: the afterCommit drain starts DocumentDelivery, keyed by the delivery id. A start for a live execution attaches to it, so the model gives each delivery one execution slot.
- `Claim`, `Dispatch(ok | not_accepted | unknown_sent | unknown_lost | rejected)`, `Record`, `GiveUp`: the delivery steps. `unknown_sent` and `unknown_lost` both report `outcome_unknown`; the provider took the message in the first and not in the second.
- `ReconcileRecurring`: OutboxReconcile through `pendingSends`, which reruns `run`. `ReconcileDelivery`: `reconcileStaleDeliveries` (J1a) selects `queued` and `sending` rows through `findStaleQueuedOrSending` and calls `DeliveryJobs.start` with the delivery id; the restarted job runs `deliver`. A start for a live execution attaches to it, so the action fires only for a delivery whose execution is not live.
- `CrashWorker`, `CrashDelivery`: a process dies. Open transactions roll back and pending afterCommit hooks are lost. The crash points are a recurring job (any step), and a delivery execution at `claim`, `dispatch` (claimed, before the provider call: H3), `record` (after the provider call) and `giveup`.

## Hypothesis H3 (crash between claim and send): fixed at 154383a

- **Confirmed at core scope (77a5bb7):** core had no restart path for a claimed delivery, and nothing in core ever sent it again.
- **Fixed at 154383a:** `reconcileStaleDeliveries` (`steps.ts:208`) over `DeliveriesRepo.findStaleQueuedOrSending` (`repo.ts`) is the delivery half of OutboxReconcile (core-ports J1a). Integration runs it from the OutboxReconcile cron with a 2-minute threshold.
- **Refuted, bounded, for the code at 154383a:** the base pass below.

The path at 77a5bb7. A delivery job dies after `claim` committed `sending` and before the provider call:

1. A recurring run issues the occurrence; the send transaction queues the delivery and records the run `send: "queued"` (`issuance.ts:351-355`); the job starts after commit.
2. The job's `claim` moves the delivery `queued -> sending` (`steps.ts:73-98`).
3. The job's process dies before `dispatch` calls the provider.
4. The recurring reconcile skips the run: `pendingSendRuns` selects only runs with `send: "pending"` (`recurring/repo.ts:300-305`). A rerun of the occurrence replays `Queued` without starting a job (`issuance.ts:326-328`). The sweep has nothing due.
5. Core had no query for `queued` or `sending` deliveries, so the delivery stayed `sending` and the provider got no call. A crash between the send commit and the job start stranded the delivery `queued` in the same way.

How the reconcile recovers it. A row is stale when its `updatedAt` is older than the threshold. `claim` and every recorded dispatch attempt advance `updatedAt`, so a job that is still working is selected only after it has been silent for the threshold, and its restart attaches to the live execution by key (J1). The restarted job runs `deliver`:

1. `claim` re-checks eligibility for a `queued` or `sending` row (J3, `steps.ts:79-81`): a queued row becomes `sending`, a `sending` row stays `sending`, and an ineligible row (document cancelled meanwhile) is `skipped` before any further provider call. A skipped `sending` row keeps `lastOutcome: outcome_unknown`, because the job may have died after the provider accepted it, so an automatic reminder's step stays taken (`record.ts` `isReleased`; test "a claimed reminder skipped on restart keeps its step" in `reminders.test.ts`). The model leaves J3 out (the document stays sendable), so it sees only the first two.
2. `deliver` dispatches any non-terminal status (`steps.ts:188-191`).
3. `dispatch` sends a `sending` row (`steps.ts:105`) with `idempotencyKey: row.id` (`steps.ts:132`).

Evidence: the replay test "H3: Claim, CrashDelivery(dispatch), ReconcileRecurring, SweepStart, ReconcileDelivery, ..." runs steps 1-4, shows that two `pendingSends` passes, a rerun and a sweep tick still find no work, then runs the real reconcile pass: it restarts the delivery, the email goes out once with the delivery id as key, and a second pass restarts nothing. In the model, mutants `no-reconcile-h3` and `no-reconcile-lost-start` remove the reconcile and break `NoLostSend`. Product tests for the threshold, the cross-Workspace selection and a failing start are in `packages/core/test/modules/documents/deliveries/reconcile.test.ts`.

## Mutants (each must fail)

All are `.cfg` files over the same spec. Each flips flags (constants). Most are a single break. `no-occurrence-guard` is a compound break (three guards at once; the single-guard runs in the coverage record show each guard alone suffices). The `no-reconcile-*` mutants remove `reconcileStaleDeliveries` (the code before 154383a). Mutants run with 1 occurrence, 1 crash, 1 provider failure and 1 attempt unless noted.

| Mutant | Break | Fails with |
|---|---|---|
| `no-occurrence-guard` | `LockSchedule`, `CasAdvance`, `UniqueLink` off (each alone keeps the invariant) | `OneDocumentPerOccurrence`: two runs read `next = 1`, both issue |
| `no-replay-guard` | `ReplayGuard` off (`issuance.ts:246-248`) | `NoLostSend`: a crash after the issue commit; every rerun is Skipped `not_next`, so the send is never queued |
| `start-before-commit` | `StartAfterCommit` off (`send.ts:242`) | `StartedOnlyCommitted`: the job starts, then the send transaction rolls back |
| `no-reconcile-h3` | `DeliveryReconcile` off (`steps.ts:208` removed), crash only at `dispatch` | `NoLostSend`: the H3 path above (deadlock allowed so TLC reports the liveness break) |
| `no-reconcile-lost-start` | `DeliveryReconcile` off, crash only in a recurring job | `NoLostSend`: the afterCommit start is lost, the delivery stays `queued` |
| `no-send-replay-guard` | `SendReplayGuard` off (`issuance.ts:326-332`: the queued replay and the pending-only check) | `OneDeliveryPerOccurrence`: a second run queues a second delivery |
| `skip-occurrence` | `AdvanceBy = 2` (2 occurrences, no crash) | `NextFollowsIssued`: occurrence 2 is before `next` but never issued |
| `skip-occurrence-liveness` | as `skip-occurrence`, liveness only (deadlock allowed) | `EveryOccurrenceIssued` |
| `claim-fails` | `ClaimFailsQueued`: claim marks a queued delivery `failed` | `FailedOnlyAfterCall` (the reviewer's case: `NoLostSend` alone passes it) |
| `record-unknown-as-sent` | `RecordUnknownAsSent`: record stores `outcome_unknown` as `sent` | `SentImpliesAccepted`: `unknown_lost` recorded `sent` |
| `give-up-early` | `GiveUpEarly`, with `MaxAttempts = 2`: the first retryable failure gives up | `FailedOnlyWhenJustified` (the reviewer's round 2 case: every other property passes it) |

Temporal mutants declare only the one liveness property they target under `PROPERTIES`, so their temporal violation can only be that property.

## Bounds and assumptions

- Base: 1 occurrence, 2 recurring workers, 2 crashes at any crash point, 1 duplicate or stale start, 2 provider failures (any of the 4 failure outcomes), and 2 dispatch attempts per execution, so both a retry and a giveUp are reachable. Wide (nightly): 2 occurrences, 1 provider failure, 2 attempts.
- Fairness is per component: the sweep and the recurring reconcile get strong fairness (lock waits make them flicker), the delivery reconcile, each job execution and each delivery execution get weak fairness. Crashes, duplicate starts and provider failures get no fairness and are bounded.
- Bundled steps: a start (sweep, duplicate or reconcile) is bundled with the job's entry into the issue transaction. Dispatch's row read, render and provider call are one step; a crash between the read and the call is the same state as a crash before the read. Neither split adds a state the model can tell apart.
- One execution slot per delivery: a re-start attaches to a live execution (J1, by key), so two overlapping dispatches of one delivery are not modelled. They could only add provider duplicates, which `NoLostSend` allows. The pg-contention list covers the overlap.
- Each transaction is one atomic step, which holds because the schedule row lock serializes them and the memory store runs one transaction at a time (`memory.ts:202`). Postgres locking is not checked.
- J3 re-checks (document cancelled, reminder no longer due), pauses on Documents failures, the catch-up cap, detach and edits are left out: the document stays sendable and the schedule active. Reminders and invitations are not modelled.
- `DeliveryReconcile = TRUE` in the base is `reconcileStaleDeliveries`. The model has no clock: the staleness threshold only delays the action, so the model lets it fire at any time once the delivery's execution is not live. Whether integration schedules the cron is not checked.
- The provider is assumed not to dedupe, so `smtp` counts every acceptance. The CaptureEmailSender fake does dedupe by key, and the replay asserts the key.
- DocumentDelivery attach-by-key is modelled from J1, because no workflow is defined in core yet. `DeliveryJobs.start` must give a restart of a live execution no second execution, and must run `deliver` again when it finds a finished execution while the row is still `queued` or `sending` (a workflow that failed after `claim`; Effect's `Workflow.execute` would only return the stored exit). The model's `ReconcileDelivery` assumes both. Integration owns that binding (`jobs.ts` doc), and no core check covers it.

## Replay harness and seams

The replay tests use TestCore's `InMemoryCorePorts`, `CoreReposMemory` and `TestCoreFakes` under the real `CoreModulesLive`, with a TestClock at 2026-11-23T09:00Z. The crash seams all exist in the code:

- A `RecurringRepo` wrapper whose `updateRun` dies once inside the send transaction.
- A `DeliveryJobs` whose `start` dies: the hook failure is only logged, and the commit stands. The test prints a `CoreStore.afterCommit failed` log line on purpose.
- An `EmailSender` wrapper that dies after the provider accepted.
- For H3 and the crash before giveUp (after one, and after two retryable failures, the base's `MaxAttempts`), the next step is simply not run.

`ReconcileDelivery` is the real `reconcileStaleDeliveries(120_000)` after `TestClock.adjust("3 minutes")`. TestCore's `DeliveryJobsMemory` only records starts, so the harness then runs `deliver` for each delivery the pass started (Hook). The lost-start test passes a recording `DeliveryJobs` to the pass, because its scenario's `DeliveryJobs` always dies.

The job's sealed System caller is the one a RecurringSweep tick hands to its `start` callback (`issuance.ts:425`), so the harness needs no internal import.

Seams that core lacks (do not patch product code for them; integration owns them):

- No workflow engine in core, so attach-by-key and Activity retries are not exercised. The harness calls `deliver`, `dispatch` and `giveUp` itself.

The pg-contention job (`*.contention.ts`) should later cover:

- Two `issue` transactions, and `issue` against `send`, on one schedule under `SELECT ... FOR UPDATE`.
- The `updateSchedule` revision CAS, and the `schedule_runs` and `documents(schedule_id, occurrence)` unique indexes, under READ COMMITTED.
- A `claim` row lock against a concurrent record transaction.
- A reconcile re-dispatch that overlaps a live dispatch (two dispatches read `sending`).
- afterCommit hooks firing only after the real COMMIT, never inside a savepoint.
- `pendingSendRuns` and `findStaleQueuedOrSending` racing a committing send.

## When a check fails

- **Base violation (exit 12/13 on `OutboxRecurring.cfg`)**: read the path with `/statechart`, then replay it in `outbox.replay.test.ts` one step per action. If the real code does it too, it is a bug. Report the counterexample in the code's nouns and keep the property strict. If the real code does not, the model drifted from the code; fix the model and say which action was wrong.
- **A mutant passes**: the model no longer depends on that guard, usually because an edit made the guard's action unreachable. Fix the model.
- **The H3 replay fails before its reconcile pass**: a recurring entry point (pendingSends, the rerun, the sweep) now starts a claimed delivery. Check that this is intended and update the test and the H3 section. If it fails after the pass, the delivery reconcile no longer recovers the delivery: treat it as a bug.
- **A replay test fails**: compare its steps with the action list above. A deliberate behavior change (for example claim now skipping `sending` rows) is drift: update the model action, the replay and this skill in one change. Anything else is a bug.
- **Digest drift only** (`--check-digests`): run `/maintain-formal-verification-skill` and classify the check as in sync, updated, bug or blocked.

## Updating

1. For an intended change, update the action in `OutboxRecurring.tla` (cite file:line), the matching replay test, and this skill in the same change.
2. Rerun both checks, `bun run verify:formal --wide --only outbox.recurring`, and the able-to-fail breaks below for the actions you touched.
3. Run `bun run verify:formal --update-digests --only outbox.recurring --only outbox.replay`, in a commit separate from product fixes.
4. Move the sync commit only after you confirm that the model describes the covered code at the new commit.

## Coverage record

- Sync commit: `154383a` (the delivery reconcile; the recurring side is unchanged since `77a5bb7`). Tools: tla2tools 1.7.4, Java 17 (Temurin 17.0.21.1), Bun 1.4.4.
- Runs on 2026-11-24 from the repo root at 154383a plus the verification update, all exit 0:

  | Command | Result |
  |---|---|
  | `bun run verify:formal --only outbox.recurring --only outbox.replay` | 37.9 s. Base passed with 9,281 distinct states (6.4 s). Mutants: `no-occurrence-guard` -> `OneDocumentPerOccurrence`; `no-replay-guard` -> temporal; `start-before-commit` -> `StartedOnlyCommitted`; `no-reconcile-h3` -> temporal; `no-reconcile-lost-start` -> temporal; `no-send-replay-guard` -> `OneDeliveryPerOccurrence`; `skip-occurrence` -> `NextFollowsIssued`; `skip-occurrence-liveness` -> temporal; `claim-fails` -> `FailedOnlyAfterCall`; `record-unknown-as-sent` -> `SentImpliesAccepted`; `give-up-early` -> `FailedOnlyWhenJustified`. Replay: 11 pass. |
  | `bun run verify:formal --wide --only outbox.recurring` | Wide base passed with 195,456 distinct states (227.3 s; 254.1 s with the mutants). |
  | The no-occurrence-guard config with only one of `LockSchedule`, `CasAdvance`, `UniqueLink` on (three TLC runs, first revision) | Each passes every property: any one guard keeps one document per occurrence. |

- `/statechart` paths (first revision; unchanged actions): `no-occurrence-guard`, 4 steps (two runs both issue #1); `no-replay-guard`, 8 steps, a loop where reconcile reruns and each rerun is Skipped; `start-before-commit`, 3 steps; `no-reconcile-h3`, 6 steps, "email claimed (delivery job died)" forever; `no-reconcile-lost-start`, 4 steps, "email queued (no delivery job)" forever.
- Able-to-fail gate on the real code (scratch break, run `bun test ./formal/outbox/outbox.replay.test.ts`, `git checkout` the file, all pass again). Rows marked (77a5bb7) ran against the 12-test harness before the reconcile and were not rerun; their "FINDING H3" and "H3 with the designed J1a reconcile" tests are now the one "H3: ..." test:

  | Break | File | Caught by |
  |---|---|---|
  | Replay guard off: `if (false && Option.isSome(existing))` (77a5bb7) | `modules/recurring/issuance.ts:246` | 4 fail: "DupStart, IssueCommit(replay)...", "CrashWorker after IssueCommit...", "CrashWorker inside SendCommit...", "FINDING H3..." (the rerun is Skipped) |
  | Delivery started inside the transaction: `yield* jobs.start(...)` without `afterCommit` (77a5bb7) | `modules/documents/deliveries/send.ts:242` | 2 fail: "CrashWorker inside SendCommit..." (`started` holds the rolled-back id), "CrashWorker before Hook..." |
  | Reconcile recovery off: `claim` returns `skipped` for a `sending` row (154383a) | `modules/documents/deliveries/steps.ts:79` | 4 fail: "H3: ...", "CrashDelivery(record)...", both "...CrashDelivery(giveup)..." |
  | Reconcile query finds nothing: `findStaleQueuedOrSending` returns `[]` (154383a) | `modules/documents/deliveries/repo.ts` | 5 fail: "CrashWorker before Hook...", "H3: ...", "CrashDelivery(record)...", both "...CrashDelivery(giveup)..." (also all 5 tests of `reconcile.test.ts`) |
  | Reconcile query skips `sending` rows: `whereIn: { status: ["queued"] }` (154383a) | `modules/documents/deliveries/repo.ts` | 4 fail: "H3: ...", "CrashDelivery(record)...", both "...CrashDelivery(giveup)..." |
  | Send guard off: the queued replay (`if (false && run.send === "queued" ...)`) and the pending-only check (`if (run.documentId === null)`) (77a5bb7) | `modules/recurring/issuance.ts:326-332` | 2 fail: "DupStart, IssueCommit(replay), SendCommit(replay)..." (3 delivery rows for the document, want 1), "FINDING H3..." |
  | Advance skips an occurrence: `occurrenceAfter` applied twice (77a5bb7) | `modules/recurring/issuance.ts:305` | 1 fail: "SweepStart, IssueCommit, ..." (the schedule's next occurrence is not 2026-12-23) |
  | `outcome_unknown` recorded as `sent` (77a5bb7) | `modules/documents/deliveries/steps.ts:125` | 1 fail: "Dispatch failures, ..." (the unknown attempt ends `sent` at once) |
  | `claim` marks a queued delivery `failed` without sending (77a5bb7) | `modules/documents/deliveries/steps.ts:73` | 7 fail, including the happy path and every recovery test (run with 11 tests) |
| `EmailNotAccepted` recorded `failed` like a rejection (no retry) (77a5bb7) | `modules/documents/deliveries/steps.ts:135` | 3 fail: "Dispatch failures, ..." and both crash-before-giveUp tests (the row is `failed` after the first attempt) |

  The `documents(schedule_id, occurrence)` unique key is a backstop behind the schedule lock and the CAS, so removing it alone changes no replay (the lock serializes the runs). It is covered by the model (`no-occurrence-guard`, and the single-guard runs above) and by the digest check on `record.ts` and `links.ts`.
