/**
 * Documents P3: corrections (D7), the Final Invoice (D8), Payment Tax Documents (P2) and the
 * stage-2 seams (`DocumentPayments`, `DocumentDeliveryReads`), on real layers.
 */
/**
 * Documents P3: corrections (D7), the Final Invoice (D8), Payment Tax Documents (P2) and the
 * stage-2 seams (`DocumentPayments`, `DocumentDeliveryReads`), on real layers.
 */

import { describe, expect, test } from "bun:test";
import type { Caller, DocumentView, TaxRegime } from "@kvitbit/domain/contract";
import {
  Conflict,
  CurrentCaller,
  type DocumentId,
  Documents,
  Forbidden,
  Invalid,
  IsoDate,
  LineId,
  NotFound,
  RequestKey,
} from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { VatMath } from "../../../src/engines/vat";
import {
  DocumentDeliveryReads,
  DocumentFixtures,
  DocumentPayments,
  type DocumentRecord,
  DocumentsRepo,
  fakePdfBytes,
  reportFigures,
} from "../../../src/modules/documents";
import { NumberingSeries } from "../../../src/modules/numbering";
import { ReportCompute } from "../../../src/modules/reports";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, WORKSPACE_B, WORKSPACE_A as WS } from "../../helpers";
import type { Services } from "./fixtures";
import {
  as,
  CZ_BUYER,
  concreteView,
  dec,
  EUR,
  encodedView,
  fixing,
  invoiceInput,
  issuer,
  present,
  scenario,
  str,
} from "./fixtures";

const TODAY = IsoDate.make("2026-11-23");

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const illegal = Conflict.make({ reason: "illegal_transition" });
const malformed = (path: ReadonlyArray<string | number>, reason: string) =>
  Invalid.make({ issues: [{ path, code: "request.malformed", params: { reason } }] });
const exceeds = (remaining: string) =>
  Invalid.make({
    issues: [
      {
        path: ["lines"],
        code: "credit_note.exceeds_original",
        params: { remaining, currency: "CZK" },
      },
    ],
  });

const run = <A, E>(
  body: Effect.Effect<A, E, Services>,
  options: {
    readonly caller?: Caller;
    readonly regimeA?: TaxRegime;
    readonly fixings?: ReadonlyArray<CnbFixing>;
  } = {},
) =>
  scenario(
    Effect.andThen(
      Effect.flatMap(CoreStore, (store) =>
        store.transaction(
          Effect.flatMap(NumberingSeries, (n) =>
            n.ensureDefaults(WS, ["invoice", "proforma", "credit_note", "payment_tax_document"]),
          ),
        ),
      ),
      body,
    ),
    {
      billingA: { seriesByKind: {} },
      ...options,
    },
  );

const issueInvoice = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  Effect.flatMap(Documents, (d) => d.issue({ input: invoiceInput(extra) }));
const issueProforma = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  issueInvoice({ kind: "proforma", ...extra });

const amounts = (view: DocumentView) => ({
  net: str(view.totals.net.amount),
  vat: str(view.totals.vat.amount),
  gross: str(view.totals.gross.amount),
});
const buckets = (view: Pick<DocumentView, "totals">) =>
  EffectArray.map(view.totals.buckets, (b) => [
    b.treatment,
    str(b.ratePercent),
    str(b.base),
    str(b.vat),
    str(b.gross),
    b.vatCzk === null ? null : str(b.vatCzk),
  ]);
const lines = (view: DocumentView) => concreteView(view).lines;
/** Lines without ids, JSON-encoded (decimal caches differ between equal values). */
const plainLines = async (view: DocumentView) =>
  EffectArray.map((await encodedView(view)).lines, ({ id: _id, ...line }) => line);
const lineOf = (view: DocumentView, i: number) => present(lines(view)[i]).id;

const taxableBuckets = (row: DocumentRecord, figures: ReturnType<typeof reportFigures>) =>
  ReportCompute.taxableBucketsCzk({
    ...row,
    ...figures,
    status: row.status === "cancelled" ? "cancelled" : "issued",
    finalInvoice: row.kind === "invoice",
    correctsKind: row.kind === "credit_note" ? "invoice" : null,
    contact: { id: row.contactId, name: row.contact.name },
    taxPoint: row.taxableSupplyOn,
    outstanding: dec("0"),
  });

/** Records a payment the way Payments will: lock, settle, PTD in one transaction. */
const pay = (id: DocumentId, amount: string, paidOn: IsoDate = TODAY) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const seam = yield* DocumentPayments;
    const caller = yield* CurrentCaller;
    return yield* store.transaction(
      Effect.gen(function* () {
        const targets = yield* seam.lock(WS, id);
        const on = targets.settleOn;
        const settled = yield* seam.settle(
          caller,
          WS,
          on.id,
          {
            amount: BigDecimal.sum(on.paid.amount, dec(amount)),
            payments: on.payments + 1,
          },
          { action: "payment.record" },
        );
        const ptd =
          on.kind === "proforma"
            ? yield* seam.issuePaymentTaxDocument(caller, WS, on.id, {
                amount: dec(amount),
                paidOn,
              })
            : null;
        return { targets, settled, ptd };
      }),
    );
  });

// Corrections -------------------------------------------------------------------------------

