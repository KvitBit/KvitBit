---
name: verify-money-access
description: Exhaustively check Money rounding and arithmetic (packages/domain/src/money.ts) and credential scope normalization and the OAuth scope wire form (packages/api-contract/src/access.ts) against BigInt and bitmask oracles. Use before merging any change to those two files, to `SCOPE_AREAS`/`Scope` in packages/domain/src/scope.ts, or to `CurrencyCode`/`Money` in packages/domain/src/vocabulary.ts.
---

# Verify Money and access scopes

**Property (money).** Rounding is half away from zero at the currency's ISO 4217 minor unit for every residue, symmetric in sign, and add, subtract, negate, compare and sum are exact and never mix currencies.

**Harm (money).** A wrong rounding or minor unit puts the wrong VAT or total on a legally binding tax document, and a silent currency mix adds euros to crowns.

**Property (access).** Normalizing any set of scopes adds `<area>:read` for every `<area>:write`, returns the one canonical order with no unknown or repeated scope, and the OAuth wire form parses as http-mcp-contracts 6.3 says and round-trips every storable custom grant.

**Harm (access).** A wrong expansion gives an API key or MCP client more or less access than the user consented to, or stores a grant the server later reads differently.

This is exhaustive finite enumeration of the real code over the domains below; each domain's size is asserted so a shrinking domain fails the run.

## Does my change touch it?

Covered files and guarded symbols:

- `packages/domain/src/money.ts`: `round`, `toMinorUnits`, `fromMinorUnits`, `minorUnitScale` (`MINOR_UNIT_EXCEPTIONS`), `negate`, `add`, `subtract`, `sum`, `compare`, `equals`, `isZero`, `isNegative`, `zero`, `CurrencyMismatch`
- `packages/api-contract/src/access.ts`: `normalizeScopes`, `ALL_SCOPES`, `READ_SCOPES`, `expandAccess`, `GrantedAccess` / `isGrantedAccessConsistent`, `ScopeFromOAuth`, `accessFromOAuthScopes`, `oauthScopesForGrant`, `OAUTH_SCOPES_SUPPORTED`
- `packages/domain/src/scope.ts`: `SCOPE_AREAS`, `Scope`
- Oracle sources: `docs/design/core-ports.md:1098` (half away from zero), ISO 4217 minor units, `docs/design/http-mcp-contracts.md` lines 87-99 (presets, write adds read) and 1252-1282 (6.3 wire form).

If `git diff 77a5bb7 -- <those paths>` is non-empty, run the checks.

## Run

```sh
bun test --cwd packages/domain test/money.property.test.ts
bun test --cwd packages/api-contract test/access.property.test.ts
```

About 0.6 seconds and 5 seconds. Tool: bun 1.4.2 (root `packageManager`; also confirmed on bun 1.4.4), effect 4.1.4. `bun run test` runs both with their packages.

The repo-wide coverage record is `formal/manifest.json`, kept centrally; `bun run verify:formal --check-digests` reports checks whose covered files changed since they were last confirmed. Update these entries there when you move the sync commit.

## Bounds (exact counts, asserted in the tests)

Money (oracle: BigInt):

- `minorUnitScale` on all 17,576 codes `AAA`..`ZZZ`; `fromMinorUnits`/`toMinorUnits` round trip on each code × 7 unit values (123,032).
- Rounding: one currency per scale that occurs (JPY 0, CZK 2, KWD 3, CLF 4) × 1, 2 and 3 digits below the minor unit with every residue (10 + 100 + 1,000) × 6 whole parts (0, 1, 9, 10, 12,345, 2^60 + 7) × both signs: 53,280 amounts (a fixed count; the test also requires a whole part past 2^53), each checked for `round`, explicit-scale `round`, `toMinorUnits` and `round(-x) = -round(x)`. Amounts already at or coarser than the minor unit: 5,213, unchanged.
- Arithmetic: every pair from the grid v / 10^s, v in -12..12, s in 0..3 (100 values, 10,000 pairs) for add, subtract, commutativity, a - b = a + (-b), compare, equals, and `isZero`/`isNegative` on every grid value; every triple from v in -4..4, s in {0, 3} (5,832) for associativity and `sum`; all 30 ordered pairs of 6 different currencies fail with `CurrencyMismatch{expected, actual}`.

Access (oracle: 20-bit mask, bit 2i read and 2i + 1 write of area i):

- `normalizeScopes` on every subset of the 20 scopes (1,048,576): output is the closure in canonical order; idempotence follows because each closure is itself in the domain.
- Order and duplicate insensitivity, and the plain-vs-Set input: every raw subset of the first five areas and of the last five (2,047).
- `expandAccess` custom and `GrantedAccess` consistency: every closed set (3^10 - 1 non-empty, every storable custom grant) plus the 2,047 half-subsets (61,094 lists).
- `accessFromOAuthScopes`: the 2,047 half-subsets × all 8 combinations of `kvitbit:read`, `kvitbit:write`, `offline_access` (16,376 requests); round trip `oauthScopesForGrant` → `accessFromOAuthScopes` on every storable custom grant (59,048). Wire codec on all 20 scopes; `Scope` rejects other areas and levels.

## Assumptions and what is not covered

- Effect's `BigDecimal` is exact; the oracle compares with `BigDecimal.equals`, so scale (1.5 vs 1.50) is not checked.
- Codes not in ISO 4217's list of non-2-decimal currencies use 2 decimals: a product fallback in `money.ts`, kept as is in the oracle.
- `multiply` and the VAT engine are not covered here (see `verify-vat-numbering-math`).
- The canonical order "per area, read before write, areas in `SCOPE_AREAS` order" comes from `access.ts` and the area list at http-mcp-contracts.md:95; the spec does not otherwise fix an order.
- Schema-backed calls cost 15-40 µs each, so `GrantedAccess` and `accessFromOAuthScopes` run on the closed sets and half-subsets, not all 2^20 raw lists. The role cap on grants (accountant read-only) is server code and not covered.

## Drift or bug?

A failure prints up to five inputs, such as `JPY round(0.5)` or `parse kvitbit:workspace:read kvitbit:read`.

1. Recompute the case by hand from the oracle source above.
2. If the code is wrong, it is a real bug: report the input and expected output in those words with the `money.ts` or `access.ts` line; do not change the oracle to match.
3. If the spec changed on purpose (a new area, a new ISO minor unit, a new preset rule), update the oracle tables and the size assertions, and say so in the PR.

## Update

Edit `ISO_SCALE`, `BY_SCALE`, `AREAS` or the 6.3 expectation in `packages/domain/test/money.property.test.ts` or `packages/api-contract/test/access.property.test.ts` from the spec, never from the code under test; update the asserted counts; run both commands; break the code once (for example `mode: "half-even"` in `money.ts`) to see it fail; revert; then move the sync commit below.

## Coverage record

- Sync commit: `77a5bb7` (verification confirmed to describe the covered files at this commit).
- Able-to-fail, recorded 2026-11-24, each reverted with `git checkout` and re-run green:
  - `money.ts` rounding mode `half-even` → residue test fails (`JPY round(0.5)`, `JPY round(-0.5)`).
  - `money.ts` `ISK` removed from the 0-decimal list → both minor-unit tests fail.
  - `access.ts` `normalizeScopes` no longer adds read for write → normalize test fails (`workspace:write`).
  - `access.ts` `accessFromOAuthScopes` ignores `kvitbit:read` next to per-area scopes → parse test fails (`parse kvitbit:workspace:read kvitbit:read`).
