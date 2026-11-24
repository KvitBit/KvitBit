# Bounded TLA+ models, exhaustive and property checks over the real TypeScript, and nightly E2E replace PR-time E2E for core rules

Status: **Accepted**, 2026-11-24.

Filip wants the Czech invoicing rules (numbering, lifecycle and payments, VAT, authorization, idempotency, recurring issuance) checked on every PR without waiting for end-to-end suites. We check event-order and concurrency protocols with bounded TLA+ models run by TLC, and policy, arithmetic and UI invariants with exhaustive or generated-input tests over the real TypeScript. Trace replay and model mutants bind the models to the code. PR CI runs those checks plus PGlite and a path-filtered Postgres 17 contention job, while the Playwright, Expo, OAuth/provider and Cluster/PgBouncer E2E suites and wider TLC bounds run nightly. `main` deploys without waiting for them. TLC is the only verifier in the toolchain today: Quint, Apalache, Lean, Z3, cvc5 and Dafny are not installed, and the code is TypeScript, which no installed verifier reads directly.

## Honest scope

These checks can stand in for PR-time E2E coverage of domain state transitions and lifecycle legality, arithmetic (VAT buckets, rounding, deductions), the finite authorization policy (role × action × scope × tenant), retry, idempotency and CAS protocols, and the interleavings and crash points of the protocols we designed.

They cannot establish:
- real Postgres locking and MVCC (`FOR UPDATE`, `READ COMMITTED` anomalies, deadlock and serialization retries). PGlite has one connection, so it cannot show lock behaviour inside a transaction; only the Postgres 17 contention job can.
- production Effect layer wiring: that the right service and layer are provided and that the transaction boundary really wraps the steps a model treats as atomic.
- HTTP, MCP and OAuth adapters (ETag, `If-Match`, 428/412 mapping, `Idempotency-Key`, token grants).
- PDF rendering output.
- browser SSR and hydration, the Foldkit runtime, Expo and mobile behaviour.
- external providers: SMTP, GCS, Neon/PgBouncer, the ALTCHA library, Cluster runner behaviour.

A passing check covers only its model or harness, its bounds and its stated assumptions. Every verify skill states them.

## Decision

- **TLA+/TLC** for protocols and concurrency: numbering allocation, reservation and override; the document and payment lifecycle; request_log idempotency with revision CAS, including MCP preview→confirm; recurring issuance with the afterCommit outbox. Counterexamples are read with `/statechart`.
- **Exhaustive enumeration over the real function** where the input space is finite: `can(caller, action)` intersected with credential scopes and tenant isolation, and half-away-from-zero rounding over the whole minor-unit residue space.
- **Generated-input tests with an independent oracle** over the real code for the rest: VAT bucket grouping and CZK conversion, Proforma→PTD→Final Invoice→Credit Note chains, the numbering lexer, `format` and `periodKey`, SPAYD and EPC payloads, Foldkit TEA `update`, and HCT contrast. The ALTCHA single-use property is checked with real SQL contention and handler order, not a separate model.
- **Anti-drift binding.** Trace replay drives the real Effect services with model traces (PGlite for semantics, Postgres 17 for interleavings): a replayed counterexample that cannot happen means the model drifted, one that can means a bug. Every model ships at least one mutant that must fail, on every PR. The able-to-fail gate (break the real code, see the check fail, restore it) runs when a skill is created or rebound to moved code.
- **Deferred tools.** Quint, Apalache, Lean 4 and Z3 are adopted only when a named theorem the enumeration cannot reach (for example an unbounded conservation law) or a TLC state-space limit justifies one, and then through the same pinned-toolchain mechanism.
- **Terminology.** Sampled property tests are called property tests, never proofs. Only exhaustive enumeration over a finite domain, bounded model checks stated with their bounds, and prover or SMT results are called verification.

### Accounting definitions used by the checks

- **Net to zero.** A Proforma → Payment Tax Document → Final Invoice → Credit Note chain that fully reverses a supply nets to exactly zero in the document currency, per VAT bucket (treatment, rate), for base, VAT and gross. CZK VAT is rounded per bucket half away from zero, so CZK amounts may leave a documented rounding residue; the checks state that residue's bound instead of asserting zero.
- **Credit Note FX and VAT rate.** A Credit Note inherits the original Invoice's exchange rate and VAT rate (Czech VAT Act §42; decision Q5 in `docs/design/user-flows.md`, rules D7 and D11 in `docs/design/core-ports.md`).

## CI split and release gating