describe("correct (D7)", () => {
  test("full: the Credit Note negates the original exactly and settles it as credited", async () => {
    const [original, cn, replay, after, history] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const originalResult = yield* issueInvoice();
          const key = { requestKey: RequestKey.make("corr-1") };
          const creditNoteView = yield* d.correct(
            originalResult.id,
            { reason: " sleva ", lines: "full" },
            key,
          );
          const replayResult = yield* d.correct(
            originalResult.id,
            { reason: " sleva ", lines: "full" },
            key,
          );
          return [
            originalResult,
            creditNoteView,
            replayResult,
            yield* d.get(originalResult.id),
            yield* d.history(originalResult.id),
          ];
        }),
      ),
    );
    expect(cn.kind).toBe("credit_note");
    expect(cn.number).toBe("OD-2026-0001");
    expect(cn.totals).toEqual(VatMath.negate(original.totals));
    expect(EffectArray.map(lines(cn), (l) => str(l.quantity))).toEqual(["-2", "-1"]);
    expect(cn.related).toEqual([
      { relation: "corrects", id: original.id, kind: "invoice", number: "2026-0001" },
    ]);
    expect(await encodedView(replay)).toEqual(await encodedView(cn));
    expect(after.settlement).toBe("credited");
    expect(after.revision).toBe(original.revision + 1);
    expect(history.at(-1)).toMatchObject({ action: "document.correct", reason: "sleva" });
  });

  test("partial: picked quantities and prices, D7 cap per bucket, then the remainder", async () => {
    const [original, first, priced, over, rest, after, again] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const originalResult2 = yield* issueInvoice();
          const firstResult = yield* d.correct(originalResult2.id, {
            reason: "1 hodina méně",
            lines: [{ line: lineOf(originalResult2, 0), quantity: dec("1") }],
          });
          const pricedResult = yield* d.correct(originalResult2.id, {
            reason: "sleva na knihu",
            lines: [{ line: lineOf(originalResult2, 1), unitPrice: dec("100") }],
          });
          const overResult = yield* Effect.flip(
            d.correct(originalResult2.id, {
              reason: "znovu",
              lines: [{ line: lineOf(originalResult2, 0), quantity: dec("1.5") }],
            }),
          );
          const remainingCredit = yield* d.correct(originalResult2.id, {
            reason: "zbytek",
            lines: "full",
          });
          return [
            originalResult2,
            firstResult,
            pricedResult,
            overResult,
            remainingCredit,
            yield* d.get(originalResult2.id),
            yield* Effect.flip(d.correct(originalResult2.id, { reason: "x", lines: "full" })),
          ] as const;
        }),
      ),
    );
    expect(amounts(first)).toEqual({ net: "-1000", vat: "-210", gross: "-1210" });
    expect(
      EffectArray.map(lines(first), (l) => [str(l.quantity), str(l.unitPrice), str(l.ratePercent)]),
    ).toEqual([["-1", "1000", "21"]]);
    expect(amounts(priced)).toEqual({ net: "-100", vat: "-12", gross: "-112" });
    expect(over).toEqual(exceeds("1658"));
    expect(amounts(rest)).toEqual({ net: "-1400", vat: "-258", gross: "-1658" });
    expect(after.settlement).toBe("credited");
    expect(EffectArray.map(after.related, (r) => r.relation)).toEqual([
      "corrected_by",
      "corrected_by",
      "corrected_by",
    ]);
    expect(original.settlement).toBe("unpaid");
    expect(again).toEqual(illegal);
  });

  test("previewCorrection returns what correct issues, unnumbered, and stores nothing", async () => {
    const [preview, issued, countBefore, countAfter] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const repo = yield* DocumentsRepo;
          const original = yield* issueInvoice();
          const input = {
            reason: "reklamace",
            lines: [{ line: lineOf(original, 0), quantity: dec("0.5") }],
            correctedOn: IsoDate.make("2026-11-23"),
          };
          const before = (yield* repo.search(WS, {}, { limit: 50 })).rows.length;
          const previewResult = yield* d.previewCorrection(original.id, input);
          const after = (yield* repo.search(WS, {}, { limit: 50 })).rows.length;
          const issuedResult = yield* d.correct(original.id, input);
          return [previewResult, issuedResult, before, after] as const;
        }),
      ),
    );
    expect(countAfter).toBe(countBefore);
    expect(preview.number).toBeNull();
    expect(preview.totals).toEqual(issued.totals);
    expect(preview.dates).toEqual(issued.dates);
    expect(await plainLines(preview)).toEqual(await plainLines(issued));
    expect(preview.related).toEqual(issued.related);
  });

  test("input, kind and state checks", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const inv = yield* issueInvoice();
          const proforma = yield* issueProforma();
          const draft = yield* d.createDraft(invoiceInput());
          const lockedDoc = yield* d.lock((yield* issueInvoice()).id);
          const cn = yield* d.correct(inv.id, {
            reason: "x",
            lines: [{ line: lineOf(inv, 1), quantity: dec("1") }],
          });
          const pick = (line: LineId, extra = {}) => ({
            reason: "x",
            lines: [{ line, ...extra }],
          });
          return [
            yield* Effect.flip(d.correct(inv.id, { reason: "  ", lines: "full" })),
            yield* Effect.flip(
              d.correct(inv.id, {
                reason: "x",
                lines: "full",
                correctedOn: IsoDate.make("2026-11-24"),
              }),
            ),
            yield* Effect.flip(
              d.correct(inv.id, {
                reason: "x",
                lines: "full",
                correctedOn: IsoDate.make("2026-11-22"),
              }),
            ),
            yield* Effect.flip(
              d.correct(inv.id, pick(LineId.make("nope", { disableChecks: true }))),
            ),
            yield* Effect.flip(
              d.correct(inv.id, {
                reason: "x",
                lines: [{ line: lineOf(inv, 0) }, { line: lineOf(inv, 0) }],
              }),
            ),
            yield* Effect.flip(d.correct(inv.id, pick(lineOf(inv, 0), { quantity: dec("0") }))),
            yield* Effect.flip(d.correct(inv.id, pick(lineOf(inv, 0), { unitPrice: dec("-1") }))),
            yield* Effect.flip(d.correct(inv.id, { reason: "x", lines: [] })),
            yield* Effect.flip(d.correct(proforma.id, { reason: "x", lines: "full" })),
            yield* Effect.flip(d.correct(draft.id, { reason: "x", lines: "full" })),
            yield* Effect.flip(d.correct(lockedDoc.id, { reason: "x", lines: "full" })),
            yield* Effect.flip(d.correct(cn.id, { reason: "x", lines: "full" })),
            yield* Effect.flip(d.previewCorrection(proforma.id, { reason: "x", lines: "full" })),
          ];
        }),
      ),
    );
    expect(results).toEqual([
      malformed(["reason"], "required"),
      malformed(["correctedOn"], "out_of_range"),
      malformed(["correctedOn"], "out_of_range"),
      malformed(["lines", 0, "line"], "unknown_line"),
      malformed(["lines", 1, "line"], "duplicate_line"),
      malformed(["lines", 0, "quantity"], "out_of_range"),
      malformed(["lines", 0, "unitPrice"], "out_of_range"),
      malformed(["lines"], "required"),
      illegal,
      illegal,
      Conflict.make({ reason: "document_locked" }),
      illegal,
      illegal,
    ]);
  });

  test("a partial credit lowers what is owed: paying the rest settles the invoice", async () => {
    const [paid, overpaid] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const a = yield* issueInvoice();
          yield* d.correct(a.id, {
            reason: "sleva",
            lines: [{ line: lineOf(a, 0), quantity: dec("1") }],
          });
          const paidResult = yield* pay(a.id, "1770");
          const b = yield* issueInvoice();
          yield* pay(b.id, "2980");
          yield* d.correct(b.id, {
            reason: "vratka",
            lines: [{ line: lineOf(b, 1), quantity: dec("1") }],
          });
          return [paidResult.settled.settlement, (yield* d.get(b.id)).settlement] as const;
        }),
      ),
    );
    expect(paid).toBe("paid");
    expect(overpaid).toBe("overpaid");
  });
});

// Payment Tax Documents and the payments seam -----------------------------------------------

