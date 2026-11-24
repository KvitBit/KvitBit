---
name: verify-idempotency-cas
description: Model-check request-key retry safety (withIdempotency over CoreStore requestLog.claim/complete, rule C3) and the optimistic revision check (getForUpdate / update compare-and-set / checkRevision, rule C2) with a bounded TLC model, and replay its traces on the real Contacts.save. Use before merging any change to packages/core/src/shared/{idempotency,revision,requestOutcome}.ts, the requestLog or transaction/rollback code in packages/core/src/store/{CoreStore,memory,tables}.ts, Contacts.save in packages/core/src/modules/contacts/live.ts, or formal/idempotency/**.
---

# Verify request_log and revision CAS

**Property (C3).** However many attempts of one request overlap, retry or abort, its mutation commits at most once, every success a client sees (first time or replayed) is the result stored for its key, and a key reused with another method or payload gets `Conflict{idempotency_mismatch}`, never the stored result.

**Harm (C3).** A client retry after a timeout creates a second Contact or Document or repeats an edit, or a reused key hands one request another request's answer.

**Property (C2).** An edit made from revision n commits only while the row is at n, so the n-th committed edit was made from revision n and the row ends at 1 + the number of committed edits; a stale edit fails with `Conflict{revision_changed, currentRevision}`.

**Harm (C2).** Two users editing one record at once silently lose one edit.

Two checks: a bounded TLC model (`idempotency.request-log-cas`) of the port semantics with Postgres-style waiting, and a Bun trace replay (`idempotency.request-log-cas-replay`) that drives the real `Contacts.save` on the in-memory store along the model's shortest traces and asserts the same invariants on real state. A pass covers the model within its bounds and the replayed traces, not every interleaving of a real database.

## Does my change touch it?

Covered files (`formal/manifest.json` holds their sha256 at the sync commit):

- `packages/core/src/shared/idempotency.ts`: `withIdempotency` (claim, method + fingerprint compare, replay, `requestLog.complete`), `REQUEST_KEY_TTL_MILLIS`
- `packages/core/src/shared/revision.ts`: `checkRevision`
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

Exit 0 means the base model passed, each of the four mutants failed with its declared violation, and the 7 replay tests passed. About 16 s (base about 7 s, mutants about 2 s each, replay under 1 s). The nightly `bun run verify:formal --wide` runs `RequestLogCas_wide.cfg`. Tools: tla2tools 1.7.4 and JDK 17 (pinned in `formal/toolchain/toolchain.json`), bun 1.4.2 (also confirmed on 1.4.4), effect 4.1.4. TLC logs land in `formal/.cache/logs/idempotency.request-log-cas.*.log`.

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

Requests: r1 and r2 edit the row from revision 1 with one key and different payloads; r3 edits it from revision 1 with its own key; r4 creates a Contact (no revision guards it, only the claim does).

Invariants: `AtMostOnceEffect`, `ReplayReturnsStoredResult`, `MismatchNeverReplayed`, `NoLostUpdate`, `TypeOK`; deadlock is checked (a retry that waits forever on a claim no one holds).

Mutants (each must fail; `Bug` constant in the mutant config):

| Mutant | Breaks | Must violate |
|---|---|---|
| `accept-mismatch` | `Existing` skips the method/fingerprint compare | `MismatchNeverReplayed` |
| `claim-no-wait` | `claim` takes a key pending in another transaction | `AtMostOnceEffect` (two creates commit) |
| `no-revision-check` | `getForUpdate` ignores `expectedRevision` | `NoLostUpdate` |
| `keep-claim-on-rollback` | rollback leaves the claim pending | deadlock |

## Bounds

- Base (`RequestLogCas.cfg`): 4 requests × 2 overlapping attempts (8 attempts), any attempt may abort before COMMIT: 98,944 distinct states, complete search. (The runner's summary line prints the first progress count, not the final one; the TLC log's last `distinct states found` line is the full count.)
- Wide (`RequestLogCas_wide.cfg`, nightly): 4 requests × 3 attempts (12 attempts), see the coverage record for its size and time.
- Replay: 7 traces on one seeded Contact at revision 1 (`requestLogCas.replay.test.ts`), each named by its model steps: replay after commit; mismatch on a reused key; stale twice then the same key with the fresh revision; abort after `Lock` then retry; overlapping duplicate edit; overlapping duplicate create; overlapping competing edits.

## Assumptions and what is not covered

- Claim waiting and row locks follow the `CoreStore` port docblocks (Postgres semantics). Only the in-memory store exists in core today; it serializes whole transactions, so the replay interleaves attempts only between transactions. The SQL adapter's waits, `SELECT … FOR UPDATE`, unique-violation handling and serialization retries belong to the Postgres 17 contention job (`*.contention.ts`), not to this skill.
- The request-key TTL (24 h) never passes inside a run: a replay after expiry runs the body again by design and is not modelled. One Workspace scope; User scopes behave the same and are not modelled.
- The model's payload stands for the whole fingerprint (`[method, encoded payload]`); a method that leaves an input out of its payload (rule in the `withIdempotency` docblock) is a per-method bug this model cannot see.
- MCP preview → confirm tokens (single use, bound to revision and args, ADR-0005 table row) are not covered: core has no confirmation-token issuance or redemption yet, only the api-contract helpers `confirmStep`, `confirmationBoundArgs` and `mcpConfirmRequestKey` in `packages/api-contract/src/mcp.ts`. When the MCP edge lands, extend the model with a token issue/redeem step bound to the preview's revision and `confirmationBoundArgs` hash, and a mutant that redeems twice.

## Drift or bug?

1. Read the violation with `/statechart`. Retell the path in code nouns, for example "attempt 1 of the create claims k3; attempt 2 claims k3 while attempt 1 is pending; both insert".
2. Replay that path on the real code: add a test to `formal/idempotency/requestLogCas.replay.test.ts` with one step per action (overlap with `Effect.all(…, { concurrency: "unbounded" })`, abort by making the body fail after the step, as the abort trace does with a missing series).
3. If the real code shows the bad outcome, it is a real bug: report the path and the file:line, keep the model and the test strict, and do not patch product code in the verification change.
4. If the real code does the right thing, the model is wrong: a step is coarser or finer than the code's (check the step table above against the changed file), or a precondition is missing. Fix the model, not the invariant.
5. A replay test failing alone (model passes) means the real method stopped matching the port semantics, for example a body that runs before `claim` or a revision check moved after a state-dependent rule.

## Update

When a change to the covered files is intended: re-read the changed code against the step table; change the model or the replay traces to match; keep every invariant as written; run the command above; break the real code once (for example `if (false && …)` around the fingerprint compare in `idempotency.ts`) to see the replay fail; `git checkout` the file; rerun green; then `bun run verify:formal --update-digests --only idempotency.request-log-cas --only idempotency.request-log-cas-replay` and move the sync commit below and in the manifest entries. Commit verification and digest updates separately from product fixes.

## Coverage record

- Sync commit: `77a5bb7` (product code unchanged at `611b68e`; the verification was confirmed to describe the covered files there).
- Able-to-fail, recorded 2026-11-24, each reverted with `git checkout` and re-run green (`7 pass`):
  - `idempotency.ts`: the method/fingerprint compare disabled (`if (false && (…))`) → replay fails 1 of 7: "r1 commits; r2 (same key, other payload): Claim, Existing -> idempotency_mismatch" (the reused key got the stored result).
  - `memory.ts` `locate`: the `expectedRevision` check disabled → replay fails 2 of 7: the stale trace and the overlapping competing edits (the stale edit committed over revision 2).
- Mutants: all four fail with their declared violation under `bun run verify:formal --only idempotency.request-log-cas` (accept-mismatch after 660 distinct states, claim-no-wait 1,259, no-revision-check 1,363, keep-claim-on-rollback 1,475).
