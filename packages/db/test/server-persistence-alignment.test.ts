import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun uses Node's synchronous filesystem APIs to stage the migration tree.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { VatBreakdown } from "@kvitbit/domain/contract";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const vatBreakdownJson = Schema.toCodecJson(VatBreakdown);
const decodeVatBreakdown = Schema.decodeUnknownEffect(
  Schema.Union([vatBreakdownJson, Schema.fromJsonString(vatBreakdownJson)]),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

// The server persistence alignment migration (20261124135932) must upgrade a populated database
// from the prior schema without failing on existing delivery history (S5) or zeroing out
// accounting projections (core P1/P3/D6/D8).
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const PRE_MIGRATIONS = ["20261123175822_init", "20261124120853_core_record_alignment"] as const;

const wsVat = "0190a000-0000-7000-8000-0000000003a0";
const wsNonVat = "0190a000-0000-7000-8000-0000000003b0";
const wsIdent = "0190a000-0000-7000-8000-0000000003c0";
const contactVat = "0190a000-0000-7000-8000-0000000003a1";
const contactNonVat = "0190a000-0000-7000-8000-0000000003b1";
const contactIdent = "0190a000-0000-7000-8000-0000000003c1";

// Documents
const docMultiDelivery = "0190a000-0000-7000-8000-000000000301";
const docPartialPaid = "0190a000-0000-7000-8000-000000000302";
const docPaidNoTotal = "0190a000-0000-7000-8000-000000000303";
const docOverpaid = "0190a000-0000-7000-8000-000000000304";
const docUnpaidWithRemoved = "0190a000-0000-7000-8000-000000000305";
const docCreditedCorrects = "0190a000-0000-7000-8000-000000000306";
const cnCorrects = "0190a000-0000-7000-8000-000000000307";
const docCreditedBothLinks = "0190a000-0000-7000-8000-000000000308";
const cnBothLinks = "0190a000-0000-7000-8000-000000000309";
const docPartialCreditPaid = "0190a000-0000-7000-8000-00000000030a";
const cnPartialCreditPaid = "0190a000-0000-7000-8000-00000000030b";
const docPartialCreditOverpaid = "0190a000-0000-7000-8000-00000000030c";
const cnPartialCreditOverpaid = "0190a000-0000-7000-8000-00000000030d";
const docEurVatCzkOpen = "0190a000-0000-7000-8000-00000000030e";
const cnEurVatCzkOpen = "0190a000-0000-7000-8000-00000000030f";
const docRoundingOpen = "0190a000-0000-7000-8000-000000000310";
const cnRoundingOpen = "0190a000-0000-7000-8000-000000000311";
const ptdOpen = "0190a000-0000-7000-8000-000000000312";
const ptdCredited = "0190a000-0000-7000-8000-000000000313";
const cnPtdCredited = "0190a000-0000-7000-8000-000000000314";
const finalCovered = "0190a000-0000-7000-8000-000000000315";
const finalOverCovered = "0190a000-0000-7000-8000-000000000316";
const finalDeductionOpen = "0190a000-0000-7000-8000-000000000317";
const cnFinalDeductionOpen = "0190a000-0000-7000-8000-000000000318";
const docDraft = "0190a000-0000-7000-8000-000000000319";
const docProforma = "0190a000-0000-7000-8000-00000000031a";
const docNonVat = "0190a000-0000-7000-8000-00000000031b";
const docIdentTax = "0190a000-0000-7000-8000-00000000031c";
const docIdentOutside = "0190a000-0000-7000-8000-00000000031d";
const finalLegacyNoTotal = "0190a000-0000-7000-8000-00000000031e";
const docIdentRounded = "0190a000-0000-7000-8000-00000000031f";
const cnIdentPartialOutside = "0190a000-0000-7000-8000-000000000320";
const docHistoricalRate = "0190a000-0000-7000-8000-000000000321";
const docRemainderOrig = "0190a000-0000-7000-8000-000000000322";
const cnRemainderPartial = "0190a000-0000-7000-8000-000000000323";
const cnRemainderClosing = "0190a000-0000-7000-8000-000000000324";
const docRemainderNullGrossOrig = "0190a000-0000-7000-8000-000000000325";
const cnRemainderNullGrossPartial = "0190a000-0000-7000-8000-000000000326";
const cnRemainderNullGrossClosing = "0190a000-0000-7000-8000-000000000327";
const docEurTwoPartialsOrig = "0190a000-0000-7000-8000-000000000328";
const cnEurPartial1 = "0190a000-0000-7000-8000-000000000329";
const cnEurPartial2 = "0190a000-0000-7000-8000-00000000032a";
const docEurClosedCzkOrig = "0190a000-0000-7000-8000-00000000032b";
const cnEurClosedPartial1 = "0190a000-0000-7000-8000-00000000032c";
const cnEurClosedPartial2 = "0190a000-0000-7000-8000-00000000032d";
const cnEurClosedLineless = "0190a000-0000-7000-8000-00000000032e";
const docEurOffsetOrig = "0190a000-0000-7000-8000-00000000032f";
const cnEurOffsetPartial1 = "0190a000-0000-7000-8000-000000000330";
const cnEurOffsetPartial2 = "0190a000-0000-7000-8000-000000000331";
const cnEurOffsetLineless = "0190a000-0000-7000-8000-000000000332";

// Deliveries
const del1 = "0190a000-0000-7000-8000-000000000401";
const del2a = "0190a000-0000-7000-8000-000000000402";
const del2b = "0190a000-0000-7000-8000-000000000403";
const del3 = "0190a000-0000-7000-8000-000000000404";
const delOtherDoc = "0190a000-0000-7000-8000-000000000405";
const delOtherWs = "0190a000-0000-7000-8000-000000000406";

// Lines
const lineProbe = "0190a000-0000-7000-8000-000000000501";
const lineFractional = "0190a000-0000-7000-8000-000000000502";
const lineNegative = "0190a000-0000-7000-8000-000000000503";
const lineReduced = "0190a000-0000-7000-8000-000000000504";
const lineReverseCharge = "0190a000-0000-7000-8000-000000000505";
const lineDeduction = "0190a000-0000-7000-8000-000000000506";
const lineHistorical15 = "0190a000-0000-7000-8000-000000000507";

let client: PGlite;
let preDir: string | undefined;

const rows = async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<Array<T>> =>
  (await client.query<T>(sql, [...params])).rows;

const breakdown = (
  buckets: ReadonlyArray<{
    treatment: string;
    ratePercent: string;
    base: string;
    vat: string;
    gross: string;
    vatCzk: string | null;
  }>,
  totals: {
    net: string;
    vat: string;
    gross: string;
    roundingAdjustment?: string;
    currency?: string;
    vatCzk?: string | null;
  },
) => {
  const currency = totals.currency ?? "CZK";
  return encodeJson({
    buckets,
    net: { amount: totals.net, currency },
    vat: { amount: totals.vat, currency },
    roundingAdjustment: { amount: totals.roundingAdjustment ?? "0", currency },
    gross: { amount: totals.gross, currency },
    vatCzk:
      totals.vatCzk === undefined || totals.vatCzk === null
        ? null
        : { amount: totals.vatCzk, currency: "CZK" },
  }).pipe(Effect.runSync);
};

beforeAll(async () => {
  preDir = mkdtempSync(join(tmpdir(), "kvitbit-db-pre-3a-"));
  for (const name of PRE_MIGRATIONS) {
    cpSync(join(migrationsFolder, name), join(preDir, name), { recursive: true });
  }
  client = new PGlite();
  await migrate(drizzle({ client }), { migrationsFolder: preDir });

  const b121 = breakdown(
    [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "100",
        vat: "21",
        gross: "121",
        vatCzk: null,
      },
    ],
    { net: "100", vat: "21", gross: "121" },
  );
  const bNeg121 = breakdown(
    [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "-100",
        vat: "-21",
        gross: "-121",
        vatCzk: null,
      },
    ],
    { net: "-100", vat: "-21", gross: "-121" },
  );
  const b100 = breakdown(
    [
      {
        treatment: "outside_scope",
        ratePercent: "0",
        base: "100",
        vat: "0",
        gross: "100",
        vatCzk: null,
      },
    ],
    { net: "100", vat: "0", gross: "100" },
  );
  const bNeg40 = breakdown(
    [
      {
        treatment: "outside_scope",
        ratePercent: "0",
        base: "-40",
        vat: "0",
        gross: "-40",
        vatCzk: null,
      },
    ],
    { net: "-40", vat: "0", gross: "-40" },
  );
  const bEurOrig = breakdown(
    [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "100",
        vat: "21",
        gross: "121",
        vatCzk: "525",
      },
    ],
    { net: "100", vat: "21", gross: "121", currency: "EUR", vatCzk: "525" },
  );
  const bEurCnMismatch = breakdown(
    [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "-100",
        vat: "-21",
        gross: "-121",
        vatCzk: "-500",
      },
    ],
    { net: "-100", vat: "-21", gross: "-121", currency: "EUR", vatCzk: "-500" },
  );
  const bRounded = breakdown(
    [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "100",
        vat: "21",
        gross: "121",
        vatCzk: null,
      },
    ],
    { net: "100", vat: "21", gross: "121.40", roundingAdjustment: "0.40" },
  );
  const bPtd = breakdown(
    [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "100",
        vat: "21",
        gross: "121",
        vatCzk: null,
      },
    ],
    { net: "100", vat: "21", gross: "121" },
  );
  const bZero = breakdown([], { net: "0", vat: "0", gross: "0" });
  const bNeg20 = breakdown(
    [
      {
        treatment: "outside_scope",
        ratePercent: "0",
        base: "-20",
        vat: "0",
        gross: "-20",
        vatCzk: null,
      },
    ],
    { net: "-20", vat: "0", gross: "-20" },
  );
  const bIdentRounded = breakdown(
    [
      {
        treatment: "reverse_charge",
        ratePercent: "0",
        base: "100",
        vat: "0",
        gross: "100",
        vatCzk: null,
      },
      {
        treatment: "outside_scope",
        ratePercent: "0",
        base: "50.60",
        vat: "0",
        gross: "50.60",
        vatCzk: null,
      },
    ],
    { net: "150.60", vat: "0", gross: "151", roundingAdjustment: "0.40" },
  );
  const bHist15 = breakdown(
    [
      {
        treatment: "reduced",
        ratePercent: "15",
        base: "100",
        vat: "15",
        gross: "115",
        vatCzk: null,
      },
    ],
    { net: "100", vat: "15", gross: "115" },
  );

  await client.exec(`
    insert into workspaces (id, slug, name) values
      ('${wsVat}', 'vat-co', 'VAT Co'),
      ('${wsNonVat}', 'nonvat-co', 'NonVAT Co'),
      ('${wsIdent}', 'ident-co', 'Ident Co');

    insert into tax_regime_periods (workspace_id, effective_from, regime) values
      ('${wsVat}', '2024-01-01', 'vat_payer'),
      ('${wsNonVat}', '2024-01-01', 'non_vat_payer'),
      ('${wsIdent}', '2024-01-01', 'identified_person');

    insert into contacts (id, workspace_id, name) values
      ('${contactVat}', '${wsVat}', 'Buyer VAT'),
      ('${contactNonVat}', '${wsNonVat}', 'Buyer NonVAT'),
      ('${contactIdent}', '${wsIdent}', 'Buyer Ident');

    insert into documents (
      id, workspace_id, kind, status, number, contact_id, currency, language, payment_method,
      issued_on, due_on, total_net, total_vat, total_gross, vat_breakdown, locked,
      fx_rate, fx_quantity, fx_source, cancelled_at
    ) values
      -- Multi-delivery + locked + cancelled_at check
      ('${docMultiDelivery}', '${wsVat}', 'invoice', 'issued', '20260001', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '21.00', '121.00', '${b121}', true, null, null, null, null),
      -- Partially paid (50 of 121)
      ('${docPartialPaid}', '${wsVat}', 'invoice', 'issued', '20260002', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '21.00', '121.00', '${b121}', false, null, null, null, null),
      -- Paid with NULL total_gross & vat_breakdown (exact review probe scenario: 2 * 50 = 100, payment 100)
      ('${docPaidNoTotal}', '${wsNonVat}', 'invoice', 'issued', '20260001', '${contactNonVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', null, null, null, null, false, null, null, null, null),
      -- Overpaid (120 of 100)
      ('${docOverpaid}', '${wsNonVat}', 'invoice', 'issued', '20260002', '${contactNonVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '0.00', '100.00', '${b100}', false, null, null, null, null),
      -- Unpaid with only a soft-deleted payment + cancelled_at
      ('${docUnpaidWithRemoved}', '${wsNonVat}', 'invoice', 'cancelled', '20260003', '${contactNonVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '0.00', '100.00', '${b100}', false, null, null, null, '2026-01-15T23:30:00Z'),
      -- Fully credited via 'corrects' link only
      ('${docCreditedCorrects}', '${wsVat}', 'invoice', 'issued', '20260003', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '21.00', '121.00', '${b121}', true, null, null, null, null),
      ('${cnCorrects}', '${wsVat}', 'credit_note', 'issued', 'CN20260001', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-100.00', '-21.00', '-121.00', '${bNeg121}', false, null, null, null, null),
      -- Fully credited via BOTH 'corrects' and 'corrected_by' links (must not double-count)
      ('${docCreditedBothLinks}', '${wsVat}', 'invoice', 'issued', '20260004', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '21.00', '121.00', '${b121}', true, null, null, null, null),
      ('${cnBothLinks}', '${wsVat}', 'credit_note', 'issued', 'CN20260002', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-100.00', '-21.00', '-121.00', '${bNeg121}', false, null, null, null, null),
      -- Partially credited (100 - 40 = 60) + paid 60 => paid
      ('${docPartialCreditPaid}', '${wsNonVat}', 'invoice', 'issued', '20260004', '${contactNonVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '0.00', '100.00', '${b100}', true, null, null, null, null),
      ('${cnPartialCreditPaid}', '${wsNonVat}', 'credit_note', 'issued', 'CN20260001', '${contactNonVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-40.00', '0.00', '-40.00', '${bNeg40}', false, null, null, null, null),
      -- Partially credited (100 - 40 = 60) + paid 100 => overpaid
      ('${docPartialCreditOverpaid}', '${wsNonVat}', 'invoice', 'issued', '20260005', '${contactNonVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '0.00', '100.00', '${b100}', true, null, null, null, null),
      ('${cnPartialCreditOverpaid}', '${wsNonVat}', 'credit_note', 'issued', 'CN20260002', '${contactNonVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-40.00', '0.00', '-40.00', '${bNeg40}', false, null, null, null, null),
      -- Foreign currency (EUR) with manual FX and unclosed vatCzk (525 - 500 = 25 != 0) => NOT credited
      ('${docEurVatCzkOpen}', '${wsVat}', 'invoice', 'issued', '20260005', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '21.00', '121.00', '${bEurOrig}', true, '25.50', 1, 'manual', null),
      ('${cnEurVatCzkOpen}', '${wsVat}', 'credit_note', 'issued', 'CN20260003', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-100.00', '-21.00', '-121.00', '${bEurCnMismatch}', false, '25.50', 1, 'manual', null),
      -- Whole-unit rounding adjustment left open (0.40 != 0) => NOT credited, payment_rounding = whole_unit
      ('${docRoundingOpen}', '${wsVat}', 'invoice', 'issued', '20260006', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '21.00', '121.40', '${bRounded}', true, null, null, null, null),
      ('${cnRoundingOpen}', '${wsVat}', 'credit_note', 'issued', 'CN20260004', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-100.00', '-21.00', '-121.00', '${bNeg121}', false, null, null, null, null),
      -- Payment Tax Documents: open => paid, fully credited => credited
      ('${ptdOpen}', '${wsVat}', 'payment_tax_document', 'issued', 'PTD20260001', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-10', '100.00', '21.00', '121.00', '${bPtd}', false, null, null, null, null),
      ('${ptdCredited}', '${wsVat}', 'payment_tax_document', 'issued', 'PTD20260002', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-10', '100.00', '21.00', '121.00', '${bPtd}', false, null, null, null, null),
      ('${cnPtdCredited}', '${wsVat}', 'credit_note', 'issued', 'CN20260005', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-100.00', '-21.00', '-121.00', '${bNeg121}', false, null, null, null, null),
      -- Final Invoices covered (gross = 0 => paid) and over-covered (gross = -20 => overpaid)
      ('${finalCovered}', '${wsVat}', 'invoice', 'issued', '20260007', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '0.00', '0.00', '0.00', '${bZero}', false, null, null, null, null),
      ('${finalOverCovered}', '${wsVat}', 'invoice', 'issued', '20260008', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '-20.00', '0.00', '-20.00', '${bNeg20}', false, null, null, null, null),
      -- Final Invoice with open deduction line: buckets net to 0 but deduction not reversed => NOT credited
      ('${finalDeductionOpen}', '${wsVat}', 'invoice', 'issued', '20260009', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '0.00', '0.00', '0.00', '${bZero}', true, null, null, null, null),
      ('${cnFinalDeductionOpen}', '${wsVat}', 'credit_note', 'issued', 'CN20260006', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '0.00', '0.00', '0.00', '${bZero}', false, null, null, null, null),
      -- Draft, Proforma, Non-VAT, Identified Person (tax vs outside_scope)
      ('${docDraft}', '${wsVat}', 'invoice', 'draft', null, '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '0.00', '0.00', '0.00', '${bZero}', false, null, null, null, null),
      ('${docProforma}', '${wsVat}', 'proforma', 'issued', 'PF20260001', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '21.00', '121.00', '${b121}', false, null, null, null, null),
      ('${docNonVat}', '${wsNonVat}', 'invoice', 'issued', '20260006', '${contactNonVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '0.00', '100.00', '${b100}', false, null, null, null, null),
      ('${docIdentTax}', '${wsIdent}', 'invoice', 'issued', '20260001', '${contactIdent}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '0.00', '100.00', '${b100}', false, null, null, null, null),
      ('${docIdentOutside}', '${wsIdent}', 'invoice', 'issued', '20260002', '${contactIdent}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '100.00', '0.00', '100.00', '${b100}', false, null, null, null, null),
      -- Legacy Final Invoice with NULL gross & breakdown: 121 supply less 0.03 advance => 120.97 due
      ('${finalLegacyNoTotal}', '${wsVat}', 'invoice', 'issued', '20260010', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', null, null, null, null, false, null, null, null, null),
      -- Identified-person tax_document=true + whole_unit rounding, partially credited on outside_scope only
      ('${docIdentRounded}', '${wsIdent}', 'invoice', 'issued', '20260003', '${contactIdent}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '150.60', '0.00', '151.00', '${bIdentRounded}', true, null, null, null, null),
      ('${cnIdentPartialOutside}', '${wsIdent}', 'credit_note', 'issued', 'CN20260001', '${contactIdent}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-40.00', '0.00', '-40.00', '${bNeg40}', false, null, null, null, null),
      -- Historical 2023 reduced VAT rate (15%) differing from the 2024+ fallback (12%)
      ('${docHistoricalRate}', '${wsVat}', 'invoice', 'issued', '20230001', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2023-06-10', '2023-06-24', '100.00', '15.00', '115.00', '${bHist15}', false, null, null, null, null),
      -- Partial credit + closing remainder credit (0.03 net + 0.01 VAT; partial -0.02 net; closing -0.01 net, -0.01 VAT)
      ('${docRemainderOrig}', '${wsVat}', 'invoice', 'issued', '20260011', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '0.03', '0.01', '0.04', null, true, null, null, null, null),
      ('${cnRemainderPartial}', '${wsVat}', 'credit_note', 'issued', 'CN20260007', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-11', '2026-01-11', '-0.02', '0.00', '-0.02', null, false, null, null, null, null),
      ('${cnRemainderClosing}', '${wsVat}', 'credit_note', 'issued', 'CN20260008', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-0.01', '-0.01', '-0.02', null, false, null, null, null, null),
      -- Same closing remainder credit but with total_gross = NULL (stored net = -0.01, vat = -0.01)
      ('${docRemainderNullGrossOrig}', '${wsVat}', 'invoice', 'issued', '20260012', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-10', '2026-01-24', '0.03', '0.01', '0.04', null, true, null, null, null, null),
      ('${cnRemainderNullGrossPartial}', '${wsVat}', 'credit_note', 'issued', 'CN20260009', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-11', '2026-01-11', '-0.02', '0.00', '-0.02', null, false, null, null, null, null),
      ('${cnRemainderNullGrossClosing}', '${wsVat}', 'credit_note', 'issued', 'CN20260010', '${contactVat}', 'CZK', 'cs', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-0.01', '-0.01', null, null, false, null, null, null, null),
      -- Two EUR partial credits at 25.4 CZK/EUR: orig VAT 0.02 EUR (0.51 CZK), each partial -0.01 EUR (-0.25 CZK) => 0.01 CZK stays open
      ('${docEurTwoPartialsOrig}', '${wsVat}', 'invoice', 'issued', '20260013', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-10', '2026-01-24', '0.08', '0.02', '0.10', null, true, '25.40', 1, 'cnb', null),
      ('${cnEurPartial1}', '${wsVat}', 'credit_note', 'issued', 'CN20260011', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-11', '2026-01-11', '-0.04', '-0.01', '-0.05', null, false, '25.40', 1, 'cnb', null),
      ('${cnEurPartial2}', '${wsVat}', 'credit_note', 'issued', 'CN20260012', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-0.04', '-0.01', '-0.05', null, false, '25.40', 1, 'cnb', null),
      -- Same two EUR partials followed by a line-less full correction closing the 0.01 CZK VAT residual
      ('${docEurClosedCzkOrig}', '${wsVat}', 'invoice', 'issued', '20260014', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-10', '2026-01-24', '0.08', '0.02', '0.10', null, true, '25.40', 1, 'cnb', null),
      ('${cnEurClosedPartial1}', '${wsVat}', 'credit_note', 'issued', 'CN20260013', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-11', '2026-01-11', '-0.04', '-0.01', '-0.05', null, false, '25.40', 1, 'cnb', null),
      ('${cnEurClosedPartial2}', '${wsVat}', 'credit_note', 'issued', 'CN20260014', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-0.04', '-0.01', '-0.05', null, false, '25.40', 1, 'cnb', null),
      ('${cnEurClosedLineless}', '${wsVat}', 'credit_note', 'issued', 'CN20260015', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-13', '2026-01-13', '0.00', '0.00', '0.00', null, false, '25.40', 1, 'cnb', null),
      -- Offsetting CZK VAT residuals across standard (-0.01) and reduced (+0.01) buckets (sum = 0)
      ('${docEurOffsetOrig}', '${wsVat}', 'invoice', 'issued', '20260015', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-10', '2026-01-24', '0.58', '0.08', '0.66', null, true, '25.40', 1, 'cnb', null),
      ('${cnEurOffsetPartial1}', '${wsVat}', 'credit_note', 'issued', 'CN20260016', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-11', '2026-01-11', '-0.21', '-0.03', '-0.24', null, false, '25.40', 1, 'cnb', null),
      ('${cnEurOffsetPartial2}', '${wsVat}', 'credit_note', 'issued', 'CN20260017', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-12', '2026-01-12', '-0.37', '-0.05', '-0.42', null, false, '25.40', 1, 'cnb', null),
      ('${cnEurOffsetLineless}', '${wsVat}', 'credit_note', 'issued', 'CN20260018', '${contactVat}', 'EUR', 'en', 'bank_transfer',
       '2026-01-13', '2026-01-13', '0.00', '0.00', '0.00', null, false, '25.40', 1, 'cnb', null);

    insert into document_lines (
      id, workspace_id, document_id, position, description, quantity, unit_price, vat,
      deducts_document_id, deducted_vat
    ) values
      ('${lineProbe}', '${wsNonVat}', '${docPaidNoTotal}', 1, 'Consulting', '2', '50', 'outside_scope', null, null),
      ('${lineFractional}', '${wsVat}', '${docMultiDelivery}', 1, 'Hours', '1.5', '33.333', 'standard', null, null),
      ('${lineNegative}', '${wsVat}', '${docMultiDelivery}', 2, 'Discount', '-1', '10', 'standard', null, null),
      ('${lineReduced}', '${wsVat}', '${docPartialPaid}', 1, 'Books', '3', '100', 'reduced', null, null),
      ('${lineReverseCharge}', '${wsIdent}', '${docIdentTax}', 1, 'EU service', '1', '100', 'reverse_charge', null, null),
      (gen_random_uuid(), '${wsIdent}', '${docIdentOutside}', 1, 'Local', '1', '100', 'outside_scope', null, null),
      ('${lineDeduction}', '${wsVat}', '${finalDeductionOpen}', 1, 'Advance deduction', '-1', '100', 'standard', '${ptdOpen}', '-21.00'),
      (gen_random_uuid(), '${wsVat}', '${finalLegacyNoTotal}', 1, 'Supply', '1', '100', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${finalLegacyNoTotal}', 2, 'Advance', '-1', '0.02', 'standard', '${ptdOpen}', '-0.01'),
      (gen_random_uuid(), '${wsIdent}', '${docIdentRounded}', 1, 'EU service', '1', '100', 'reverse_charge', null, null),
      (gen_random_uuid(), '${wsIdent}', '${docIdentRounded}', 2, 'Local', '1', '50.60', 'outside_scope', null, null),
      (gen_random_uuid(), '${wsIdent}', '${cnIdentPartialOutside}', 1, 'Local credit', '-1', '40', 'outside_scope', null, null),
      ('${lineHistorical15}', '${wsVat}', '${docHistoricalRate}', 1, '2023 books', '1', '100', 'reduced', null, null),
      (gen_random_uuid(), '${wsVat}', '${docRemainderOrig}', 1, 'Micro supply', '1', '0.03', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnRemainderPartial}', 1, 'Partial credit', '-1', '0.02', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnRemainderClosing}', 1, 'Closing credit', '-1', '0.01', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${docRemainderNullGrossOrig}', 1, 'Micro supply', '1', '0.03', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnRemainderNullGrossPartial}', 1, 'Partial credit', '-1', '0.02', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnRemainderNullGrossClosing}', 1, 'Closing credit', '-1', '0.01', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${docEurTwoPartialsOrig}', 1, 'EUR micro', '2', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnEurPartial1}', 1, 'EUR partial 1', '-1', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnEurPartial2}', 1, 'EUR partial 2', '-1', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${docEurClosedCzkOrig}', 1, 'EUR micro', '2', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnEurClosedPartial1}', 1, 'EUR partial 1', '-1', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnEurClosedPartial2}', 1, 'EUR partial 2', '-1', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${docEurOffsetOrig}', 1, 'EUR std', '2', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${docEurOffsetOrig}', 2, 'EUR red', '1', '0.50', 'reduced', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnEurOffsetPartial1}', 1, 'EUR std p1', '-1', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnEurOffsetPartial1}', 2, 'EUR red p1', '-1', '0.17', 'reduced', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnEurOffsetPartial2}', 1, 'EUR std p2', '-1', '0.04', 'standard', null, null),
      (gen_random_uuid(), '${wsVat}', '${cnEurOffsetPartial2}', 2, 'EUR red p2', '-1', '0.33', 'reduced', null, null);

    insert into document_relations (workspace_id, from_document_id, to_document_id, relation) values
      -- 'corrects' only
      ('${wsVat}', '${cnCorrects}', '${docCreditedCorrects}', 'corrects'),
      -- both 'corrects' and 'corrected_by'
      ('${wsVat}', '${cnBothLinks}', '${docCreditedBothLinks}', 'corrects'),
      ('${wsVat}', '${docCreditedBothLinks}', '${cnBothLinks}', 'corrected_by'),
      -- partial credits
      ('${wsNonVat}', '${cnPartialCreditPaid}', '${docPartialCreditPaid}', 'corrects'),
      ('${wsNonVat}', '${cnPartialCreditOverpaid}', '${docPartialCreditOverpaid}', 'corrects'),
      -- EUR vatCzk mismatch
      ('${wsVat}', '${cnEurVatCzkOpen}', '${docEurVatCzkOpen}', 'corrects'),
      -- rounding open
      ('${wsVat}', '${cnRoundingOpen}', '${docRoundingOpen}', 'corrects'),
      -- credited PTD (via 'corrected_by' only)
      ('${wsVat}', '${ptdCredited}', '${cnPtdCredited}', 'corrected_by'),
      -- Final Invoice with open deduction
      ('${wsVat}', '${cnFinalDeductionOpen}', '${finalDeductionOpen}', 'corrects'),
      -- Partial outside-scope credit note against identified-person rounded tax document
      ('${wsIdent}', '${cnIdentPartialOutside}', '${docIdentRounded}', 'corrects'),
      -- Partial + closing remainder credits
      ('${wsVat}', '${cnRemainderPartial}', '${docRemainderOrig}', 'corrects'),
      ('${wsVat}', '${cnRemainderClosing}', '${docRemainderOrig}', 'corrects'),
      -- Partial + closing remainder credits with NULL total_gross
      ('${wsVat}', '${cnRemainderNullGrossPartial}', '${docRemainderNullGrossOrig}', 'corrects'),
      ('${wsVat}', '${cnRemainderNullGrossClosing}', '${docRemainderNullGrossOrig}', 'corrects'),
      -- Two EUR partial credits leaving 0.01 CZK VAT open
      ('${wsVat}', '${cnEurPartial1}', '${docEurTwoPartialsOrig}', 'corrects'),
      ('${wsVat}', '${cnEurPartial2}', '${docEurTwoPartialsOrig}', 'corrects'),
      -- Two EUR partial credits + line-less full correction closing the 0.01 CZK VAT residual
      ('${wsVat}', '${cnEurClosedPartial1}', '${docEurClosedCzkOrig}', 'corrects'),
      ('${wsVat}', '${cnEurClosedPartial2}', '${docEurClosedCzkOrig}', 'corrects'),
      ('${wsVat}', '${cnEurClosedLineless}', '${docEurClosedCzkOrig}', 'corrects'),
      -- Offsetting CZK VAT residuals across standard and reduced buckets
      ('${wsVat}', '${cnEurOffsetPartial1}', '${docEurOffsetOrig}', 'corrects'),
      ('${wsVat}', '${cnEurOffsetPartial2}', '${docEurOffsetOrig}', 'corrects'),
      ('${wsVat}', '${cnEurOffsetLineless}', '${docEurOffsetOrig}', 'corrects');

    insert into payments (id, workspace_id, document_id, amount, currency, paid_on, method, removed_at) values
      -- Partially paid: 50 of 121
      (gen_random_uuid(), '${wsVat}', '${docPartialPaid}', '50.00', 'CZK', '2026-01-12', 'bank_transfer', null),
      -- Paid (probe scenario): 100 of 100
      (gen_random_uuid(), '${wsNonVat}', '${docPaidNoTotal}', '100.00', 'CZK', '2026-01-12', 'bank_transfer', null),
      -- Legacy Final Invoice: 121 - 0.03 = 120.97 paid in full
      (gen_random_uuid(), '${wsVat}', '${finalLegacyNoTotal}', '120.97', 'CZK', '2026-01-12', 'bank_transfer', null),
      -- Overpaid: 70 + 50 = 120 of 100, plus a soft-deleted payment of 999
      (gen_random_uuid(), '${wsNonVat}', '${docOverpaid}', '70.00', 'CZK', '2026-01-12', 'bank_transfer', null),
      (gen_random_uuid(), '${wsNonVat}', '${docOverpaid}', '50.00', 'CZK', '2026-01-13', 'bank_transfer', null),
      (gen_random_uuid(), '${wsNonVat}', '${docOverpaid}', '999.00', 'CZK', '2026-01-14', 'bank_transfer', now()),
      -- Unpaid: only soft-deleted payment
      (gen_random_uuid(), '${wsNonVat}', '${docUnpaidWithRemoved}', '100.00', 'CZK', '2026-01-12', 'bank_transfer', now()),
      -- Partial credit (owed 60): paid 60
      (gen_random_uuid(), '${wsNonVat}', '${docPartialCreditPaid}', '60.00', 'CZK', '2026-01-13', 'bank_transfer', null),
      -- Partial credit (owed 60): paid 100 before credit
      (gen_random_uuid(), '${wsNonVat}', '${docPartialCreditOverpaid}', '100.00', 'CZK', '2026-01-11', 'bank_transfer', null);

    insert into deliveries (
      id, workspace_id, document_id, document_revision, purpose, status, recipients,
      language, subject, render_model, sent_at, failure, created_at, updated_at
    ) values
      -- Four deliveries for docMultiDelivery, including two at the exact same created_at
      ('${del1}', '${wsVat}', '${docMultiDelivery}', 1, 'document', 'sent', '{buyer@example.test}',
       'cs', 'Invoice 1', '{}', '2026-01-10T10:00:05Z', null, '2026-01-10T10:00:00Z', '2026-01-10T10:00:05Z'),
      ('${del2b}', '${wsVat}', '${docMultiDelivery}', 1, 'reminder', 'failed', '{buyer@example.test}',
       'cs', 'Reminder 2', '{}', null, 'smtp_timeout', '2026-01-25T08:00:00Z', '2026-01-25T08:00:10Z'),
      ('${del2a}', '${wsVat}', '${docMultiDelivery}', 1, 'reminder', 'queued', '{buyer@example.test}',
       'cs', 'Reminder 1', '{}', null, null, '2026-01-25T08:00:00Z', '2026-01-25T08:00:00Z'),
      ('${del3}', '${wsVat}', '${docMultiDelivery}', 1, 'reminder', 'skipped', '{buyer@example.test}',
       'cs', 'Reminder 3', '{}', null, null, '2026-01-30T08:00:00Z', '2026-01-30T08:00:00Z'),
      -- Delivery for a different document in the same workspace
      ('${delOtherDoc}', '${wsVat}', '${docPartialPaid}', 1, 'document', 'sent', '{buyer@example.test}',
       'cs', 'Invoice 2', '{}', '2026-01-10T11:00:05Z', null, '2026-01-10T11:00:00Z', '2026-01-10T11:00:05Z'),
      -- Delivery for a document in a different workspace
      ('${delOtherWs}', '${wsNonVat}', '${docPaidNoTotal}', 1, 'document', 'sending', '{nonvat@example.test}',
       'cs', 'Invoice NV', '{}', null, null, '2026-01-10T12:00:00Z', '2026-01-10T12:00:00Z');
  `);

  // Upgrade to the full migration chain (includes 20261124135932_server_persistence_alignment).
  await migrate(drizzle({ client }), { migrationsFolder });
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (preDir !== undefined) rmSync(preDir, { recursive: true, force: true });
});