describe("payments seam", () => {
  test("a vat_payer Proforma advance issues a PTD split by gross share (sum = paid)", async () => {
    const [result, proforma, ptdHistory, pHistory] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma();
          const operationResult = yield* pay(p.id, "1000", IsoDate.make("2026-11-20"));
          const ptdId = present(operationResult.ptd).id;
          return [
            operationResult,
            yield* d.get(p.id),
            yield* d.history(ptdId),
            yield* d.history(p.id),
          ];
        }),
      ),
    );
    const ptd = present(result.ptd);
    expect(ptd.kind).toBe("payment_tax_document");
    expect(ptd.number).toBe("DD-2026-0001");
    expect(ptd.taxDocument).toBe(true);
    expect(ptd.settlement).toBe("paid");
    expect(ptd.dates).toEqual({
      issuedOn: TODAY,
      taxableSupplyOn: IsoDate.make("2026-11-20"),
      dueOn: TODAY,
    });
    expect(buckets(ptd)).toEqual([
      ["standard", "21", "671.14", "140.94", "812.08", null],
      ["reduced", "12", "167.79", "20.13", "187.92", null],
    ]);
    ptd.totals.gross.amount.pipe(str, expect).toBe("1000");
    expect(ptd.related).toEqual([
      { relation: "advance_of", id: proforma.id, kind: "proforma", number: "ZF-2026-0001" },
    ]);
    expect(result.settled.settlement).toBe("partially_paid");
    expect(proforma.settlement).toBe("partially_paid");
    expect(EffectArray.map(proforma.related, (r) => [r.relation, r.id])).toEqual([
      ["tax_document_for", ptd.id],
    ]);
    // Issued from input at revision 2; settle and the PTD link each bump it.
    expect(proforma.revision).toBe(4);
    expect(EffectArray.map(ptdHistory, (e) => e.action)).toEqual(["document.issue"]);
    expect(EffectArray.map(pHistory, (e) => e.action)).toEqual([
      "document.issue",
      "payment.record",
      "document.taxDocument",
    ]);
    expect(pHistory[1]?.changes).toEqual([
      { path: "paidAmount", before: "0", after: "1000" },
      { path: "payments", before: 0, after: 1 },
      { path: "settlement", before: "unpaid", after: "partially_paid" },
    ]);
  });

  test("a EUR advance uses the CNB fixing for the receipt date (carried back), CZK VAT per bucket", async () => {
    const ptd = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* issueProforma({
            currency: EUR,
            lines: [{ description: "Služba", unitPrice: dec("1000") }],
          });
          return present((yield* pay(p.id, "605", IsoDate.make("2026-11-21"))).ptd);
        }),
        { fixings: [fixing("2026-11-23", "25.000"), fixing("2026-11-20", "24.500")] },
      ),
    );
    expect(ptd.fx).toMatchObject({ fixingDate: "2026-11-20", source: "cnb" });
    expect(buckets(ptd)).toEqual([["standard", "21", "500", "105", "605", "2572.5"]]);
  });

  test("no PTD outside vat_payer; settle covers paid, overpaid and revert", async () => {
    const [ptd, steps, history] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const caller = yield* CurrentCaller;
          const p = yield* issueProforma({
            lines: [{ description: "Práce", unitPrice: dec("1000") }],
          });
          const first = yield* pay(p.id, "400");
          const set = (
            amount: string,
            payments: number,
            action: "payment.record" | "payment.remove",
          ) =>
            store.transaction(
              Effect.andThen(seam.lock(WS, p.id), () =>
                seam.settle(
                  caller,
                  WS,
                  p.id,
                  { amount: dec(amount), payments },
                  { action, reason: "test" },
                ),
              ),
            );
          const stepsResult = [
            first.settled.settlement,
            (yield* set("1000", 2, "payment.record")).settlement,
            (yield* set("1500", 3, "payment.record")).settlement,
            (yield* set("1000", 2, "payment.remove")).settlement,
            (yield* set("0", 0, "payment.remove")).settlement,
          ];
          return [first.ptd, stepsResult, yield* d.history(p.id)] as const;
        }),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(ptd).toBeNull();
    expect(steps).toEqual(["partially_paid", "paid", "overpaid", "paid", "unpaid"]);
    expect(history.at(-1)).toMatchObject({ action: "payment.remove", reason: "test" });
  });

  test("settle refuses more payments where none can be recorded, and bad counts", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const caller = yield* CurrentCaller;
          const draft = yield* d.createDraft(invoiceInput());
          const inv = yield* issueInvoice();
          const cn = yield* d.correct(inv.id, { reason: "x", lines: "full" });
          const proforma = yield* issueProforma();
          const cancelled = (yield* d.cancel(proforma.id, { reason: "x" })).document;
          const settle = (id: DocumentId, amount: string, payments: number) =>
            Effect.flip(
              store.transaction(
                seam.settle(
                  caller,
                  WS,
                  id,
                  { amount: dec(amount), payments },
                  { action: "payment.record" },
                ),
              ),
            );
          return [
            yield* settle(draft.id, "1", 1),
            yield* settle(cn.id, "1", 1),
            yield* settle(cancelled.id, "1", 1),
            yield* settle(inv.id, "1", -1),
            yield* settle(inv.id, "1", 0),
            yield* Effect.flip(store.transaction(seam.lock(WORKSPACE_B, inv.id))),
          ];
        }),
      ),
    );
    expect(results).toEqual([
      illegal,
      illegal,
      illegal,
      malformed(["payments"], "out_of_range"),
      malformed(["amount"], "out_of_range"),
      NotFound.make({
        entity: "Document",
        id: Schema.is(NotFound)(results[5]) ? results[5].id : "",
      }),
    ]);
  });

  test("lock takes the Proforma first and settles on its Final Invoice once it has one", async () => {
    const [locks, viaProforma, viaInvoice] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          const fi = yield* d.issueFinalInvoice(p.id);
          const locksResult: Array<DocumentId> = [];
          const spy = DocumentsRepo.of({
            ...repo,
            lock: (ws, id) =>
              Effect.andThen(
                Effect.sync(() => locksResult.push(id)),
                repo.lock(ws, id),
              ),
          });
          const lockAs = (id: DocumentId) =>
            Effect.provideService(store.transaction(seam.lock(WS, id)), DocumentsRepo, spy);
          const fromInvoice = yield* lockAs(fi.id);
          const first = [...locksResult];
          locksResult.length = 0;
          const fromProforma = yield* lockAs(p.id);
          return [
            { invoice: first, proforma: [...locksResult], p: p.id, fi: fi.id },
            fromProforma,
            fromInvoice,
          ];
        }),
      ),
    );
    expect(locks.invoice).toEqual([locks.p, locks.fi]);
    expect(locks.proforma).toEqual([locks.p, locks.fi]);
    expect(viaProforma.settleOn.id).toBe(locks.fi);
    expect(viaProforma.proforma?.id).toBe(locks.p);
    expect(viaInvoice.requested.id).toBe(locks.fi);
    expect(viaInvoice.settleOn.id).toBe(locks.fi);
    expect(viaInvoice.requested.proforma).toBe(locks.p);
    expect(viaProforma.requested.finalInvoice).toBe(locks.fi);
  });

  test("removalBlocked: the Final Invoice must be reversed first, then the PTD credited", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const blocked = (target: DocumentId, ptd: DocumentId | null) =>
            store.transaction(seam.removalBlocked(WS, target, ptd));
          const a = yield* issueProforma();
          const ptdA = present((yield* pay(a.id, "500")).ptd);
          const before = yield* blocked(a.id, ptdA.id);
          yield* d.correct(ptdA.id, { reason: "chybná záloha", lines: "full" });
          const credited = yield* blocked(a.id, ptdA.id);
          const b = yield* issueProforma();
          const ptdB = present((yield* pay(b.id, "500")).ptd);
          const fi = yield* d.issueFinalInvoice(b.id);
          const deducted = yield* blocked(b.id, ptdB.id);
          yield* d.correct(fi.id, { reason: "x", lines: "full" });
          const reversed = yield* blocked(b.id, ptdB.id);
          yield* d.correct(ptdB.id, { reason: "x", lines: "full" });
          // A payment booked on the Final Invoice itself never waits for it.
          const onInvoice = yield* blocked(fi.id, null);
          return [before, credited, deducted, reversed, yield* blocked(b.id, ptdB.id), onInvoice];
        }),
      ),
    );
    expect(results).toEqual([
      "tax_document_open",
      null,
      "final_invoice_deducts",
      "tax_document_open",
      null,
      null,
    ]);
  });

  test("refundDue and overdue: a Proforma with a Final Invoice is chased through the Invoice", async () => {
    const [targets, proforma] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma({ due: { on: TODAY } });
          yield* pay(p.id, "3000");
          const fi = yield* d.issueFinalInvoice(p.id);
          return [yield* store.transaction(seam.lock(WS, fi.id)), yield* d.get(p.id)] as const;
        }),
      ),
    );
    targets.settleOn.owed.amount.pipe(str, expect).toBe("-20");
    targets.settleOn.refundDue.amount.pipe(str, expect).toBe("20");
    expect(targets.settleOn.settlement).toBe("overpaid");
    expect(proforma.overdue).toBe(false);
  });
});

// Final Invoice -----------------------------------------------------------------------------

