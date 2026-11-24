# formal/

Cross-package formal checks for kvitbit: TLA+ models run by TLC, trace-replay harnesses that drive the real code, and the manifest that binds both (and the package-local property and exhaustive tests) to the code they cover. Why and what: [ADR-0005](../docs/adr/0005-formal-verification.md). Which skill covers which path: [AGENTS.md](../AGENTS.md).

## Commands

| Command | Does |
|---|---|
| `bun run verify:formal` | runner self-test, digest check, then every manifest check |
| `bun run verify:formal --only <id>` | one check (repeatable); no self-test, no digest check |
| `bun run verify:formal --wide` | TLC checks use their `wideConfig` (nightly) |
| `KVITBIT_FORMAL_WIDE=1 bun run test` | property/exhaustive tests run their wider bounds (nightly) |
| `bun run verify:formal --check-digests` | only compare `coveredFiles` sha256s with the working tree |
| `bun run verify:formal --update-digests [--only <id>]` | only rewrite `coveredFiles` sha256s, for the named checks or every non-blocked check |
| `bun run verify:formal --selftest` | only prove the runner reports failures |
| `bun run typecheck:formal` | typecheck everything under `formal/` (part of `bun run typecheck`) |
| `bun formal/toolchain/toolchain.ts` | fetch and verify the pinned toolchain, print its paths |

Exit status: 0 all passed, 1 a check, digest or self-test failed (or the toolchain failed verification), 2 bad arguments or an invalid manifest. Each run prints per-check and total time. TLC logs land in `formal/.cache/logs/<check>.<run>.log`; read a counterexample with `/statechart`.

## Toolchain

- `toolchain/toolchain.json` pins tla2tools 1.7.4 (URL and sha256) and the JDK major version (17, Temurin).
- `toolchain/toolchain.ts` downloads the jar to `formal/.cache/` (gitignored), verifies the sha256 on every run, and refuses to run TLC on a mismatch. `TLA2TOOLS=/path/to/tla2tools.jar` replaces the download; a relative path is resolved against the current directory, then checksummed the same way, and TLC loads that absolute path. `FORMAL_JAVA=/path/to/java` replaces `java` on PATH; its major version must still be 17.
- JDK 17 for development comes from the root `.mise.toml` (`mise trust && mise install`); CI uses `actions/setup-java` with Temurin 17. A Nix devShell may wrap the same pins later.
- A toolchain bump changes `toolchain.json`, the manifest's `toolchain`, and every TLC check's `toolVersions.tla2tools` in one maintenance change, after rerunning every check.

## Runner contract

### Layout

```
formal/<area>/<Model>.tla                 TLA+ model (module name = file name)
formal/<area>/<Model>.cfg                 base config: must pass
formal/<area>/<Model>_wide.cfg            optional wider bounds for --wide (nightly)
formal/<area>/<Model>_mutant_<name>.cfg   mutant config: must violate
formal/<area>/<Model>_mutant_<name>.tla   optional mutant spec (MODULE <Model>_mutant_<name>)
formal/<area>/<name>.replay.test.ts       bun:test harness replaying model traces on real code
packages/<pkg>/test/**/*.property.test.ts    sampled property tests (run by turbo test)
packages/<pkg>/test/**/*.exhaustive.test.ts  exhaustive finite enumeration (run by turbo test)
**/*.contention.ts                        Postgres 17 contention tests (CI pg-contention job only)
```

Areas so far: `numbering`, `lifecycle`, `idempotency`, `outbox`, plus `selftest` for the runner's own fixtures.

### TLC checks

