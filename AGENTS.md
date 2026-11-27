# AGENTS.md

Router for formal verification (docs/adr/0005-formal-verification.md). Skills live in `.agents/skills/` (`.claude/skills` links there).

## Verify skills by path

Before you change a file below, read the skill it maps to; after the change, run that skill's checks.

| Paths | Skill |
|---|---|
| `packages/core/src/policy/**`, `packages/core/src/internal/system.ts`, `packages/domain/src/{action,caller,scope,vocabulary}.ts` | `verify-auth-policy` |
| `packages/domain/src/{money,scope,vocabulary}.ts`, `packages/api-contract/src/access.ts` | `verify-money-access` |
| `packages/core/src/engines/{vat,numbering,decimal,fx,calendar}.ts`, `packages/core/src/modules/documents/{final,credit,corrections,payments,compose,reports}.ts`, `packages/core/src/modules/reports/compute.ts`, `packages/domain/src/vocabulary.ts` | `verify-vat-numbering-math` |
| `packages/core/src/store/{numbering,CoreStore,memory}.ts`, `packages/core/src/modules/numbering/**`, `packages/core/src/modules/documents/{lifecycle,service,record}.ts`, `packages/db/drizzle/20261123175822_init/migration.sql`, `formal/numbering/**` | `verify-numbering` |
| `packages/core/src/shared/{idempotency,revision,requestOutcome}.ts`, `packages/core/src/store/{CoreStore,memory,tables}.ts`, `packages/core/src/modules/contacts/live.ts`, `formal/idempotency/**` | `verify-idempotency-cas` |
| `packages/core/src/modules/documents/{lifecycle,transitions,final,credit,corrections,payments,compose,service}.ts`, `packages/core/src/modules/payments/**`, `packages/core/src/store/memory.ts`, `formal/lifecycle/**` | `verify-document-lifecycle` |
| `packages/core/src/modules/recurring/**`, `packages/core/src/modules/documents/deliveries/**`, `packages/core/src/modules/documents/record.ts`, `packages/core/src/store/{CoreStore,memory}.ts`, `formal/outbox/**` | `verify-outbox-recurring` |
| `apps/server/src/{config-contract,config,main,worker}.ts`, `apps/server/src/wiring/{config,email,blob}.ts`, `apps/server/src/http/mobile/config.ts`, `apps/server/src/runtime/workflows.ts`, `infra/alchemy/src/{deploy-preflight,preflight-cli,config,env}.ts`, `.github/workflows/deploy.yml` | `verify-deploy-config` |

A path in several rows needs every listed skill. `formal/manifest.json` is the exact coverage (covered files with sha256, guarded symbols); when it and this table disagree, the manifest wins.

## Checks

- `bun run verify:formal` runs TLC models with their mutants, replay harnesses and the digest check. Property and exhaustive checks run under `bun run test`.
- When `bun run verify:formal --check-digests` reports drift, run `/maintain-formal-verification-skill` on the named skills and classify each check (in sync, updated, bug, blocked). Put verification and digest updates (`bun run verify:formal --update-digests`) in a commit separate from product fixes.
- A check that finds a bug in product code stays strict: report the counterexample and leave the property as written.
- Call a sampled property test a property test. Only exhaustive enumeration, bounded TLC runs (stated with their bounds) and prover results count as verification.