describe("issueFinalInvoice (D8)", () => {
  test("deducts each PTD bucket as stored; links; once per Proforma; preview matches", async () => {
    const [ptd, preview, fi, replay, proforma, dup, history] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma();
          const { ptd: taxDocument } = yield* pay(p.id, "1000");
          const previewResult = yield* d.previewFinalInvoice(p.id);
          const key = { requestKey: RequestKey.make("fi-1") };
          const finalInvoiceResult = yield* d.issueFinalInvoice(p.id, undefined, key);
          const replayResult = yield* d.issueFinalInvoice(p.id, undefined, key);
          return [
            present(taxDocument),
            previewResult,
            finalInvoiceResult,
            replayResult,
            yield* d.get(p.id),
            yield* Effect.flip(d.issueFinalInvoice(p.id)),
            yield* d.history(p.id),
          ] as const;
        }),
      ),
    );
    expect(fi.kind).toBe("invoice");
    expect(fi.number).toBe("2026-0001");
    expect(
      EffectArray.map(lines(fi), (l) => [str(l.quantity), str(l.unitPrice), l.deducts]),
    ).toEqual([
      ["2", "1000", null],
      ["1", "500", null],
      ["-1", "671.14", ptd.id],
      ["-1", "167.79", ptd.id],
    ]);
    expect(buckets(fi)).toEqual([
      ["standard", "21", "1328.86", "279.06", "1607.92", null],
      ["reduced", "12", "332.21", "39.87", "372.08", null],
    ]);
    expect(amounts(fi)).toEqual({ net: "1661.07", vat: "318.93", gross: "1980" });
    expect(fi.settlement).toBe("unpaid");
    expect(EffectArray.map(fi.related, (r) => [r.relation, r.id])).toEqual([
      ["advance_of", proforma.id],
      ["deducts", ptd.id],
    ]);
    expect(EffectArray.map(proforma.related, (r) => r.relation)).toEqual([
      "tax_document_for",
      "final_invoice_for",
    ]);
    expect(await encodedView(replay)).toEqual(await encodedView(fi));
    expect(dup).toEqual(Conflict.make({ reason: "duplicate" }));
    expect(preview.number).toBeNull();
    expect(preview.totals).toEqual(fi.totals);
    expect(await plainLines(preview)).toEqual(await plainLines(fi));
    expect(history.at(-1)).toMatchObject({ action: "document.finalInvoice" });
    // Reports: the full supply plus the deducted advance (#384).
    const figures = reportFigures(
      {
        lines: EffectArray.map(lines(fi), (line, i) => ({
          ...line,
          itemPrice: null,
          vat: null,
          itemVat: null,
          deductedVat: i < 2 ? null : dec(i === 2 ? "-140.94" : "-20.13"),
          deductedVatCzk: null,
        })),
        totals: fi.totals,
        currency: fi.totals.gross.currency,
        pricesIncludeVat: false,
        fx: null,
      },
      () => true,
    );
    figures.totals.gross.amount.pipe(str, expect).toBe("2980");
    expect(figures.advanceDeductions).toEqual(ptd.totals.buckets);
  });

  test("a patch changes terms and lines but keeps the deductions; currency changes are refused", async () => {
    const [fi, currency] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          const currencyResult = yield* Effect.flip(
            d.previewFinalInvoice(p.id, { patch: { currency: EUR } }),
          );
          const finalInvoice2 = yield* d.issueFinalInvoice(p.id, {
            patch: {
              lines: [{ description: "Dodávka", quantity: dec("3"), unitPrice: dec("1000") }],
              taxableSupplyOn: IsoDate.make("2026-11-22"),
            },
          });
          return [finalInvoice2, currencyResult] as const;
        }),
        { fixings: [fixing("2026-11-23", "25.000")] },
      ),
    );
    expect(fi.dates.taxableSupplyOn).toBe(IsoDate.make("2026-11-22"));
    expect(EffectArray.map(lines(fi), (l) => l.deducts === null)).toEqual([true, false, false]);
    expect(buckets(fi)).toEqual([
      ["standard", "21", "2328.86", "489.06", "2817.92", null],
      ["reduced", "12", "-167.79", "-20.13", "-187.92", null],
    ]);
    expect(currency).toEqual(
      Invalid.make({
        issues: [
          {
            path: ["currency"],
            code: "request.malformed",
            params: { reason: "currency_mismatch", currency: "CZK" },
          },
          {
            path: ["currency"],
            code: "request.malformed",
            params: { reason: "currency_mismatch", currency: "CZK" },
          },
        ],
      }),
    );
  });

  test("outside vat_payer: one outside_scope line for the amount paid; covered in full = paid", async () => {
    const [fi, full] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma({
            lines: [{ description: "Práce", unitPrice: dec("1000") }],
          });
          yield* pay(p.id, "300");
          const finalInvoice3 = yield* d.issueFinalInvoice(p.id);
          const q = yield* issueProforma({
            lines: [{ description: "Práce", unitPrice: dec("1000") }],
          });
          yield* pay(q.id, "1000");
          return [finalInvoice3, yield* d.issueFinalInvoice(q.id)] as const;
        }),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(
      EffectArray.map(lines(fi), (l) => [
        l.treatment,
        str(l.quantity),
        str(l.unitPrice),
        l.deducts,
      ]),
    ).toEqual([
      ["outside_scope", "1", "1000", null],
      ["outside_scope", "-1", "300", fi.related[0]?.id ?? null],
    ]);
    expect(amounts(fi)).toEqual({ net: "700", vat: "0", gross: "700" });
    expect(EffectArray.map(fi.related, (r) => r.relation)).toEqual(["advance_of"]);
    full.totals.gross.amount.pipe(str, expect).toBe("0");
    expect(full.settlement).toBe("paid");
    expect(full.overdue).toBe(false);
  });

  test("a full Credit Note of a Final Invoice reverses its deductions too", async () => {
    const [fi, cn] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          const finalInvoice7 = yield* d.issueFinalInvoice(p.id);
          return [
            finalInvoice7,
            yield* d.correct(finalInvoice7.id, { reason: "storno", lines: "full" }),
          ] as const;
        }),
      ),
    );
    expect(cn.totals).toEqual(VatMath.negate(fi.totals));
    expect(EffectArray.map(lines(cn), (l) => l.deducts)).toEqual(
      EffectArray.map(lines(fi), (l) => l.deducts),
    );
    const partial = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const p = yield* issueProforma();
        yield* pay(p.id, "1000");
        const invoice = yield* d.issueFinalInvoice(p.id);
        return yield* Effect.flip(
          d.correct(invoice.id, { reason: "x", lines: [{ line: lineOf(invoice, 2) }] }),
        );
      }),
    );
    partial.pipe(ok, expect).toEqual(malformed(["lines", 0, "line"], "deduction_line"));
  });

  test("EUR advances at other fixings: the Final Invoice declares its net VAT at its own fixing, as the VAT report does (§37a)", async () => {
    // The advance-chain property test's seed-58256 counterexample (formal finding F1).
    const [ptds, fi, cn, reported, full, unknown] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma({
            currency: EUR,
            lines: [{ description: "Služba", unitPrice: dec("24082.29") }],
          });
          const taxDocuments: Array<DocumentView> = [];
          for (const [amount, on] of [
            ["1182.63", "2026-11-18"],
            ["5670.29", "2026-11-21"],
            ["8832.48", "2026-11-23"],
          ] as const) {
            taxDocuments.push(present((yield* pay(p.id, amount, IsoDate.make(on))).ptd));
          }
          const finalInvoice4 = yield* d.issueFinalInvoice(p.id);
          const record = yield* Effect.flatMap(CoreStore, (store) =>
            store.transaction(
              Effect.flatMap(DocumentsRepo, (repo) => repo.get(WS, finalInvoice4.id)),
            ),
          );
          const declare = (r: typeof record) => {
            const f = reportFigures(r, () => true);
            return {
              full: f.totals,
              vat: taxableBuckets(r, f),
            };
          };
          const { full: fullResult, vat: reportedResult } = declare(record);
          // A stored net bucket without CZK VAT: the report converts the net VAT, never reads 0.
          const missingDocument = declare({
            ...record,
            totals: {
              ...record.totals,
              buckets: EffectArray.map(record.totals.buckets, (b) => ({ ...b, vatCzk: null })),
            },
          });
          const creditNoteView = yield* d.correct(finalInvoice4.id, {
            reason: "storno",
            lines: "full",
          });
          return [
            taxDocuments,
            finalInvoice4,
            creditNoteView,
            reportedResult,
            fullResult,
            missingDocument,
          ] as const;
        }),
        {
          fixings: [
            fixing("2026-11-18", "24.974"),
            fixing("2026-11-21", "24.485"),
            fixing("2026-11-23", "24.459"),
          ],
        },
      ),
    );
    expect(EffectArray.map(ptds, (t) => buckets(t)[0]?.slice(3))).toEqual([
      ["205.25", "1182.63", "5125.91"],
      ["984.1", "5670.29", "24095.69"],
      ["1532.91", "8832.48", "37493.45"],
    ]);
    // round2(2335.02 x 24.459), not round2(5057.28 x 24.459) - PTDs' CZK VAT = 56980.96.
    expect(buckets(fi)).toEqual([
      ["standard", "21", "11119.15", "2335.02", "13454.17", "57112.25"],
    ]);
    (fi.totals.vatCzk?.amount ?? dec("0")).pipe(str, expect).toBe("57112.25");
    expect(EffectArray.map(reported, (b) => str(b.vat))).toEqual(["57112.25"]);
    // Revenue's full supply: 5057.28 EUR at the Final Invoice's fixing, not the advances' fixings.
    expect(
      EffectArray.map(full.buckets, (b) => (b.vatCzk === null ? null : str(b.vatCzk))),
    ).toEqual(["123696.01"]);
    expect(EffectArray.map(unknown.vat, (b) => str(b.vat))).toEqual(["57112.25"]);
    expect(EffectArray.map(unknown.full.buckets, (b) => b.vatCzk)).toEqual([null]);
    expect(cn.totals).toEqual(VatMath.negate(fi.totals));
  });

  test("a supply line of a prepaid EUR Final Invoice is credited at the Final Invoice's fixing, whatever the advance's", async () => {
    const credit = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma({
            currency: EUR,
            lines: [{ description: "Služba", unitPrice: dec("100") }],
          });
          yield* pay(p.id, "60.50", IsoDate.make("2026-11-20"));
          const fi = yield* d.issueFinalInvoice(p.id);
          return yield* d.correct(fi.id, { reason: "sleva", lines: [{ line: lineOf(fi, 0) }] });
        }),
        { fixings: [fixing("2026-11-20", "24.000"), fixing("2026-11-23", "25.000")] },
      ),
    );
    // 21 EUR VAT at 25: 525 CZK, within the Final Invoice's open supply (10.50 net + 10.50 deducted).
    expect(buckets(credit)).toEqual([["standard", "21", "-100", "-21", "-121", "-525"]]);
  });

  test("after the supply is credited, the remainder of a prepaid EUR Final Invoice reverses only its deductions", async () => {
    const [fi, partial, rest, revenue] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma({
            currency: EUR,
            lines: [{ description: "Služba", unitPrice: dec("100") }],
          });
          yield* pay(p.id, "60.50", IsoDate.make("2026-11-20"));
          // Revenue's full-supply CZK VAT per document (ReportsSource mapping).
          const fullCzk = (id: DocumentId) =>
            Effect.map(
              Effect.flatMap(CoreStore, (store) =>
                store.transaction(Effect.flatMap(DocumentsRepo, (repo) => repo.get(WS, id))),
              ),
              (record) => str(reportFigures(record, () => true).totals.vatCzk?.amount ?? dec("0")),
            );
          const finalInvoice5 = yield* d.issueFinalInvoice(p.id);
          const partialResult = yield* d.correct(finalInvoice5.id, {
            reason: "sleva",
            lines: [{ line: lineOf(finalInvoice5, 0) }],
          });
          const remainingCredit = yield* d.correct(finalInvoice5.id, {
            reason: "storno",
            lines: "full",
          });
          const revenueResult = [
            yield* fullCzk(finalInvoice5.id),
            yield* fullCzk(partialResult.id),
            yield* fullCzk(remainingCredit.id),
          ];
          return [finalInvoice5, partialResult, remainingCredit, revenueResult] as const;
        }),
        { fixings: [fixing("2026-11-20", "24.000"), fixing("2026-11-23", "25.000")] },
      ),
    );
    // No zero-value supply line for the CZK residual; the deduction is reversed as a line.
    expect(
      EffectArray.map(lines(rest), (l) => [str(l.quantity), str(l.unitPrice), l.deducts]),
    ).toEqual([["1", "50", lines(fi)[1]?.deducts ?? null]]);
    // CZK VAT closes exactly: 262.5 (FI) - 525 (partial) + 262.5 (remainder) = 0.
    expect(buckets(rest)).toEqual([["standard", "21", "50", "10.5", "60.5", "262.5"]]);
    expect(buckets(partial)[0]?.[5]).toBe("-525");
    // Revenue closes too: the full supply 525, its credit -525, the deduction reversal 0.
    expect(revenue).toEqual(["525", "-525", "0"]);
  });

  test("a closing Credit Note's CZK residual is declared as stored; VAT report and revenue close (FI at 24.450)", async () => {
    const [stored, declared, revenue] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma({
            currency: EUR,
            lines: [{ description: "Služba", unitPrice: dec("100") }],
          });
          yield* pay(p.id, "60.50", IsoDate.make("2026-11-20"));
          const fi = yield* d.issueFinalInvoice(p.id);
          const partial = yield* d.correct(fi.id, {
            reason: "sleva",
            lines: [{ line: lineOf(fi, 0) }],
          });
          const rest = yield* d.correct(fi.id, { reason: "storno", lines: "full" });
          const figures = (id: DocumentId) =>
            Effect.map(
              Effect.flatMap(CoreStore, (store) =>
                store.transaction(Effect.flatMap(DocumentsRepo, (repo) => repo.get(WS, id))),
              ),
              (record) => {
                const f = reportFigures(record, () => true);
                const vat = taxableBuckets(record, f);
                return {
                  declared: str(
                    EffectArray.reduce(vat, dec("0"), (a, b) => BigDecimal.sum(a, b.vat)),
                  ),
                  revenue: str(f.totals.vatCzk?.amount ?? dec("0")),
                };
              },
            );
          const all = [yield* figures(fi.id), yield* figures(partial.id), yield* figures(rest.id)];
          return [
            EffectArray.map([fi, partial, rest], (v) => str(v.totals.vatCzk?.amount ?? dec("0"))),
            EffectArray.map(all, (f) => f.declared),
            EffectArray.map(all, (f) => f.revenue),
          ] as const;
        }),
        { fixings: [fixing("2026-11-20", "24.000"), fixing("2026-11-23", "24.450")] },
      ),
    );
    // FI round2(10.50 x 24.45) = 256.73; supply credit round2(-21 x 24.45) = -513.45; the
    // closing note clears the rest exactly: 256.72, not round2(10.50 x 24.45).
    expect(stored).toEqual(["256.73", "-513.45", "256.72"]);
    expect(declared).toEqual(stored);
    // Revenue: full supply 256.73 + 256.73, its credit, the closing residual -0.01: sums to 0.
    expect(revenue).toEqual(["513.46", "-513.45", "-0.01"]);
  });

  test("line credits of a prepaid EUR Final Invoice stay within the supply's CZK VAT (D7), as for any invoice", async () => {
    const [first, second, rest, fi] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma({
            currency: EUR,
            lines: [{ description: "Služba", quantity: dec("2"), unitPrice: dec("50") }],
          });
          yield* pay(p.id, "24.20", IsoDate.make("2026-11-20"));
          const finalInvoice6 = yield* d.issueFinalInvoice(p.id);
          const unit = { line: lineOf(finalInvoice6, 0), quantity: dec("1") };
          const firstResult = yield* d.correct(finalInvoice6.id, {
            reason: "sleva",
            lines: [unit],
          });
          const secondResult = yield* Effect.flip(
            d.correct(finalInvoice6.id, { reason: "sleva", lines: [unit] }),
          );
          const remainingCreditResult = yield* d.correct(finalInvoice6.id, {
            reason: "storno",
            lines: "full",
          });
          return [firstResult, secondResult, remainingCreditResult, finalInvoice6] as const;
        }),
        { fixings: [fixing("2026-11-20", "24.000"), fixing("2026-11-23", "24.450")] },
      ),
    );
    // Supply VAT 21 EUR = 513.45 CZK at 24.45; one unit credits round2(-10.50 x 24.45) = -256.73,
    // so a second unit (another -256.73) would credit 513.46: refused, the remainder closes it.
    expect(buckets(first)[0]?.[5]).toBe("-256.73");
    expect(second).toBeInstanceOf(Invalid);
    Schema.asserts(Invalid, second);
    expect(second.issues[0]?.code).toBe("credit_note.exceeds_original");
    const czk = (v: DocumentView) => BigDecimal.normalize(v.totals.vatCzk?.amount ?? dec("0"));
    czk(fi)
      .pipe(BigDecimal.sum(czk(first)), BigDecimal.sum(czk(rest)), str, expect)
      .toBe("0");
  });

  test("checks: unpaid Proforma, not a Proforma, draft, cancelled", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const unpaid = yield* issueProforma();
          const inv = yield* issueInvoice();
          const draft = yield* d.createDraft(invoiceInput({ kind: "proforma" }));
          const cancelled = yield* issueProforma();
          yield* d.cancel(cancelled.id, { reason: "x" });
          return [
            yield* Effect.flip(d.issueFinalInvoice(unpaid.id)),
            yield* Effect.flip(d.previewFinalInvoice(unpaid.id)),
            yield* Effect.flip(d.issueFinalInvoice(inv.id)),
            yield* Effect.flip(d.issueFinalInvoice(draft.id)),
            yield* Effect.flip(d.issueFinalInvoice(cancelled.id)),
          ];
        }),
      ),
    );
    const unpaid = Invalid.make({
      issues: [{ path: ["proforma"], code: "final_invoice.proforma_unpaid" }],
    });
    expect(results).toEqual([unpaid, unpaid, illegal, illegal, illegal]);
  });
});