PR CI (`.github/workflows/ci.yml`):
- `check`: Biome, typecheck (including `formal/`), and `bun run test`, which runs the package unit, contract, PGlite, property and exhaustive tests.
- `formal`: `bun run verify:formal`: the covered-file digest gate, bounded TLC runs of each model with its mutants, replay harnesses, and the runner self-test. A TLC timeout or incomplete search is a failure.
- `pg-contention`: a Postgres 17 service with two-connection contention tests (`*.contention.ts`, outside bun's default discovery), run only when numbering, revision CAS, request_log, payments/PTD, outbox claim or ALTCHA replay paths change. It starts as a skeleton that passes with no tests.
- With Phase 3: production-layer composition and handler checks, PDF content checks, an in-Bun SSR render smoke, and contention tests on HTTP paths.

Nightly plus `workflow_dispatch` (`.github/workflows/nightly.yml`): `verify:formal --wide` with each model's wider bounds, and the Playwright web, Expo, OAuth/provider and Cluster/PgBouncer E2E suites. Until Phase 3 apps exist the E2E jobs are skeletons; each fails once its app directory exists without a wired suite. The same nightly job also runs `bun run test` with `KVITBIT_FORMAL_WIDE=1`: property and exhaustive tests gate their wider bounds on that variable (today the full raw-scope enumeration of `can()`, about 49s). `--wide` itself skips property checks.

**Release gating: `main` deploys without waiting for E2E.** Filip accepted the exposure: a regression only E2E would catch can reach production between merge and the next nightly (or a manual `workflow_dispatch` run). A red nightly is fixed forward on `main`.

**Budgets** are targets, measured before they are enforced: about 3 minutes for the `formal` job and about 5 extra PR minutes overall. The Wave 1 runner (self-test plus fixtures) takes about 15 seconds locally.

## Layout and toolchain

```
formal/
  toolchain/toolchain.json   tla2tools 1.7.4 URL + sha256, JDK 17
  toolchain/toolchain.ts     fetch to formal/.cache, verify sha256, check the JDK; fails closed
  run-formal.ts              the runner behind `bun run verify:formal`
  manifest.json              every check: covered files + sha256, guarded symbols, bounds,
                             assumptions, tool versions, sync commit, tier
  tsconfig.json              maps @kvitbit/* to package sources for harnesses
  selftest/                  runner fixtures, including negatives it must report as failures
  numbering/ lifecycle/ idempotency/ outbox/   models, mutants, replay harnesses
packages/<pkg>/test/**/*.{property,exhaustive}.test.ts
.agents/skills/verify-<subsystem>/SKILL.md
.claude/skills -> ../.agents/skills
AGENTS.md                    path → verify skill router
```

- tla2tools is pinned to v1.7.4, sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` (the `/statechart` pin). A `TLA2TOOLS` override is checksummed the same way; a mismatch stops the run.
- JDK 17 comes from mise (root `.mise.toml`) for development and `actions/setup-java` (Temurin 17) in CI. A Nix flake can wrap the same pins later; ADR-0003 already plans one for self-hosting.
- TLC runs with pinned flags (`-workers 1 -fp 0 -lncheck final -cleanup`, metadir in the cache) so a run is reproducible.
- The manifest schema, runner flags, file naming and exit codes are specified in `formal/README.md`.

## Skills and maintenance

- One `verify-<subsystem>` skill per subsystem in `.agents/skills/`, generated with `/create-formal-verification-skill` against committed code. Each records its property and the harm, covered files and guarded symbols, bounds, assumptions, command, tool version and sync commit; TLA+ skills point to `/statechart` for reading results. `AGENTS.md` routes paths to skills.
- `bun run verify:formal --check-digests` compares covered-file sha256s with the tree and names the drifted checks and skills.
- **Tier 1:** a PR that changes covered code fails the `formal` job until it carries a maintenance commit, separate from the product commits, that records the reviewer's classification per `/maintain-formal-verification-skill` (in sync, updated, bug or blocked) and refreshes the digests of the classified checks (`--update-digests --only <id>`). A reasoned "no effect" is classified in sync, so a change that leaves the property intact needs only the digest refresh, not a model rewrite. A blocked check keeps its digests and sync commit and only warns until it is fixed.
- **Tier 2/3:** drift is annotated only; a stale covered digest blocks a release, not a merge.
- Verification, digest and sync-commit updates go in a maintenance change separate from product fixes. A blocked check keeps its sync commit.
- A check that finds a bug stays strict: the counterexample is reported in the code's own nouns and the property is not weakened to turn CI green.

## Required code seams

Phase 2 and 3 implementations expose:
- decisions as pure functions that a test can enumerate or drive with generated inputs;
- explicit transaction and lock boundaries matching the steps a model treats as atomic;
- injectable crash, clock and SQL-step points so a replay harness can drive interleavings.

## Target catalog

Tier 1, required as each Phase 2 subsystem lands on `main`:

| Property | Tool | Bound (indicative) | Harm if broken |
|---|---|---|---|
| Numbering: no two issued documents share a number per (Workspace, kind); an assigned number stays reserved forever; an override reserves the new number, keeps the old one and leaves the counter alone; rollback reverts the counter; lexer, `format` and `periodKey` are injective per period | TLC + replay, generated inputs, PG17 contention | 2–3 competing issue or override attempts, 2 periods, crash and rollback points | duplicate statutory invoice numbers |
| Lifecycle and payments: only legal transitions; payments block cancellation; one Final Invoice per paid Proforma; one PTD per received payment for a VAT payer; uncredited PTD or Final Invoice deductions block removing a payment; cumulative Credit Notes ≤ the original per bucket | TLC + replay | competing lifecycle and payment actions with crashes | wrong tax documents, double deductions |
| request_log and revision CAS, with MCP confirm: same key, method and hash give the same stored result; a mismatch is rejected; a stale revision is rejected; no lost update under retries; a confirm token is single-use and revision-bound | TLC + PG17 contention | 2 clients × retries × deadlock or serialization retry ≤ 3 | duplicate effects, lost edits |
| VatMath: grouping by (treatment, rate), half away from zero, CZK conversion per bucket, PTD and Final Invoice deduction rules, net to zero as defined above | generated inputs + exhaustive residue enumeration | the full residue space for rounding | wrong VAT on statutory documents |
| Authorization: `can()` ∩ scopes equals the spec matrix; write implies read; a foreign Workspace reads as NotFound | exhaustive enumeration of the real function | the full finite matrix | tenant data leak, privilege escalation |
| Outbox and recurring: each (schedule, occurrence) issues once; the schedule advances by CAS; the workflow starts after commit with a deterministic key; reconcile recovers after a crash; SMTP is at-least-once | TLC + replay | 2 sweeps, a crash between commit and start, 1 reconcile | missed or duplicated recurring invoices and emails |

Tier 2, with Phase 3. Bounds marked *to measure* are set when the first check is written.

| Property | Tool | Bound (indicative) | Harm if broken |
|---|---|---|---|
| MCP confirm and ALTCHA PoW: consumed before any auth side effect, replay rejected, fail closed | PG17 contention + handler-order checks | 2 concurrent redemptions per token or challenge | replayed confirmations, bot sign-ups past the PoW gate |
| HTTP and MCP precondition mapping: missing `If-Match` is 428, stale ETag is 412, `Idempotency-Key` replays the stored response | handler checks over the production layer | every precondition case per mutating route | lost updates or duplicate effects through the API |
| SPAYD 1.2 and EPC069-12 payloads: grammar, field limits, escaping, and no QR for another currency, no IBAN, a Credit Note or a cancelled document | generated inputs + round-trip oracle | *to measure* (seeded inputs per field class, every null case) | payments to the wrong account or amount, unscannable QR codes |
| Foldkit TEA `update`: total over every Message, keyed commands superseded, late replies ignored by sequence guards | generated message sequences | *to measure* (sequence length and seeds) | stale data shown or saved, UI stuck in a state |
| HCT/M3 contrast ≥ 4.5:1 | exhaustive over scheme variants × roles | six contrast variants × light and dark × every role pair | unreadable text, an accessibility failure |
| Production-layer composition, PDF content, SSR render | composition checks, render-model-in/text-out checks, in-Bun SSR smoke | each production layer; each document kind; each SSR route | missing services at runtime, wrong statutory text on PDFs, broken first render |

Tier 3, optional or nightly.

| Property | Tool | Bound (indicative) | Harm if broken |
|---|---|---|---|
| Tier 1 models at wider constants | TLC `--wide` (nightly) | the `wideConfig` of each model, *to measure* against the nightly budget | rare interleavings missed by the PR bounds |
| Tier 1 and 2 property tests with more seeds | property tests (planned nightly job) | *to measure* | rare inputs missed by the PR seeds |
| Chain-wide conservation identity (net to zero) | Lean 4 or Z3, only if justified | unbounded | VAT or totals that do not reverse exactly |
| Cluster runner and PgBouncer stress | nightly E2E | *to measure* | stuck or duplicated workflows under production pooling |

### Hypotheses and their verdicts

The council listed three hypotheses before any model existed. The Tier 1 models settled them at sync commit `77a5bb7`. A refutation holds only within the stated bounds and for the protocol as modelled; there is no Postgres `CoreStore` yet, so Postgres locking is assumed from the `CoreStore` port docblocks. Paths without a package prefix are under `packages/core/src/`.

- **H1, a number override racing allocation under the S3 locking order: refuted within bounds** (`verify-numbering`, `numbering.allocator` and `numbering.replay`). An issue locks the draft row first (`modules/documents/lifecycle.ts:163`), then the counter row (`modules/numbering/service.ts:361`). Issue and override reserve through the same `tryReserve` primary key (`service.ts:369` and `:386`, `store/numbering.ts:63-70`, `number_reservations` in `packages/db/drizzle/20261123175822_init/migration.sql:709`). An issue skips a number an override already holds (`service.ts:376-377`), and an override never moves the counter (`service.ts:383-395`). The `documents` unique number index (`modules/documents/record.ts:236`) backs this up. The second of two overrides was checked only by serial replay (R3).
- **H2, a PTD correction interleaving with Final Invoice finalization: refuted within bounds** (`verify-document-lifecycle`, `lifecycle.model` and `lifecycle.replay`). Both paths lock the Proforma first (`modules/documents/final.ts:209`, `corrections.ts:204`, `lifecycle.ts:597`). A PTD the Final Invoice already deducted cannot be credited (`corrections.ts:206-214` and `:235`, `lifecycle.ts:599`), and the Final Invoice reads the PTD Credit Notes only after taking the lock (`final.ts:65-69`). The mutant without the Proforma lock finds an 8-step counterexample.
- **H3, outbox recovery after a crash between claim and send: confirmed at core scope** (`verify-outbox-recurring`, `outbox.recurring` and `outbox.replay`). No query in core finds deliveries left `queued` or `sending`: `pendingSendRuns` lists only issued schedule runs whose send is still `pending` (`modules/recurring/repo.ts:300`), `DeliveriesRepo` has no such query (`modules/documents/deliveries/repo.ts:21-62`), and nothing reads the `deliveries_pending_idx` index. After the crash the delivery stays `sending` with zero provider attempts. The model passes only with the planned J1a delivery reconcile added; that reconcile is not in core yet. This is finding F3 below.

## Findings

The checks found these in the product code at `77a5bb7`. They are reported for separate product commits. The properties stay strict: no check was weakened to make them pass, and no product code changed in this work.

- **F1, Final Invoice CZK VAT disagrees with the VAT report** (`verify-vat-numbering-math`). The Final Invoice stores its CZK VAT as the whole Proforma's VAT converted at the Final Invoice rate minus the CZK VAT stored on its PTDs (rule D8, `modules/documents/compose.ts` around lines 673-700). The VAT report instead converts the net per VAT bucket in document currency at the Final Invoice rate (`modules/reports/compute.ts:108`, used by `modules/documents/reports.ts:34`). With seed 58256 the two differ by 131.29 CZK. The check is held as a marked `test.failing` in `packages/core/test/engines/advance-chain.property.test.ts`; it turns red once the stored and reported CZK VAT agree in every bucket; a change that only alters the size of the gap keeps it failing as expected. Which rule is correct is an open product decision.
- **F2, issuing reserves a number before its document row exists, which Postgres rejects** (`verify-numbering`). `number_reservations_document_fk` (`migration.sql:926`) is not deferrable, but these paths call `tryReserve` for a document they have not inserted yet: `Documents.issue({input})` (`lifecycle.ts:186` before the insert at `:188`), Credit Notes (`credit.ts:389` before `:400`), PTDs (`payments.ts:430` before `:438`) and the Final Invoice (`final.ts:213`). The correction preview (`corrections.ts:359`) and the Final Invoice preview (`final.ts:274`) reserve for a document they never insert; the preview's rollback wrapper (`support.ts:115`) passes the allocation error on. On Postgres the insert fails and aborts the transaction, which breaks the `tryReserve` promise not to abort (`store/CoreStore.ts:121-125`). A PGlite run reproduces it; the in-memory store has no foreign keys, so the core tests pass.
- **F3, a delivery whose worker crashed between claim and provider call is never sent** (`verify-outbox-recurring`; this is H3). The delivery stays `sending` and nothing picks it up again.
- **F4, a crash between the send commit and the afterCommit workflow start leaves the delivery `queued` forever** (`verify-outbox-recurring`). The cause is the same missing reconcile. The mutant `no-reconcile-lost-start` and the replay case "CrashWorker before Hook" show it.

## Residual risks

Each skill lists its exact assumptions and gaps; this is the summary.

- **R1, authorization** (`verify-auth-policy`). On PRs `can()` is checked on every normalized grant, on every raw two-area list in two orders, and on the all-areas write-only list forward and reversed. `Workspaces.enter` can pass raw lists unnormalized and in the caller's order (`modules/workspaces/live.ts:745`). Other raw lists of three or more areas are checked only by the nightly run with `KVITBIT_FORMAL_WIDE=1` (about 50 s), which enumerates each distinct scope subset once, in canonical order. Every other permutation, and lists with duplicate entries, are not enumerated. No check covers how `Workspaces.enter` builds the caller's scopes.
- **R2, VAT** (`verify-vat-numbering-math`). The VAT rate table has a single entry, so the checks show that a Credit Note inherits the original rate but not that it ignores a later, different rate. The chain check runs only the VAT payer regime with `CZ_BUYER` and `paymentRounding` `none`, on the in-memory store.
- **R3, numbering** (`verify-numbering`, `verify-idempotency-cas`). The wide run with two overrides did not finish (28.6 million states in 30 minutes), so the second override is covered by serial replay only. MCP preview and confirm tokens are not in core (only helpers in `packages/api-contract/src/mcp.ts`), so the request_log check does not cover them.
- **R4, lifecycle and outbox** (`verify-document-lifecycle`, `verify-outbox-recurring`). Core has no seam to crash before commit inside `final.ts:214-234` or `credit.ts:400-428`, no J1a reconcile query, no workflow engine, and the sealed System caller is not exported. The in-memory store runs one transaction at a time, so every replay interleaves only between transactions.

### Postgres 17 contention backlog

Every locking claim above rests on Postgres behaving as the `CoreStore` docblocks say. The path-filtered Postgres 17 job (`*.contention.ts`) has to check it once a Postgres `CoreStore` exists. Each skill holds the detailed list:
- numbering (`verify-numbering`): issue against override and against draft edits on the row lock, counter serialization per period, rollback restoring the counter, `tryReserve` as `ON CONFLICT DO NOTHING`, the S4 lock order and its retries, and F2;
- request_log and revision CAS (`verify-idempotency-cas`): claim waits, `SELECT … FOR UPDATE`, unique-violation handling and serialization retries in the SQL adapter;
- lifecycle (`verify-document-lifecycle`): `issueFinalInvoice` against a PTD correction or cancellation of the same Proforma, and `Payments.record` against `issueFinalInvoice`;
- outbox and recurring (`verify-outbox-recurring`): competing `issue` and `send` on one schedule, the schedule revision CAS and the occurrence unique indexes, `claim` against a record transaction, overlapping dispatches, afterCommit firing only after the real COMMIT, and the reconcile query racing a committing send.

## Considered Options

- **Keep PR-time E2E as the gate**: covers wiring and adapters, but is slow and flaky, and explores few interleavings and no crash points.
- **Hand models with no binding to the code**: cheap, but they drift silently; we require replay, mutants and digests instead.
- **Prover-first (Lean, Z3) or Quint/Apalache now**: not installed, and no target yet needs unbounded proof or a larger state space than TLC handles.
- **Gate releases on an E2E-green SHA**: safer, but slows deploys; Filip chose deploy-from-`main` with accepted exposure.
- **Hard-block every PR touching covered code**: rejected for a reviewer classification recorded through the digest gate.
- **Nix flake for the toolchain now**: deferred; mise plus the checksum pin works today and a flake can wrap the same pins.

## Consequences

- E2E, browser, mobile, OAuth, provider, Cluster and PgBouncer behaviour are checked only nightly; regressions there can reach production until the next nightly or a manual run.
- The nightly E2E skeletons turn red on the first nightly after a Phase 3 app directory merges without its suite: a post-merge signal, not a merge gate.
- Real locking is covered only by the path-filtered Postgres 17 job; a change outside its filter that affects locking escapes it until review notices.
- Reviewers carry a maintenance classification for every PR that touches Tier 1 covered code, and authors keep verification updates in separate commits.
- Contributors need JDK 17 (mise) and a one-time network fetch of the jar; CI caches it by toolchain manifest.
- Every model costs a mutant and a replay harness, and every skill a sync commit, so verification stays visible work instead of silent sediment.

## Open items

- Measure the PR budget in CI, then decide whether to enforce it. Locally, with all Tier 1 checks in place, `bun run verify:formal` took 75 s and 72 s on two runs at the integration commit; property and exhaustive checks add their time to `bun run test`.
- Nix devShell for development (stay on mise until then).
- Add `.cursor/rules` pointers only if Cursor is used on this repo.