- Command: `java -XX:+UseParallelGC -cp <jar> tlc2.TLC -workers 1 -fp 0 -lncheck final -cleanup [-deadlock] -metadir formal/.cache/tlc/<run> -config <cfg> <spec>`, run in the spec's directory so sibling modules resolve.
- Deadlock is checked by default; set `"deadlock": "allow"` on the check or a mutant to pass `-deadlock` (terminal states that do not stutter).
- The base (or `wideConfig` under `--wide`) passes only when TLC exits 0, prints `Model checking completed. No error has been found.` and leaves 0 states on the queue.
- A mutant passes only on a genuine violation: exit 11 with `Deadlock reached`, 12 with `Invariant X is violated` or `Action property X is violated`, 13 with `Temporal properties were violated`, `Property X is violated by the initial state` or `Action property X is violated` (TLC 1.7.4 reports a broken `[][A]_v` property with the liveness exit code), or 14 with `Assert evaluated to FALSE`. With `violates`, the kind and name must match too.
- Anything else fails the check, base or mutant: parse or semantic errors (exit 150), config errors (151), TLC exceptions (255), unknown flags, a missing marker, or the timeout (`timeoutSeconds`, default 300; the runner kills TLC and reports an incomplete search).
- Every TLC check ships at least one mutant, and every mutant declares `violates` (with a `name` for invariant and action kinds). The base config, and the wide config if any, must declare that name under `INVARIANT(S)` (invariant kind) or `PROPERTY`/`PROPERTIES` (action and temporal kinds); a name that only appears under `CONSTRAINT` prunes states instead of checking them. The validator reads a .cfg the way TLC's lexer does (`\*` line comments, nested `(* *)` comments, string literals), so a name inside a comment or string does not count. So the base pass covers what the mutant breaks. The manifest is rejected otherwise.
- A base that finds 0 distinct states fails: an unsatisfiable `Init` makes every property hold vacuously.
- No `.cfg` (base, wide or mutant, whatever the check's policy) may set `CHECK_DEADLOCK FALSE`, because a mutant can inherit it; declare `"deadlock": "allow"` in the manifest instead, so the deadlock policy is visible in one place. A mutant expecting a deadlock cannot run with `allow`.
- `--wide` uses `wideTimeoutSeconds` for the wide base when set, else `timeoutSeconds`; mutants always use `timeoutSeconds`.

### Replay checks

The runner runs `bun test ./<path>` from the repo root, once per harness. A harness passes only with exit 0, at least one passing test, and no skipped or todo tests; an empty or skipped replay checks nothing. Harnesses import real code by package name. `formal/tsconfig.json` maps `@kvitbit/*` to package sources, because Bun's isolated linker does not link workspace packages into the root `node_modules`. Bun and `tsc` both read those paths:

```ts
import { expect, test } from "bun:test";
import { makeMemoryStore } from "@kvitbit/core/testing";
import { MoneyMath } from "@kvitbit/domain";
import { Effect } from "effect";
```

A harness that needs a package entry the tsconfig does not map yet adds it to `formal/tsconfig.json` (keep it equal to the package's `exports`). `formal/selftest/imports.replay.test.ts` is the working example.

### Property and exhaustive checks

They live beside their package and run under `bun run test` (turbo). `verify:formal` prints them as skipped, but the digest check covers their `coveredFiles`, so they take part in the maintenance gate.

### Manifest (`formal/manifest.json`, schemaVersion 1)

Top level: `schemaVersion` (1), `syncCommit` (default sync commit for checks without their own), `toolchain` (`{"tla2tools": "1.7.4", "java": 17}`, must equal `toolchain/toolchain.json`), `checks`.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique, `<area>.<name>` |
| `skill` | yes | the `.agents/skills/verify-*` skill that owns the check |
| `tier` | yes | 0 runner fixture, 1 PR gate, 2 Phase 3, 3 optional/nightly |
| `kind` | yes | `tlc`, `replay`, `property` or `exhaustive` |
| `status`, `blockedReason` | no | `blocked` skips the run and turns digest drift into a warning at any tier, so a blocked Tier 1 check no longer gates PRs; needs a reason |
| `syncCommit` | no | last commit the check was confirmed to describe; defaults to the top-level one |
| `spec`, `config`, `wideConfig`, `deadlock` | tlc | repo-relative paths; `wideConfig` only under `--wide` |
| `mutants[]` | tlc, ≥1 | `{name, config?, spec?, expect: "violation", violates: {kind, name?}, deadlock?, description?}` |
| `replay[]` | replay | repo-relative bun test files |
| `command` | property/exhaustive | the command that runs it under turbo test |
| `timeoutSeconds`, `wideTimeoutSeconds` | no | per run; default 300 |
| `coveredFiles[]` | yes | `{path, sha256}` of the product files the check describes |
| `guardedSymbols[]`, `bounds`, `assumptions[]`, `toolVersions` | yes | as recorded in the skill; a TLC check's `toolVersions.tla2tools` must equal the pin |

Example Tier 1 entry:

```json
{
  "id": "numbering.allocator",
  "skill": "verify-numbering",
  "tier": 1,
  "kind": "tlc",
  "syncCommit": "77a5bb7",
  "spec": "formal/numbering/Numbering.tla",
  "config": "formal/numbering/Numbering.cfg",
  "wideConfig": "formal/numbering/Numbering_wide.cfg",
  "mutants": [
    {
      "name": "no-reservation",
      "spec": "formal/numbering/Numbering_mutant_no_reservation.tla",
      "config": "formal/numbering/Numbering_mutant_no_reservation.cfg",
      "expect": "violation",
      "violates": { "kind": "invariant", "name": "NoDuplicateNumber" }
    }
  ],
  "timeoutSeconds": 120,
  "coveredFiles": [{ "path": "packages/core/src/store/numbering.ts", "sha256": "<from --update-digests>" }],
  "guardedSymbols": ["allocateNumber"],
  "bounds": "2 issuers, 1 override, 2 periods, 1 crash point",
  "assumptions": ["Postgres row lock serializes allocation per series"],
  "toolVersions": { "tla2tools": "1.7.4", "java": "17" }
}
```

Add an entry with empty `sha256` strings, then run `bun run verify:formal --update-digests` and `bun run verify:formal --only <id>`.

### Digests and maintenance

`--check-digests` hashes every `coveredFiles` path. Drift on a tier 0 or 1 check fails (the PR gate); drift on tier 2+ or blocked checks warns. The output names each drifted check and skill. Then, per `/maintain-formal-verification-skill`, classify each check as in sync, updated, bug or blocked; a reasoned "no effect" counts as in sync. Commit the verification and digest updates (`--update-digests --only <id>` for each classified check) separately from product fixes, and keep a blocked check's `syncCommit` and digests where they were. The default run reports drift and still runs every check, so CI shows both the drift and whether the checks pass on the changed code.

Contention tests (`*.contention.ts`) read `KVITBIT_CONTENTION_PG_URL` and fail when it is unset; they sit outside bun's default test discovery so package `bun test` runs never reach them. A replay harness that needs `@kvitbit/db` imports it through the mapped `@kvitbit/db` entries (PGlite comes from that package).

## Runner self-test

`formal/selftest/` holds `Counter.tla` with a passing base and two mutants, one breaking an invariant and one an action property (manifest check `selftest.counter`), and `imports.replay.test.ts` (check `selftest.imports`). `negative/` holds fixtures the runner must report as failures on every default run: a mutant that passes, a base that violates, parse errors in a base and a mutant spec, a config naming an undefined invariant, a mutant breaking a different property than declared, a model with 0 states, a TLC timeout, a failing replay harness, a replay that runs no test, and a replay that skips a step. Each case must fail for the reason it provokes, not for an unrelated error in the fixture. It also checks that manifest validation rejects a base or wide config that only constrains the mutant's invariant and any cfg with `CHECK_DEADLOCK FALSE`, that an initial-state property violation is classified by name, and that a replay still parses under `FORCE_COLOR=1`. The self-test also runs TLC through a relative `TLA2TOOLS` override and proves the toolchain fails closed on a wrong checksum, for a `TLA2TOOLS` override and for a download.