describe("council follow-ups", () => {
  test("cash the PTDs do not cover is deducted as one outside_scope line without VAT", async () => {
    const fi = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const caller = yield* CurrentCaller;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          // A payment recorded without a PTD (user-flows 3.8: unticked).
          yield* store.transaction(
            Effect.andThen(seam.lock(WS, p.id), () =>
              seam.settle(
                caller,
                WS,
                p.id,
                { amount: dec("1400"), payments: 2 },
                { action: "payment.record" },
              ),
            ),
          );
          return yield* d.issueFinalInvoice(p.id);
        }),
      ),
    );
    expect(
      EffectArray.map(lines(fi), (l) => [l.treatment, str(l.unitPrice), l.deducts !== null]),
    ).toEqual([
      ["standard", "1000", false],
      ["reduced", "500", false],
      ["standard", "671.14", true],
      ["reduced", "167.79", true],
      ["outside_scope", "400", true],
    ]);
    expect(amounts(fi)).toEqual({ net: "1261.07", vat: "318.93", gross: "1580" });
  });

  test("a discount (negative) line is credited with a positive line; zero effects are refused", async () => {
    const [cn, zero] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const inv = yield* issueInvoice({
            lines: [
              { description: "Práce", quantity: dec("2"), unitPrice: dec("1000") },
              { description: "Sleva", quantity: dec("-1"), unitPrice: dec("200") },
            ],
          });
          const creditNoteView = yield* Effect.flip(
            d.correct(inv.id, { reason: "sleva neplatí", lines: [{ line: lineOf(inv, 1) }] }),
          );
          // With a work line the net effect is a credit: the discount line runs positive.
          const both = yield* d.correct(inv.id, {
            reason: "storno části",
            lines: [{ line: lineOf(inv, 0), quantity: dec("1") }, { line: lineOf(inv, 1) }],
          });
          expect(EffectArray.map(lines(both), (l) => [str(l.quantity), str(l.unitPrice)])).toEqual([
            ["-1", "1000"],
            ["1", "200"],
          ]);
          expect(amounts(both)).toEqual({ net: "-800", vat: "-168", gross: "-968" });
          const zeroResult = yield* Effect.flip(
            d.correct(inv.id, {
              reason: "x",
              lines: [{ line: lineOf(inv, 0), unitPrice: dec("0") }],
            }),
          );
          return [creditNoteView, zeroResult] as const;
        }),
      ),
    );
    // Crediting only the discount raises what the buyer owes: the signed cap refuses it (D7).
    expect(cn).toEqual(exceeds("2178"));
    expect(zero).toEqual(malformed(["lines", 0, "unitPrice"], "out_of_range"));
  });

  test("after a partial credit, the full remainder of a Final Invoice reverses its deductions as lines", async () => {
    const [fi, partial, rest] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          const finalInvoice = yield* d.issueFinalInvoice(p.id);
          const partialResult = yield* d.correct(finalInvoice.id, {
            reason: "méně hodin",
            lines: [{ line: lineOf(finalInvoice, 0), quantity: dec("1") }],
          });
          const remainingCredit = yield* d.correct(finalInvoice.id, {
            reason: "zbytek",
            lines: "full",
          });
          return [yield* d.get(finalInvoice.id), partialResult, remainingCredit] as const;
        }),
      ),
    );
    expect(fi.settlement).toBe("credited");
    expect(
      EffectArray.map(lines(rest), (l) => [str(l.quantity), str(l.unitPrice), l.deducts !== null]),
    ).toEqual([
      ["-1", "1000", false],
      ["-1", "500", false],
      ["1", "671.14", true],
      ["1", "167.79", true],
    ]);
    const sum = (k: "net" | "vat" | "gross") =>
      str(
        EffectArray.reduce([fi, partial, rest], BigDecimal.fromBigInt(0n), (acc, v) =>
          BigDecimal.sum(acc, v.totals[k].amount),
        ),
      );
    expect([sum("net"), sum("vat"), sum("gross")]).toEqual(["0", "0", "0"]);
    const deductions = reportFigures(
      {
        lines: EffectArray.map(lines(rest), (line) => ({
          ...line,
          itemPrice: null,
          vat: null,
          itemVat: null,
          deductedVat:
            line.deducts === null
              ? null
              : dec(str(line.unitPrice) === "671.14" ? "140.94" : "20.13"),
          deductedVatCzk: null,
        })),
        totals: rest.totals,
        currency: rest.totals.gross.currency,
        pricesIncludeVat: false,
        fx: null,
      },
      () => true,
    ).advanceDeductions;
    expect(EffectArray.map(deductions, (b) => str(b.gross))).toEqual(["-812.08", "-187.92"]);
  });
});

