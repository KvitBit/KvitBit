# AGENTS.md

Router for formal verification (docs/adr/0005-formal-verification.md). Skills live in `.agents/skills/` (`.claude/skills` links there).

## Verify skills by path

Before you change a file below, read the skill it maps to; after the change, run that skill's checks.

| Paths | Skill |
|---|---|
| `packages/core/src/policy/**` | `verify-auth-policy` |
| `packages/domain/src/money.ts`, `packages/api-contract/src/access.ts` | `verify-money-access` |
| `packages/core/src/engines/{vat,numbering,decimal}.ts`; VAT and deduction code in `packages/core/src/modules/documents/{final,credit,corrections}.ts` | `verify-vat-numbering-math` |
| `packages/core/src/store/numbering.ts`, `packages/core/src/modules/numbering/**`, `formal/numbering/**` | `verify-numbering` |
| `packages/core/src/shared/{idempotency,revision,requestOutcome}.ts` and other request_log or revision CAS code, `formal/idempotency/**` | `verify-idempotency-cas` |
| `packages/core/src/modules/documents/{lifecycle,transitions,final,credit,corrections,payments}.ts`, `packages/core/src/modules/payments/**`, `formal/lifecycle/**` | `verify-document-lifecycle` |
| `packages/core/src/modules/recurring/**`, `packages/core/src/modules/documents/deliveries/**`, `formal/outbox/**` | `verify-outbox-recurring` |

`formal/manifest.json` is the exact coverage (covered files with sha256, guarded symbols); when it and this table disagree, the manifest wins.

## Checks

- `bun run verify:formal` runs TLC models with their mutants, replay harnesses and the digest check. Property and exhaustive checks run under `bun run test`.
- When `bun run verify:formal --check-digests` reports drift, run `/maintain-formal-verification-skill` on the named skills and classify each check (in sync, updated, bug, blocked). Put verification and digest updates (`bun run verify:formal --update-digests`) in a commit separate from product fixes.
- A check that finds a bug in product code stays strict: report the counterexample and leave the property as written.
- Call a sampled property test a property test. Only exhaustive enumeration, bounded TLC runs (stated with their bounds) and prover results count as verification.
