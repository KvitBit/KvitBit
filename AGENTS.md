# AGENTS.md

## Rely on CI

Multiple agents share this machine. Let GitHub Actions CI in `.github/workflows/ci.yml` run verification instead of running suites locally.

- Push your branch and read the PR's CI run. CI runs `check:bun-nix`, `lint`, `typecheck`, `test`, `build`, `test:static-mounts`, `verify:formal`, and path-filtered `pg-contention`. Treat a green CI run as proof of verification.
- Do not run repo-wide checks locally unless the user asks: skip `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`, `bun run verify:formal`, and `turbo run ...`. This overrides repo skills for any check CI already runs.
- When debugging a CI failure or writing a new test, run only the single affected test file with `bun test <file>`, or check the single edited file with `bunx biome check <file>`. Run it once after edits settle, not after every small edit.
- Run local generators only when their inputs change: `bun run generate:bun-nix` after editing `bun.lock`, and `bun run verify:formal --update-digests` when updating `formal/manifest.json`.

## Formal verification

Formal checks follow `docs/adr/0005-formal-verification.md`. Skills live in `.agents/skills/`, and `.claude/skills` links there.

Before you change a file below, read the skill it maps to so your edit keeps its invariants. Let CI run the skill's checks on the PR. Run a single check locally, with `bun run verify:formal --only <id>` or one test file, only when debugging a CI failure or maintaining the skill.

| Paths | Skill |
|---|---|
| `packages/core/src/policy/**`, `packages/core/src/internal/system.ts`, `packages/domain/src/{action,caller,scope,vocabulary}.ts` | `verify-auth-policy` |
| `packages/domain/src/{money,scope,vocabulary}.ts`, `packages/api-contract/src/access.ts` | `verify-money-access` |
| `packages/core/src/engines/{vat,numbering,decimal,fx,calendar}.ts`, `packages/core/src/modules/documents/{final,credit,corrections,payments,compose,reports}.ts`, `packages/core/src/modules/reports/compute.ts`, `packages/domain/src/vocabulary.ts` | `verify-vat-numbering-math` |
| `packages/core/src/store/{numbering,CoreStore,memory}.ts`, `packages/core/src/modules/numbering/**`, `packages/core/src/modules/documents/{lifecycle,service,record}.ts`, `packages/db/drizzle/20261123175822_init/migration.sql`, `formal/numbering/**` | `verify-numbering` |
| `packages/core/src/shared/{idempotency,revision,requestOutcome}.ts`, `packages/core/src/store/{CoreStore,memory,tables}.ts`, `packages/core/src/modules/contacts/live.ts`, `formal/idempotency/**` | `verify-idempotency-cas` |
| `packages/core/src/modules/documents/{lifecycle,transitions,final,credit,corrections,payments,compose,service}.ts`, `packages/core/src/modules/payments/**`, `packages/core/src/store/memory.ts`, `formal/lifecycle/**` | `verify-document-lifecycle` |
| `packages/core/src/modules/recurring/**`, `packages/core/src/modules/documents/deliveries/**`, `packages/core/src/modules/documents/record.ts`, `packages/core/src/store/{CoreStore,memory}.ts`, `formal/outbox/**` | `verify-outbox-recurring` |
| `apps/server/src/{app,config-contract,config,main,worker}.ts`, `apps/server/src/wiring/{config,email,blob}.ts`, `apps/server/src/http/{config,mobile/config}.ts`, `apps/server/src/runtime/workflows.ts`, `infra/alchemy/src/{deploy-preflight,preflight-cli,config,env,bootstrap}.ts`, `infra/alchemy/alchemy.run.ts`, `.github/workflows/deploy.yml` | `verify-deploy-config` |

A path in several rows needs every listed skill. `formal/manifest.json` holds the exact coverage of covered files with sha256 and guarded symbols. When it and this table disagree, the manifest wins.

- CI's `formal` job runs TLC models with their mutants, replay harnesses, and the digest check. CI's `check` job runs property and exhaustive tests.
- When CI or `bun run verify:formal --check-digests` reports drift, run `/maintain-formal-verification-skill` on the named skills and classify each check as in sync, updated, bug, or blocked. Put verification and digest updates from `bun run verify:formal --update-digests` in a commit separate from product fixes.
- A check that finds a bug in product code stays strict. Report the counterexample and leave the property as written.
- Call a sampled property test a property test. Only exhaustive enumeration, bounded TLC runs stated with their bounds, and prover results count as verification.