describe("diff council follow-ups", () => {
  test("a prepaid Final Invoice can be credited partially and is credited only once its deductions are reversed", async () => {
    const [partial, afterPartial, afterFull, removal] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma();
          const { ptd } = yield* pay(p.id, "2980");
          const fi = yield* d.issueFinalInvoice(p.id);
          const partialResult = yield* d.correct(fi.id, {
            reason: "méně práce",
            lines: [{ line: lineOf(fi, 0), quantity: dec("1") }],
          });
          const afterPartialResult = yield* d.get(fi.id);
          yield* d.correct(fi.id, { reason: "storno", lines: "full" });
          return [
            partialResult,
            afterPartialResult,
            yield* d.get(fi.id),
            yield* store.transaction(seam.removalBlocked(WS, p.id, present(ptd).id)),
          ] as const;
        }),
      ),
    );
    expect(amounts(partial)).toEqual({ net: "-1000", vat: "-210", gross: "-1210" });
    expect(afterPartial.settlement).toBe("overpaid");
    expect(afterFull.settlement).toBe("credited");
    expect(removal).toBe("tax_document_open");
  });

  test("a PTD a live Final Invoice deducts cannot be corrected or cancelled; no PTD after the Final Invoice", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const caller = yield* CurrentCaller;
          const p = yield* issueProforma();
          const ptd = present((yield* pay(p.id, "1000")).ptd);
          yield* d.issueFinalInvoice(p.id);
          return [
            yield* Effect.flip(d.correct(ptd.id, { reason: "x", lines: "full" })),
            yield* Effect.flip(d.previewCorrection(ptd.id, { reason: "x", lines: "full" })),
            yield* Effect.flip(d.cancel(ptd.id, { reason: "x" })),
            yield* Effect.flip(
              store.transaction(
                seam.issuePaymentTaxDocument(caller, WS, p.id, { amount: dec("1"), paidOn: TODAY }),
              ),
            ),
          ];
        }),
      ),
    );
    expect(results).toEqual([illegal, illegal, illegal, illegal]);
  });

  test("a partial PTD credit keeps the PTD's top-down VAT basis", async () => {
    const cn = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma();
          const ptd = present((yield* pay(p.id, "1000")).ptd);
          return yield* d.correct(ptd.id, {
            reason: "část zálohy vrácena",
            lines: [{ line: lineOf(ptd, 0), quantity: dec("0.5") }],
          });
        }),
      ),
    );
    expect(buckets(cn)).toEqual([["standard", "21", "-335.57", "-70.47", "-406.04", null]]);
  });

  test("a cancelled non-tax Final Invoice releases payment removal; cancel after a Credit Note is refused", async () => {
    const [removal, cancelAfterCredit] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma({
            lines: [{ description: "Práce", unitPrice: dec("1000") }],
          });
          yield* pay(p.id, "300");
          const fi = yield* d.issueFinalInvoice(p.id);
          yield* d.cancel(fi.id, { reason: "chyba" });
          const inv = yield* issueInvoice({
            lines: [{ description: "Práce", unitPrice: dec("1000") }],
          });
          yield* d.correct(inv.id, {
            reason: "sleva",
            lines: [{ line: lineOf(inv, 0), unitPrice: dec("400") }],
          });
          return [
            yield* store.transaction(seam.removalBlocked(WS, p.id, null)),
            yield* Effect.flip(d.cancel(inv.id, { reason: "x" })),
          ] as const;
        }),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(removal).toBeNull();
    expect(cancelAfterCredit).toEqual(illegal);
  });

  test("a partial credit that closes every bucket also closes the whole-unit rounding", async () => {
    const [original, cn, after] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const f = yield* DocumentFixtures;
          yield* f.putIssuer({
            ...issuer(WS, "vat_payer", { seriesByKind: {} }),
            paymentRounding: "whole_unit",
          });
          const originalResult = yield* issueInvoice({
            lines: [{ description: "Práce", unitPrice: dec("100.40") }],
          });
          const creditNoteView = yield* d.correct(originalResult.id, {
            reason: "vše",
            lines: [{ line: lineOf(originalResult, 0) }],
          });
          return [originalResult, creditNoteView, yield* d.get(originalResult.id)] as const;
        }),
      ),
    );
    original.totals.gross.amount.pipe(str, expect).toBe("121");
    cn.totals.roundingAdjustment.amount
      .pipe(str, expect)
      .toBe(original.totals.roundingAdjustment.amount.pipe(BigDecimal.negate, str));
    cn.totals.gross.amount.pipe(str, expect).toBe("-121");
    expect(after.settlement).toBe("credited");
  });

  test("a Final Invoice refuses a number in its patch", async () => {
    const error = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* issueProforma();
          yield* pay(p.id, "100");
          return yield* Effect.flip(d.issueFinalInvoice(p.id, { patch: { number: "X-1" } }));
        }),
      ),
    );
    expect(error).toEqual(malformed(["number"], "not_allowed"));
  });
});

