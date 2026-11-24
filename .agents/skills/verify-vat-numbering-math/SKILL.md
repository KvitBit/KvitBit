---
name: verify-vat-numbering-math
description: "Check VAT rounding, VAT buckets, CZK conversion, document numbering patterns and the Proforma -> Payment Tax Document -> Final Invoice -> Credit Note chain against independent BigInt and grammar oracles. Use before merging any change to packages/core/src/engines/{vat,decimal,fx,numbering}.ts or to the Final Invoice, Credit Note, correction or payment code in packages/core/src/modules/documents/, and when a VAT, CZK or document-number amount looks wrong."
---

# Verify VAT and numbering math

ADR-0005 Tier 1 checks for `@kvitbit/core`. They run the real engine functions and the real Documents service (in-memory layers) and compare the results to oracles written apart from the engine: bigint arithmetic for money, a character scanner for patterns. They do not call the code they check.

Terms: **verification** means every case in a stated finite space was enumerated. **Property test** means seeded generated inputs. A property test is sampled, so it is not a proof.

## Run

From the repo root (Bun 1.4.2 per `packageManager`; the checks were last run with Bun 1.4.4):

```sh
bun test --cwd packages/core test/engines/vat-rounding.property.test.ts test/engines/numbering.property.test.ts test/engines/advance-chain.property.test.ts
```

Expected: 15 pass, 0 fail, about 4 s in total. One file at a time: `bun test --cwd packages/core test/engines/<file>`. The checks are also part of the normal `bun test` in `packages/core`.

The central coverage record is `formal/manifest.json`. `bun run verify:formal --check-digests` reports any covered file whose content changed since its entry was last confirmed. Both are maintained by the formal-verification foundation stream. If they are not on your branch yet, use the table below.

## Does my change touch this?

Yes, if the diff touches a file in the table, or anything those symbols call: `effect`'s `BigDecimal.round` or `divideUnsafe`, `parseIsoDate` in `packages/core/src/engines/calendar.ts`, `mergeBuckets` or the totals step in `packages/core/src/modules/documents/compose.ts`, `remainingBuckets` in `credit.ts`.

| Check | File | Covered files | Guarded symbols |
|---|---|---|---|
| 1 Rounding residue (verification) | `vat-rounding.property.test.ts` | `packages/core/src/engines/decimal.ts`, `vat.ts`, `fx.ts` | `roundAt`, `divideRound`, `VatMath.calculate` (bucket rounding, rules 3-5), `toCzk` |
| 2 Buckets and CZK (property) | `vat-rounding.property.test.ts` | `packages/core/src/engines/vat.ts`, `fx.ts`, `decimal.ts`; treatments from `packages/domain/src/vocabulary.ts` | `VatMath.calculate`, `TREATMENTS`, `rateFor`, `assemble` (via `calculate`), `toCzk` |
| 3a Pattern grammar (verification) | `numbering.property.test.ts` | `packages/core/src/engines/numbering.ts` | `parsePattern`, `format` |
| 3b Format, periods, limits (property) | `numbering.property.test.ts` | `packages/core/src/engines/numbering.ts`, `calendar.ts` | `format`, `periodKey`, `fitsLength`, `MAX_NUMBER_LENGTH`, `MAX_COUNTER` |
| 4 Advance chain net to zero (property) | `advance-chain.property.test.ts` | `packages/core/src/engines/vat.ts`, `fx.ts`; `packages/core/src/modules/documents/{final,credit,corrections,payments,compose}.ts` | `VatMath.splitAdvance`, `VatMath.fromBuckets`, `VatMath.negate`, `deductionLines`, `issueFinalInvoice`, `remainderSpec`, `deductionBucketsOf`, `partialSpec`, `creditNoteRecord` field `fx`, `issuePaymentTaxDocument`, `mergeBuckets` |

All test files are in `packages/core/test/engines/`.

## What each check promises

**1. Rounding residue (verification).**
- Property: every VatMath rounding is half away from zero to 2 decimals, for every remainder below the minor unit.
- Harm if broken: VAT, bases and CZK VAT on issued tax documents are off by a haléř, and the VAT return disagrees with the documents.
- Space enumerated: `roundAt(x, 2)` for every residue of the dropped digits at scales 3 to 7 (10 + 100 + 1,000 + 10,000 + 100,000 residues), cents 0, 50 and 99 (with and without carry), integer parts 0, 7 and 123456789012345, both signs: 999,990 inputs per sign, 1,999,980 in total. Bottom-up bucket VAT through `calculate`: every base residue mod 100, both rates (21, 12), both signs, at two offsets. Top-down: every gross residue mod 121 and mod 112. `toCzk`: every residue of 0.01 x a 3-decimal rate for quantity 1 (1,000) and quantity 100 (100,000), both signs, plus a large amount.

