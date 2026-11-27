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

A path in several rows needs every listed skill. `formal/manifest.json` is the exact coverage (covered files with sha256, guarded symbols); when it and this table disagree, the manifest wins.

## Checks

- `bun run verify:formal` runs TLC models with their mutants, replay harnesses and the digest check. Property and exhaustive checks run under `bun run test`.
- When `bun run verify:formal --check-digests` reports drift, run `/maintain-formal-verification-skill` on the named skills and classify each check (in sync, updated, bug, blocked). Put verification and digest updates (`bun run verify:formal --update-digests`) in a commit separate from product fixes.
- A check that finds a bug in product code stays strict: report the counterexample and leave the property as written.
- Call a sampled property test a property test. Only exhaustive enumeration, bounded TLC runs (stated with their bounds) and prover results count as verification.

## Taste

- Keep business rules in the pure Effect core. Put protocol, storage, and framework complexity in adapters. UI renders state and sends intents.
- Use Effect services and operators for asynchronous work, typed failures, recovery, and concurrency. Read environment variables through `Config` and wrap foreign calls with `Effect.try` or `Effect.tryPromise`.
- `tsconfig.effect.json` and `lint/*.grit` enforce the production rules for native async functions, bare Promises, `throw`, and `try/catch`. Run Effects at the entry points listed in `lint/no-direct-effect-runs.grit` or in tests. The plugin scopes in `biome.json` preserve the synchronous SVG error contract and cover DB source relative to its nested Biome config.
- Define service operations with `Effect.fn`. Transport handlers decode input, provide request context, call the core, and encode the result.
- Prefer inferred types. Replace `any` and unsafe assertions with precise types, Schema decoding at boundaries, or domain brand constructors.
- Biome's `nursery.noUnsafeTypeAssertion` rejects ordinary `as` and angle-bracket type assertions and permits const assertions.
- Use comments for constraints, invariants, and external quirks. Keep them to one to four lines.

## Verifying

- Before pushing, run `bun run check:changed`. Use repo-wide checks when requested or required by the formal router. CI runs the full suite.
- During iteration, run `bun test <path>` and `bun run --filter @kvitbit/<package> typecheck`. For root scripts, run `bun run typecheck:scripts`.
- For a guarded change, follow its verification skill and run `bun run verify:formal` as directed above.
- Biome enables the full preset and the domains used by this repo. Its exclusions cover style preferences and size metrics, extensionless Expo imports, Effect namespace imports, public re-exports, and Node and Bun adapter paths.

## Docs discipline

Document what a maintainer could get wrong from reading the code. Keep policy and design reasoning close to their source of truth. Leave inventories of exports and files to the source tree.

## Where code lives

| Area | Source | Read when changing it |
|---|---|---|
| Terms and business concepts | `packages/domain` | [CONTEXT.md](CONTEXT.md) |
| Product behavior and flows | `apps/`, `packages/core` | [PRODUCT.md](PRODUCT.md), [user flows](docs/design/user-flows.md) |
| Core operations and adapters | `packages/core`, `packages/adapters`, `packages/db` | [Core ports](docs/design/core-ports.md) |
| HTTP and MCP | `packages/api-contract`, `apps/server` | [HTTP and MCP contracts](docs/design/http-mcp-contracts.md) |
| UI and presentation contracts | `packages/brand`, `packages/ui-port`, `apps/web`, `apps/mobile` | [DESIGN.md](DESIGN.md), [UI port contracts](docs/design/ui-port-contracts.md) |
| Architecture and verification | `infra/`, `formal/` | [ADRs](docs/adr/), [verification skills](.agents/skills/) |