describe("review round 1 follow-ups", () => {
  const exhaust = (kind: "invoice" | "credit_note") =>
    Effect.flatMap(CoreStore, (store) =>
      Effect.flatMap(NumberingSeries, (n) =>
        store.transaction(
          n.configure(
            WS,
            {
              kind,
              name: "Krátká",
              pattern: `${EffectString.repeat(18)("A")}-N`,
              nextNumber: 9,
              isDefault: true,
            },
            TODAY,
          ),
        ),
      ),
    );
  const exhausted = Conflict.make({
    reason: "illegal_transition",
    detail: "numbering.pattern_invalid",
  });

  test("previews fail like issuing would on an exhausted series, and store nothing", async () => {
    const [finalPreview, finalIssue, creditPreview, creditIssue] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          yield* exhaust("invoice");
          yield* exhaust("credit_note");
          const first = yield* issueInvoice();
          yield* d.correct(first.id, { reason: "x", lines: [{ line: lineOf(first, 1) }] });
          const p = yield* issueProforma();
          yield* pay(p.id, "100");
          return [
            yield* Effect.flip(d.previewFinalInvoice(p.id)),
            yield* Effect.flip(d.issueFinalInvoice(p.id)),
            yield* Effect.flip(
              d.previewCorrection(first.id, { reason: "x", lines: [{ line: lineOf(first, 0) }] }),
            ),
            yield* Effect.flip(
              d.correct(first.id, { reason: "x", lines: [{ line: lineOf(first, 0) }] }),
            ),
          ];
        }),
      ),
    );
    expect([finalPreview, finalIssue, creditPreview, creditIssue]).toEqual([
      exhausted,
      exhausted,
      exhausted,
      exhausted,
    ]);
  });

  test("a preview's allocation is rolled back: the real call gets the same number", async () => {
    const [preview, issued] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const inv = yield* issueInvoice();
          const p = yield* issueProforma();
          yield* pay(p.id, "100");
          yield* d.previewFinalInvoice(p.id);
          yield* d.previewCorrection(inv.id, { reason: "x", lines: "full" });
          return [
            (yield* d.issueFinalInvoice(p.id)).number,
            (yield* d.correct(inv.id, { reason: "x", lines: "full" })).number,
          ] as const;
        }),
      ),
    );
    expect([preview, issued]).toEqual(["2026-0002", "OD-2026-0001"]);
  });

  test("deducted advance VAT makes an identified_person Final Invoice a tax document (cancel credits it)", async () => {
    const [fi, cancelled] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const f = yield* DocumentFixtures;
          const p = yield* issueProforma({
            lines: [{ description: "Práce", unitPrice: dec("100") }],
          });
          yield* pay(p.id, "121");
          yield* f.putIssuer(issuer(WS, "identified_person", { seriesByKind: {} }));
          const finalInvoice = yield* d.issueFinalInvoice(p.id, {
            patch: {
              lines: [{ description: "Práce", unitPrice: dec("200"), vat: "outside_scope" }],
            },
          });
          return [finalInvoice, yield* d.cancel(finalInvoice.id, { reason: "chyba" })] as const;
        }),
      ),
    );
    fi.totals.vat.amount.pipe(str, expect).toBe("-21");
    expect(fi.taxDocument).toBe(true);
    expect(cancelled.creditNote?.kind).toBe("credit_note");
    expect(cancelled.document.settlement).toBe("credited");
  });

  test("refundDue is on the paid document, never on a Credit Note", async () => {
    const [invoice, creditNote] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const inv = yield* issueInvoice();
          yield* pay(inv.id, "2980");
          const cn = yield* d.correct(inv.id, { reason: "x", lines: [{ line: lineOf(inv, 1) }] });
          return [
            (yield* store.transaction(seam.lock(WS, inv.id))).requested,
            (yield* store.transaction(seam.lock(WS, cn.id))).requested,
          ] as const;
        }),
      ),
    );
    const refundDue = str(invoice.refundDue.amount);
    expect(refundDue).toBe("560");
    creditNote.refundDue.amount.pipe(str, expect).toBe("0");
  });

  test("outside vat_payer a pre-2024 receipt settles with no PTD", async () => {
    const recordReceipt = Effect.gen(function* () {
      const p = yield* issueProforma({
        lines: [{ description: "Práce", unitPrice: dec("1000"), vat: "outside_scope" }],
      });
      return yield* pay(p.id, "100", IsoDate.make("2023-12-31"));
    });
    const first = await run(recordReceipt, { regimeA: "non_vat_payer" });
    const second = await run(recordReceipt, { regimeA: "identified_person" });
    for (const result of [ok(first), ok(second)]) {
      expect(result.ptd).toBeNull();
      expect(result.settled.settlement).toBe("partially_paid");
    }
  });

  test("a receipt before the VAT rate table is Invalid on paidOn", async () => {
    const error = ok(
      await run(
        Effect.gen(function* () {
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const caller = yield* CurrentCaller;
          const p = yield* issueProforma();
          return yield* Effect.flip(
            store.transaction(
              seam.issuePaymentTaxDocument(caller, WS, p.id, {
                amount: dec("100"),
                paidOn: IsoDate.make("2023-12-31"),
              }),
            ),
          );
        }),
      ),
    );
    expect(error).toEqual(malformed(["paidOn"], "out_of_range"));
  });

  test("a failed caller transaction rolls back the settlement, the PTD, its number and audit", async () => {
    const [before, after, historyBefore, historyAfter, next] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const caller = yield* CurrentCaller;
          const p = yield* issueProforma();
          const beforeResult = yield* d.get(p.id);
          const historyBeforeResult = yield* d.history(p.id);
          const failure = yield* Effect.flip(
            store.transaction(
              Effect.gen(function* () {
                yield* seam.lock(WS, p.id);
                yield* seam.settle(
                  caller,
                  WS,
                  p.id,
                  { amount: dec("100"), payments: 1 },
                  { action: "payment.record" },
                );
                const ptd = yield* seam.issuePaymentTaxDocument(caller, WS, p.id, {
                  amount: dec("100"),
                  paidOn: TODAY,
                });
                expect(ptd?.number).toBe("DD-2026-0001");
                return yield* Effect.fail("payment insert failed" as const);
              }),
            ),
          );
          // The transaction failed where intended: after the PTD was issued.
          expect(failure).toBe("payment insert failed");
          const afterResult = yield* d.get(p.id);
          const historyAfterResult = yield* d.history(p.id);
          const nextResult = present((yield* pay(p.id, "100")).ptd);
          return [
            beforeResult,
            afterResult,
            historyBeforeResult,
            historyAfterResult,
            nextResult,
          ] as const;
        }),
      ),
    );
    expect(await encodedView(after)).toEqual(await encodedView(before));
    expect(historyAfter).toEqual(historyBefore);
    expect(next.number).toBe("DD-2026-0001");
  });
});

