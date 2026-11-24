---
name: verify-idempotency-cas
description: Model-check request-key retry safety (withIdempotency over CoreStore requestLog.claim/complete, rule C3) and the optimistic revision check (getForUpdate / update compare-and-set / checkRevision, rule C2) with a bounded TLC model, and replay its traces on the real Contacts.save. Use before merging any change to packages/core/src/shared/{idempotency,revision,requestOutcome}.ts, the requestLog or transaction/rollback code in packages/core/src/store/{CoreStore,memory,tables}.ts, Contacts.save in packages/core/src/modules/contacts/live.ts, or formal/idempotency/**.
---

# Verify request_log and revision CAS

**Property (C3).** However many attempts of one request overlap, retry or abort, its mutation commits at most once, every success a client sees (first time or replayed) is the result stored for its key, and a key reused with another method or payload gets `Conflict{idempotency_mismatch}`, never the stored result.

**Harm (C3).** A client retry after a timeout creates a second Contact or Document or repeats an edit, or a reused key hands one request another request's answer.

**Property (C2).** An edit made from revision n commits only while the row is at n, so the n-th committed edit was made from revision n and the row ends at 1 + the number of committed edits; a stale edit fails with `Conflict{revision_changed, currentRevision}`.

**Harm (C2).** Two users editing one record at once silently lose one edit.

Two checks: a bounded TLC model (`idempotency.request-log-cas`) of the port semantics with Postgres-style waiting, and a Bun trace replay (`idempotency.request-log-cas-replay`) that drives the real `Contacts.save` on the in-memory store along selected traces reachable in the base model and asserts the same invariants on real state. A pass covers the model within its bounds and the replayed traces, not every interleaving of a real database.

## Does my change touch it?

Covered files (`formal/manifest.json` holds their sha256 at the sync commit):

- `packages/core/src/shared/idempotency.ts`: `withIdempotency` (claim, method + fingerprint compare, replay, `requestLog.complete`), `REQUEST_KEY_TTL_MILLIS`
- `packages/core/src/shared/revision.ts`: `checkRevision` (TLC check only: the model's `Lock` step describes it, and its digest flags changes, but no replay executes it; its only caller is Expenses, and the replay drives `Contacts.save`, which checks the revision through `getForUpdate`)
- `packages/core/src/shared/requestOutcome.ts`: `makeRequestOutcome` (`markReplayed`)
- `packages/core/src/store/CoreStore.ts`: `CoreStoreShape.requestLog.claim` / `complete` contract, `Claim`, `RequestLogEntry`, `transaction` rollback contract
- `packages/core/src/store/memory.ts`: `makeMemoryStore` (`requestLog.claim`/`complete`, `runFrame` snapshot restore and pending-claim cleanup, `locate` revision check)
- `packages/core/src/store/tables.ts`: `Collection.getForUpdate` / `update` compare-and-set contract
- `packages/core/src/modules/contacts/live.ts`: `Contacts.save` (`create`, `edit`), the method the replay drives

Other methods that wrap `withIdempotency` or take `expectedRevision` (expenses, pricelist, workspaces, documents, payments, recurring) rely on the same two mechanisms; the model covers the mechanisms, not each method's payload or body. If `bun run verify:formal --check-digests` names these checks, or `git diff 77a5bb7 -- <covered files>` is non-empty, run the checks.

## Run

```sh
bun run verify:formal --only idempotency.request-log-cas --only idempotency.request-log-cas-replay
```

Exit 0 means the base model passed, each of the six mutants failed with its declared violation, and the 7 replay tests passed. About 17 s on an idle machine (base about 7 s, six mutants about 1.5 s each, replay under 1 s); 28 s measured under a load average of 21 on 12 cores. The nightly `bun run verify:formal --wide` runs `RequestLogCas_wide.cfg`. Tools: tla2tools 1.7.4 and JDK 17 (pinned in `formal/toolchain/toolchain.json`), bun 1.4.2 (also confirmed on 1.4.4), effect 4.1.4. TLC logs land in `formal/.cache/logs/idempotency.request-log-cas.*.log`.

Read every TLC result, passing or failing, with `/statechart`: it turns a violation into its shortest path in plain words and charts the passing model. Give it `formal/idempotency/RequestLogCas.tla` and the config the runner used.

## The model (`formal/idempotency/RequestLogCas.tla`)

Each process is one attempt of one request; attempts of the same request reuse its `requestKey` and may overlap. Steps, one per code step another transaction can observe:

| Step | Code |
|---|---|
| `Claim` | `store.transaction` opens, `requestLog.claim`: a live entry is `Existing`, a free key becomes pending (`Claimed`), a key pending in another transaction waits |
| `Existing` | `withIdempotency` compares method + fingerprint: mismatch fails `Conflict{idempotency_mismatch}`, else returns the stored result and marks the request replayed |
| `Lock` | `getForUpdate(…, expectedRevision)` row-locks and checks the revision; stale fails `revision_changed` and rolls back |
| `Commit` | `repo.update` (revision + 1) or `repo.insert`, the audit row, `requestLog.complete`, COMMIT (transaction-local until COMMIT, so one step) |
| `Abort` | any failure, defect or interruption before COMMIT: the pending claim and the row lock go |

Requests: r1 and r2 edit the row from revision 1 with one key and different payloads; r3 edits it from revision 1 with its own key; r4 creates a Contact (no revision guards it, only the claim does); r5 edits from revision 2 on r3's key, the client's retry after `revision_changed` (a new payload on a key that stores nothing because its attempts failed).

Invariants: `AtMostOnceEffect`, `ReplayReturnsStoredResult`, `MismatchNeverReplayed` (another payload never gets the stored result), `MismatchOnlyForOtherPayload` (a matching retry is never rejected), `NoLostUpdate`, `EntryHasCommittedOrigin` (every stored entry is the result an attempt of that key and payload committed and returned: failures store nothing), `TypeOK`; deadlock is checked (a retry that waits forever on a claim no one holds).

Mutants (each must fail; `Bug` constant in the mutant config):

| Mutant | Breaks | Must violate |
|---|---|---|
| `accept-mismatch` | `Existing` skips the method/fingerprint compare | `MismatchNeverReplayed` |
| `replay-live-row` | a replay of an edit returns the live row's revision instead of the stored result (a result enriched after the body) | `ReplayReturnsStoredResult` |
| `reject-matching` | `Existing` answers `idempotency_mismatch` to every retry | `MismatchOnlyForOtherPayload` |
| `claim-no-wait` | `claim` takes a key pending in another transaction | `AtMostOnceEffect` (two creates commit) |
| `no-revision-check` | `getForUpdate` ignores `expectedRevision` | `NoLostUpdate` |
| `keep-claim-on-rollback` | rollback leaves the claim pending | deadlock |

## Bounds

- Base (`RequestLogCas.cfg`): overlapping attempts per request r1..r5 = 2, 1, 2, 2, 1 (8 attempts), any attempt may abort before COMMIT: 120,320 distinct states, complete search. (The runner's summary line prints the first progress count, not the final one; the TLC log's last `distinct states found` line is the full count.)
- Wide (`RequestLogCas_wide.cfg`, nightly): 2 attempts of every request (10 attempts), 2,774,656 distinct states, complete search, 2 min 40 s through the runner (timeout 900 s). Three attempts of r1..r4 (12) passed 2 million distinct states with a growing queue within 10 minutes, so it is not a nightly bound.
- Replay: 7 traces on one seeded Contact at revision 1 (`requestLogCas.replay.test.ts`), each named by its model steps and reachable in the base model: replay after commit; mismatch on a reused key; r3 stale twice, r5 commits on the same key, then r1's retry replays r1's result while the row is at revision 3; abort after `Lock` then retry; overlapping duplicate edit; overlapping duplicate create; overlapping competing edits.

## Assumptions and what is not covered

- Claim waiting and row locks follow the `CoreStore` port docblocks (Postgres semantics). Only the in-memory store exists in core today; it serializes whole transactions, so the replay interleaves attempts only between transactions. The SQL adapter's waits, `SELECT … FOR UPDATE`, unique-violation handling and serialization retries belong to the Postgres 17 contention job (`*.contention.ts`), not to this skill.
- The request-key TTL (24 h) never passes inside a run: a replay after expiry runs the body again by design and is not modelled. One Workspace scope; User scopes behave the same and are not modelled.
- `Contacts.save`'s same-content no-op edit (returns the row unchanged, no revision bump) and IČO unique-index conflicts (`ensureIcoFree`, `UniqueViolation`) are not modelled.
- The model's payload stands for the whole fingerprint (`[method, encoded payload]`); a method that leaves an input out of its payload (rule in the `withIdempotency` docblock) is a per-method bug this model cannot see.
- MCP preview → confirm tokens (single use, bound to revision and args, ADR-0005 table row) are not covered: core has no confirmation-token issuance or redemption yet, only the api-contract helpers `confirmStep`, `confirmationBoundArgs` and `mcpConfirmRequestKey` in `packages/api-contract/src/mcp.ts`. When the MCP edge lands, extend the model with a token issue/redeem step bound to the preview's revision and `confirmationBoundArgs` hash, and a mutant that redeems twice.

## Drift or bug?

1. Read the violation with `/statechart`. Retell the path in code nouns, for example "attempt 1 of the create claims k3; attempt 2 claims k3 while attempt 1 is pending; both insert".
2. Replay that path on the real code: add a test to `formal/idempotency/requestLogCas.replay.test.ts` with one step per action (overlap with `Effect.all(…, { concurrency: "unbounded" })`, abort by making the body fail after the step, as the abort trace does with a missing series).
3. If the real code shows the bad outcome, it is a real bug: report the path and the file:line, keep the model and the test strict, and do not patch product code in the verification change.
4. If the path needs two transactions open at once (a second `claim` while the first holds the key pending, two row locks held together), the in-memory store cannot replay it: it runs one transaction at a time. A green replay then settles nothing. Report the path as unresolved, name the `CoreStore` docblock rule it depends on, and leave the model as written until a contention test on the SQL adapter (`*.contention.ts`, the CI pg-contention job) replays it.
5. Only when the path is replayable in memory and the real code does the right thing is the model wrong: a step is coarser or finer than the code's (check the step table above against the changed file), or a precondition is missing. Fix the model, not the invariant.
6. A replay test failing alone (model passes) means the real method stopped matching the port semantics, for example a body that runs before `claim` or a revision check moved after a state-dependent rule.

## Update

When a change to the covered files is intended: re-read the changed code against the step table; change the model or the replay traces to match; keep every invariant as written; run the command above; commit your intended change first (a WIP commit is fine), so the scratch break can be undone without losing it; break the real code once (for example `if (false && …)` around the fingerprint compare in `idempotency.ts`) to see the replay fail; undo only the break with `git checkout HEAD -- <file>`; check `git diff HEAD` is empty; rerun green; then `bun run verify:formal --update-digests --only idempotency.request-log-cas --only idempotency.request-log-cas-replay` and move the sync commit below and in the manifest entries. Commit verification and digest updates separately from product fixes.

## Coverage record

- Sync commit: `77a5bb7` (product code unchanged at `611b68e`; the verification was confirmed to describe the covered files there).
- Able-to-fail, recorded 2026-11-24 on the 7-trace harness, each break undone with `git checkout HEAD -- <file>` and re-run green (`7 pass`):
  - `idempotency.ts`: the method/fingerprint compare disabled (`if (false && (…))`) → 1 of 7 fails: "r1 commits; r2 (same key, other payload): Claim, Existing -> idempotency_mismatch" (the reused key got the stored result).
  - `idempotency.ts`: every existing entry treated as a mismatch (`if (true || …)`) → 4 of 7 fail: the replay, the replay after the row moved on, and both overlapping duplicates (a matching retry got `idempotency_mismatch`).
  - `memory.ts` `locate`: the `expectedRevision` check disabled → 2 of 7 fail: the stale trace and the overlapping competing edits (the stale edit committed over revision 2).
- Mutants: all six fail with their declared violation under `bun run verify:formal --only idempotency.request-log-cas` (accept-mismatch after 740 distinct states, reject-matching 507, replay-live-row 8,783 (r1 and r5 commit, then r1's retry is replayed revision 3 for its stored 2), claim-no-wait 1,213, no-revision-check 96, keep-claim-on-rollback 1,446).