**2. Buckets and CZK (property, 400 + 400 seeded inputs).**
- Property: lines group into one bucket per (treatment, ratePercent) in `VatTreatment` order (the oracle takes the treatments from the domain contract, not from the engine's `TREATMENTS`), each bucket rounds its own sum, CZK VAT is converted per bucket and summed with no second rounding, and the totals and whole-unit adjustment equal the oracle exactly.
- Harm if broken: zero-rated treatments (exempt, reverse charge, outside scope) merge into one line of the VAT summary, or CZK VAT is rounded twice, so the tax document misstates the VAT.
- Documented residue: engine CZK VAT per bucket is within 0.005 CZK of the exact `vat x rate / quantity`, and the document's CZK VAT is the exact sum of bucket CZK VAT, so it is within 0.005 x (number of buckets) of exact.

**3a. Pattern grammar (verification).**
- Property: `parsePattern` gives the same tokens, reset and rejection reason as the grammar in the `numbering.ts` header, and `format` renders each accepted pattern as the grammar says.
- Harm if broken: a series accepts a pattern that numbers documents wrongly, or rejects a valid one.
- Space enumerated: every string of length 0 to 6 over `Y M N a 1 - space` (137,257 patterns), and every accepted one rendered for counters 1, 10 and 12345.

**3b. Format, periods, limits (property: 2,000 patterns; 500 x 20; 500 x 30; 500 x 30; plus a boundary table).**
- Property: numbers read back to their counter (never truncated); `fitsLength` agrees with the 20-character limit, which the test pins itself (20 passes, 21 fails, also when a counter outgrows its run), and so is the counter ceiling 2^31 - 2 (`MAX_COUNTER`, `checkNextCounter`); within one `periodKey` the same counter gives the same number and distinct counters give distinct numbers; across periods numbers collide only for patterns with `YY` but no `YYYY`, on years a multiple of 100 apart, with the same counter (and the same month for monthly patterns). Valid patterns are generated against the oracle with bounded retries, so an engine that rejects valid patterns fails at once with the pattern instead of hanging.
- Harm if broken: two documents in a period get the same number, or a number changes when only the day changes.
- Cross-period collisions: `YY-NNN` gives `26-001` for 2026 and 2126. This does not cause duplicates. Numbers are reserved per (workspace, kind) and the allocator skips reserved numbers (`packages/core/src/modules/numbering/service.ts`, the `tryReserve` loop), so the later century gets the next free counter.

**4. Advance chain net to zero (property, 120 seeded chains).**
- Property (Filip's decisions 2 and 3): per VAT bucket, document currency is exact: Proforma = Payment Tax Documents + Final Invoice; Final Invoice + its Credit Notes = 0; each Payment Tax Document + its Credit Note = 0. CZK VAT: each PTD uses the CNB fixing of its own receipt day and the Final Invoice that of its tax point, both checked against the fixture (not the service's answer), and each PTD bucket = round2(VAT x that rate). Final Invoice + PTDs = round2(Proforma VAT x the Final Invoice rate), within 0.005 CZK of exact (the documented residue). Credit Notes cancel CZK VAT exactly. A Credit Note keeps the original's FX (rate, quantity, fixing date, source) and VAT rates, even when it is issued on a later day with another CNB fixing.
- Harm if broken: an advance and its Final Invoice declare more or less VAT than the supply, or a storno leaves VAT behind, so the VAT return is wrong.
- Chains: EUR or CZK, prices with or without VAT, 1 to 4 standard or reduced lines, 1 to 3 payments on different receipt days covering all or part of the gross, a Final Invoice, an optional partial credit, a full credit 0 to 2 days later, then a full credit of every PTD. The test asserts that each shape occurs in more than 5 chains.

## Bounds and assumptions

- Check 1 covers scales 3 to 7. The domain sets no limit on line decimals. Larger scales are covered only if `BigDecimal.round` depends on the dropped digits as it does up to scale 7. The integer part is assumed not to matter beyond the three values tried.
- The VAT rate table (`VAT_RATE_TABLE`) has one entry (2024-01-01: 21 / 12), so no date gives a different rate. Check 4 shows the Credit Note keeps the original's `ratePercent`. It cannot show that a different later rate would be ignored. When a second table entry is added, add chains that cross it.
- CNB rates are taken as 3 decimals with quantity 1 or 100 (check 1). Quantity 1000 is not enumerated.
- Check 4 runs the vat_payer regime only, with `CZ_BUYER` and `paymentRounding` `none`, on in-memory layers (`DocumentsTestLayer`) with the TestClock starting 2026-11-23. Postgres, concurrency and other regimes are out of scope.
- Seeds are fixed. On failure the message starts with `seed=<n>`. Rerun the same file and the same seed fails again.

## Coverage record

- Sync commit: `77a5bb7`. The checks describe the covered files as they are at this commit.
- Able-to-fail gate, run on 2026-11-24 at `77a5bb7` (the last four breaks came from review round 1): each break below was applied to the real code, caught, reverted with `git checkout -- <file>`, and the file was green again.

| Break | File | Caught by |
|---|---|---|
| `roundAt` mode `half-even` | `src/engines/decimal.ts` | Check 1 (`roundAt(5e-3) = 0, want 1e-2`; bottom-up and top-down VAT); check 4 (PTD CZK VAT off by 0.01) |
| Buckets keyed by rate only (zero-rated treatments merge) | `src/engines/vat.ts` (`calculate`) | Check 2 (`buckets standard\|21,outside_scope\|0, oracle standard\|21,reverse_charge\|0,outside_scope\|0`) |
| Counter truncated to its width | `src/engines/numbering.ts` (`format`) | Checks 3a and 3b (`format(YYYYN, 10) = 20260`; distinct counters give the same number) |
| Final Invoice deduction VAT re-derived from the PTD base | `src/modules/documents/final.ts` (`deductionLines`) | Check 4 (`Proforma - PTDs - Final Invoice reduced\|12 does not net to zero: vat 0.01`) |
| Partial Credit Note converted at another rate | `src/modules/documents/corrections.ts` (`partialSpec` fx) | Check 4 (`partial Credit Note standard vatCzk ... at the Final Invoice rate`) |
| Credit Note does not inherit FX (`fx: null`) | `src/modules/documents/credit.ts` (Credit Note record) | Check 4 (`Credit Note: fx null, expected [...]`) |
| `outside_scope` dropped from `TREATMENTS` | `src/engines/vat.ts` | Check 2 (`buckets reduced\|12, oracle reduced\|12,outside_scope\|0`) |
| Every PTD converted at the 2026-11-23 fixing | `src/modules/documents/payments.ts` (`issuePaymentTaxDocument`) | Check 4 (`PTD ... (received 2026-11-18): fx [...2026-11-23...], expected [...2026-11-18...]`) |
| `MAX_NUMBER_LENGTH` raised to 21 | `src/engines/numbering.ts` | Checks 3b (oracle disagrees with `too_long`; boundary table) |
| `parsePattern` rejects every pattern | `src/engines/numbering.ts` | Checks 3a and 3b (fail at once: `engine rejects "N"`) |

## When a check fails

Read the message. It names the seed, the document or input, the bucket, and the engine value next to the expected value.

- **Real bug**: the oracle states the rule from the file header (`vat.ts` rules 1-8, the `numbering.ts` grammar, D8 in `final.ts`, D6/D7 in `credit.ts`/`corrections.ts`) or from Filip's decisions, and the engine differs. Do not change the oracle to match. Report the counterexample in the code's words (inputs, expected vs actual, file:line), and fix product code only if that is your task.
- **Drift (intended change)**: the change deliberately alters a rule, for example a new rounding mode, a new token, a new VAT treatment or a second rate-table entry. Update the oracle to the new rule in the same change, cite the rule's new wording in the commit, and rerun the able-to-fail gate for that check.
- **Harness drift**: the chain test fails before its assertions (`chain failed: ...`) because a service signature, fixture or seam changed (`DocumentPayments`, `scenario`, `invoiceInput`). Fix the test harness. This is not a math finding.

## Updating

1. Change the oracle or generator only for an intended rule change (see Drift), and say which rule it now follows.
2. Run the command above until it is green, then repeat the able-to-fail break for the check you changed. It must fail on the break and pass after `git checkout`.
3. Update the bounds, covered files and symbols here, and the matching entries in `formal/manifest.json`. Run `bun run verify:formal --check-digests`.
4. Move the sync commit forward only after you confirm that the checks describe the covered code at the new commit. For gaps left by earlier changes, use `/maintain-formal-verification-skill`.