// Authorization, scoping, delivery reads ----------------------------------------------------

describe("authorization and scoping", () => {
  test("accountants cannot correct or issue a Final Invoice; another Workspace sees NotFound", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const inv = yield* issueInvoice();
          const p = yield* issueProforma();
          yield* pay(p.id, "100");
          const accountant = member("accountant");
          const other = member("owner", { workspaceId: WORKSPACE_B });
          const full = { reason: "x", lines: "full" } as const;
          return [
            yield* Effect.flip(as(accountant, d.correct(inv.id, full))),
            yield* Effect.flip(as(accountant, d.previewCorrection(inv.id, full))),
            yield* Effect.flip(as(accountant, d.issueFinalInvoice(p.id))),
            yield* Effect.flip(as(accountant, d.previewFinalInvoice(p.id))),
            yield* Effect.flip(as(other, d.correct(inv.id, full))),
            yield* Effect.flip(as(other, d.previewCorrection(inv.id, full))),
            yield* Effect.flip(as(other, d.issueFinalInvoice(p.id))),
            yield* Effect.flip(as(other, d.previewFinalInvoice(p.id))),
            (yield* as(member("member"), d.correct(inv.id, full))).kind,
          ];
        }),
      ),
    );
    expect(EffectArray.every(results.slice(0, 4), Schema.is(Forbidden))).toBe(true);
    expect(EffectArray.every(results.slice(4, 8), Schema.is(NotFound))).toBe(true);
    expect(results[8]).toBe("credit_note");
  });

  test("a changed request under a used key is an idempotency mismatch", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const inv = yield* issueInvoice();
          const key = { requestKey: RequestKey.make("k-1") };
          yield* d.correct(inv.id, { reason: "a", lines: [{ line: lineOf(inv, 0) }] }, key);
          const p = yield* issueProforma();
          yield* pay(p.id, "100");
          const fiKey = { requestKey: RequestKey.make("k-2") };
          yield* d.issueFinalInvoice(p.id, undefined, fiKey);
          return [
            yield* Effect.flip(d.correct(inv.id, { reason: "b", lines: "full" }, key)),
            yield* Effect.flip(d.issueFinalInvoice(p.id, { patch: { note: "x" } }, fiKey)),
          ];
        }),
      ),
    );
    expect(results).toEqual([
      Conflict.make({ reason: "idempotency_mismatch" }),
      Conflict.make({ reason: "idempotency_mismatch" }),
    ]);
  });
});

describe("delivery read seam", () => {
  test("load returns the record, view, reminder choice, due date and contact; render passes through", async () => {
    const [loaded, bytes, missing] = ok(
      await run(
        Effect.gen(function* () {
          const reads = yield* DocumentDeliveryReads;
          const inv = yield* issueInvoice();
          const loadedResult = yield* reads.load(WS, inv.id);
          const pdfBytes = yield* reads.render(loadedResult.view, {
            template: "classic",
            language: "cs",
          });
          return [
            loadedResult,
            pdfBytes,
            yield* Effect.flip(reads.load(WORKSPACE_B, inv.id)),
          ] as const;
        }),
      ),
    );
    expect(loaded.record.id).toBe(loaded.view.id);
    expect(loaded.contactId).toBe(CZ_BUYER);
    expect(loaded.dueOn).toBe(IsoDate.make("2026-12-07"));
    expect(loaded.reminders).toEqual({ choice: "inherit", on: false });
    expect(loaded.settlement).toBe("unpaid");
    expect(loaded.overdue).toBe(false);
    expect(bytes).toEqual(fakePdfBytes(loaded.view, { template: "classic", language: "cs" }));
    expect(missing).toBeInstanceOf(NotFound);
  });
});