describe("server persistence alignment migration (populated upgrade)", () => {
  test("backfills distinct delivery sequences in stable historical order and preserves metadata", async () => {
    const multi = await rows<{
      id: string;
      sequence: number;
      contact_id: string | null;
      due_on: string | null;
      attempts: number;
    }>(
      `select id, sequence, contact_id, due_on::text as due_on, attempts
       from deliveries where document_id = $1 order by sequence asc`,
      [docMultiDelivery],
    );
    expect(multi).toEqual([
      { id: del1, sequence: 1, contact_id: contactVat, due_on: "2026-01-24", attempts: 1 },
      // del2a and del2b share created_at; del2a (...402) orders before del2b (...403)
      { id: del2a, sequence: 2, contact_id: contactVat, due_on: "2026-01-24", attempts: 0 },
      { id: del2b, sequence: 3, contact_id: contactVat, due_on: "2026-01-24", attempts: 1 },
      { id: del3, sequence: 4, contact_id: contactVat, due_on: "2026-01-24", attempts: 0 },
    ]);

    const others = await rows<{ id: string; sequence: number; attempts: number }>(
      "select id, sequence, attempts from deliveries where id in ($1, $2) order by id asc",
      [delOtherDoc, delOtherWs],
    );
    expect(others).toEqual([
      { id: delOtherDoc, sequence: 1, attempts: 1 },
      { id: delOtherWs, sequence: 1, attempts: 1 },
    ]);

    // Unique index is enforced after backfill.
    await expect(
      client.query(
        `insert into deliveries (
           id, workspace_id, document_id, sequence, document_revision, purpose,
           recipients, language, subject, render_model
         ) values (
           gen_random_uuid(), $1, $2, 1, 1, 'document', '{dup@example.test}', 'cs', 'Dup', '{}'
         )`,
        [wsVat, docMultiDelivery],
      ),
    ).rejects.toThrow("deliveries_document_sequence");
  });

  test("backfills exact unrounded line amounts and VAT rate_percent including stored historical rates", async () => {
    const lines = await rows<{ id: string; rate_percent: string; amount: string }>(
      `select id, rate_percent::text as rate_percent, amount::text as amount
       from document_lines
       where id in ($1, $2, $3, $4, $5, $6, $7)
       order by id asc`,
      [
        lineProbe,
        lineFractional,
        lineNegative,
        lineReduced,
        lineReverseCharge,
        lineDeduction,
        lineHistorical15,
      ],
    );
    expect(lines).toEqual([
      { id: lineProbe, rate_percent: "0", amount: "100" },
      { id: lineFractional, rate_percent: "21", amount: "49.9995" },
      { id: lineNegative, rate_percent: "21", amount: "-10" },
      { id: lineReduced, rate_percent: "12", amount: "300" },
      { id: lineReverseCharge, rate_percent: "0", amount: "100" },
      { id: lineDeduction, rate_percent: "21", amount: "-100" },
      // Preserves stored 2023 reduced rate (15%) instead of the 2024+ fallback (12%)
      { id: lineHistorical15, rate_percent: "15", amount: "100" },
    ]);
  });

  test("backfills document paid_amount, payments and settlement across payments, credits and advances", async () => {
    const docs = await rows<{
      id: string;
      paid_amount: string;
      payments: number;
      settlement: string;
    }>(
      `select id, paid_amount::text as paid_amount, payments, settlement::text as settlement
       from documents`,
    );
    const byId = new Map(Arr.map(docs, (d) => [d.id, d]));

    expect(byId.get(docMultiDelivery)).toEqual({
      id: docMultiDelivery,
      paid_amount: "0",
      payments: 0,
      settlement: "unpaid",
    });
    expect(byId.get(docPartialPaid)).toEqual({
      id: docPartialPaid,
      paid_amount: "50",
      payments: 1,
      settlement: "partially_paid",
    });
    // Exact review probe scenario: 2 * 50 line, 100 payment, NULL total_gross
    expect(byId.get(docPaidNoTotal)).toEqual({
      id: docPaidNoTotal,
      paid_amount: "100",
      payments: 1,
      settlement: "paid",
    });
    // Legacy Final Invoice with NULL gross & breakdown: supply 121 less 0.03 advance = 120.97 paid
    expect(byId.get(finalLegacyNoTotal)).toEqual({
      id: finalLegacyNoTotal,
      paid_amount: "120.97",
      payments: 1,
      settlement: "paid",
    });
    expect(byId.get(docOverpaid)).toEqual({
      id: docOverpaid,
      paid_amount: "120",
      payments: 2,
      settlement: "overpaid",
    });
    expect(byId.get(docUnpaidWithRemoved)).toEqual({
      id: docUnpaidWithRemoved,
      paid_amount: "0",
      payments: 0,
      settlement: "unpaid",
    });

    // Credit Note relationships (corrects only, both directions, partial credits, closing remainder)
    expect(byId.get(docCreditedCorrects)?.settlement).toBe("credited");
    expect(byId.get(cnCorrects)?.settlement).toBe("unpaid");
    expect(byId.get(docCreditedBothLinks)?.settlement).toBe("credited");
    expect(byId.get(cnBothLinks)?.settlement).toBe("unpaid");
    expect(byId.get(docRemainderOrig)?.settlement).toBe("credited");
    expect(byId.get(cnRemainderClosing)?.settlement).toBe("unpaid");
    expect(byId.get(docRemainderNullGrossOrig)?.settlement).toBe("credited");
    expect(byId.get(cnRemainderNullGrossClosing)?.settlement).toBe("unpaid");
    // Two EUR partial credits leave 0.01 CZK VAT open (0.51 - 0.25 - 0.25), so NOT credited
    expect(byId.get(docEurTwoPartialsOrig)?.settlement).toBe("paid");
    // Adding a line-less closing credit closes the 0.01 CZK VAT residual, marking original credited
    expect(byId.get(docEurClosedCzkOrig)?.settlement).toBe("credited");
    expect(byId.get(cnEurClosedLineless)?.settlement).toBe("unpaid");
    // Offsetting CZK VAT residuals (-0.01 standard, +0.01 reduced, sum 0) also close original to credited
    expect(byId.get(docEurOffsetOrig)?.settlement).toBe("credited");
    expect(byId.get(cnEurOffsetLineless)?.settlement).toBe("unpaid");
    expect(byId.get(docPartialCreditPaid)).toEqual({
      id: docPartialCreditPaid,
      paid_amount: "60",
      payments: 1,
      settlement: "paid",
    });
    expect(byId.get(docPartialCreditOverpaid)).toEqual({
      id: docPartialCreditOverpaid,
      paid_amount: "100",
      payments: 1,
      settlement: "overpaid",
    });

    // Credit closure invariants: open vatCzk, open roundingAdjustment, open deduction
    expect(byId.get(docEurVatCzkOpen)?.settlement).toBe("paid"); // owed = 0, not fully credited
    expect(byId.get(docRoundingOpen)?.settlement).toBe("unpaid"); // owed = 0.40, 0 payments
    expect(byId.get(finalDeductionOpen)?.settlement).toBe("paid"); // owed = 0, deduction still open

    // PTDs, Final Invoices, Draft
    expect(byId.get(ptdOpen)?.settlement).toBe("paid");
    expect(byId.get(ptdCredited)?.settlement).toBe("credited");
    expect(byId.get(finalCovered)?.settlement).toBe("paid");
    expect(byId.get(finalOverCovered)?.settlement).toBe("overpaid");
    expect(byId.get(docDraft)?.settlement).toBe("unpaid");
  });

  test("backfills accounting metadata (tax_document, payment_rounding, fx_override, locked_at, corrected_number, cancelled_on)", async () => {
    const meta = await rows<{
      id: string;
      tax_document: boolean;
      payment_rounding: string;
      fx_override: unknown;
      locked_at: string | null;
      corrected_number: string | null;
      cancelled_on: string | null;
    }>(
      `select id, tax_document, payment_rounding::text as payment_rounding, fx_override,
              locked_at::text as locked_at, corrected_number, cancelled_on::text as cancelled_on
       from documents`,
    );
    const byId = new Map(Arr.map(meta, (m) => [m.id, m]));

    expect(byId.get(docMultiDelivery)?.tax_document).toBe(true);
    expect(byId.get(docMultiDelivery)?.locked_at).not.toBeNull();
    expect(byId.get(docProforma)?.tax_document).toBe(false);
    expect(byId.get(ptdOpen)?.tax_document).toBe(true);
    expect(byId.get(docNonVat)?.tax_document).toBe(false);
    expect(byId.get(docIdentTax)?.tax_document).toBe(true);
    expect(byId.get(docIdentOutside)?.tax_document).toBe(false);

    expect(byId.get(docRoundingOpen)?.payment_rounding).toBe("whole_unit");
    expect(byId.get(docMultiDelivery)?.payment_rounding).toBe("none");

    expect(byId.get(docEurVatCzkOpen)?.fx_override).toEqual({
      manual: { rate: "25.5", quantity: 1 },
    });

    expect(byId.get(cnCorrects)?.corrected_number).toBe("20260003");
    expect(byId.get(cnPtdCredited)?.corrected_number).toBe("PTD20260002");

    // Partial outside-scope credit note inherits tax_document and payment_rounding from its original
    expect(byId.get(docIdentRounded)?.tax_document).toBe(true);
    expect(byId.get(docIdentRounded)?.payment_rounding).toBe("whole_unit");
    expect(byId.get(cnIdentPartialOutside)?.tax_document).toBe(true);
    expect(byId.get(cnIdentPartialOutside)?.payment_rounding).toBe("whole_unit");
    expect(byId.get(cnIdentPartialOutside)?.corrected_number).toBe("20260003");

    // 2026-01-15T23:30:00Z is 2026-01-16 00:30:00 in Europe/Prague (CET, UTC+1)
    expect(byId.get(docUnpaidWithRemoved)?.cancelled_on).toBe("2026-01-16");
  });

  test("persists valid VatBreakdown decoded by the production codec for every upgraded document", async () => {
    const allDocs = await rows<{
      id: string;
      vat_breakdown: unknown;
      total_net: string | null;
      total_vat: string | null;
      total_gross: string | null;
    }>(
      "select id, vat_breakdown, total_net::text, total_vat::text, total_gross::text from documents",
    );
    expect(allDocs.length).toBeGreaterThan(20);

    const decoded = new Map<string, VatBreakdown>();
    for (const doc of allDocs) {
      expect(doc.vat_breakdown).not.toBeNull();
      decoded.set(doc.id, decodeVatBreakdown(doc.vat_breakdown).pipe(Effect.runSync));
    }

    const legacyPaid = decoded.get(docPaidNoTotal);
    if (legacyPaid === undefined) throw new Error("Missing paid document with no total");
    expect(legacyPaid.net.amount.pipe(BigDecimal.format)).toBe("100");
    expect(legacyPaid.vat.amount.pipe(BigDecimal.format)).toBe("0");
    expect(legacyPaid.gross.amount.pipe(BigDecimal.format)).toBe("100");
    expect(legacyPaid.buckets).toHaveLength(1);

    const legacyFinal = decoded.get(finalLegacyNoTotal);
    if (legacyFinal === undefined) throw new Error("missing finalLegacyNoTotal");
    expect(legacyFinal.net.amount.pipe(BigDecimal.format)).toBe("99.98");
    expect(legacyFinal.vat.amount.pipe(BigDecimal.format)).toBe("20.99");
    expect(legacyFinal.gross.amount.pipe(BigDecimal.format)).toBe("120.97");
    expect(legacyFinal.buckets).toHaveLength(1);
    const firstBucket = legacyFinal.buckets[0];
    if (firstBucket === undefined) throw new Error("missing finalLegacyNoTotal bucket");
    expect(firstBucket.gross.pipe(BigDecimal.format)).toBe("120.97");

    // Closing remainder credit note preserves leftover VAT (-0.01) with zero roundingAdjustment
    const closingCredit = decoded.get(cnRemainderClosing);
    if (closingCredit === undefined) throw new Error("missing cnRemainderClosing");
    expect(closingCredit.net.amount.pipe(BigDecimal.format)).toBe("-0.01");
    expect(closingCredit.vat.amount.pipe(BigDecimal.format)).toBe("-0.01");
    expect(closingCredit.roundingAdjustment.amount.pipe(BigDecimal.format)).toBe("0");
    expect(closingCredit.gross.amount.pipe(BigDecimal.format)).toBe("-0.02");
    expect(closingCredit.buckets).toHaveLength(1);
    const closingBucket = closingCredit.buckets[0];
    if (closingBucket === undefined) throw new Error("missing cnRemainderClosing bucket");
    expect(closingBucket.vat.pipe(BigDecimal.format)).toBe("-0.01");

    // Closing remainder credit note with NULL total_gross reconciles VAT (-0.01) and gross (-0.02)
    const closingNullGross = decoded.get(cnRemainderNullGrossClosing);
    if (closingNullGross === undefined) throw new Error("missing cnRemainderNullGrossClosing");
    expect(closingNullGross.net.amount.pipe(BigDecimal.format)).toBe("-0.01");
    expect(closingNullGross.vat.amount.pipe(BigDecimal.format)).toBe("-0.01");
    expect(closingNullGross.roundingAdjustment.amount.pipe(BigDecimal.format)).toBe("0");
    expect(closingNullGross.gross.amount.pipe(BigDecimal.format)).toBe("-0.02");

    // Two EUR partial credits keep -0.25 CZK VAT each (never silently reassigned to -0.26)
    const eurPartial1 = decoded.get(cnEurPartial1);
    const eurPartial2 = decoded.get(cnEurPartial2);
    if (eurPartial1 === undefined || eurPartial2 === undefined) {
      throw new Error("missing EUR partial credits");
    }
    expect(eurPartial1.vatCzk).not.toBeNull();
    expect(eurPartial2.vatCzk).not.toBeNull();
    if (eurPartial1.vatCzk === null || eurPartial2.vatCzk === null) {
      throw new Error("missing EUR vatCzk");
    }
    expect(eurPartial1.vatCzk.amount.pipe(BigDecimal.format)).toBe("-0.25");
    expect(eurPartial2.vatCzk.amount.pipe(BigDecimal.format)).toBe("-0.25");

    // Line-less closing credit closes the 0.01 CZK VAT residual with exact bucket and total vatCzk
    const eurLineless = decoded.get(cnEurClosedLineless);
    if (eurLineless === undefined) throw new Error("missing cnEurClosedLineless");
    expect(eurLineless.net.amount.pipe(BigDecimal.format)).toBe("0");
    expect(eurLineless.vat.amount.pipe(BigDecimal.format)).toBe("0");
    expect(eurLineless.gross.amount.pipe(BigDecimal.format)).toBe("0");
    expect(eurLineless.vatCzk).not.toBeNull();
    if (eurLineless.vatCzk === null) throw new Error("missing cnEurClosedLineless vatCzk");
    expect(eurLineless.vatCzk.amount.pipe(BigDecimal.format)).toBe("-0.01");
    expect(eurLineless.buckets).toHaveLength(1);
    const eurLinelessBucket = eurLineless.buckets[0];
    if (eurLinelessBucket === undefined || eurLinelessBucket.vatCzk === null) {
      throw new Error("missing cnEurClosedLineless bucket vatCzk");
    }
    expect(eurLinelessBucket.treatment).toBe("standard");
    expect(eurLinelessBucket.vatCzk.pipe(BigDecimal.format)).toBe("-0.01");

    // Offsetting-bucket line-less closing credit preserves both signed buckets (-0.01, +0.01) and total 0 CZK
    const eurOffset = decoded.get(cnEurOffsetLineless);
    if (eurOffset === undefined) throw new Error("missing cnEurOffsetLineless");
    expect(eurOffset.vatCzk).not.toBeNull();
    if (eurOffset.vatCzk === null) throw new Error("missing cnEurOffsetLineless vatCzk");
    expect(eurOffset.vatCzk.amount.pipe(BigDecimal.format)).toBe("0");
    expect(eurOffset.buckets).toHaveLength(2);
    const stdBucket = Arr.findFirst(eurOffset.buckets, (b) => b.treatment === "standard").pipe(
      Option.getOrUndefined,
    );
    const redBucket = Arr.findFirst(eurOffset.buckets, (b) => b.treatment === "reduced").pipe(
      Option.getOrUndefined,
    );
    if (
      stdBucket === undefined ||
      redBucket === undefined ||
      stdBucket.vatCzk === null ||
      redBucket.vatCzk === null
    ) {
      throw new Error("missing offsetting buckets");
    }
    expect(stdBucket.vatCzk.pipe(BigDecimal.format)).toBe("-0.01");
    expect(redBucket.vatCzk.pipe(BigDecimal.format)).toBe("0.01");
  });
});
