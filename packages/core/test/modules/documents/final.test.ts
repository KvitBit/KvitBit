/**
 * Documents P3: corrections (D7), the Final Invoice (D8), Payment Tax Documents (P2) and the
 * stage-2 seams (`DocumentPayments`, `DocumentDeliveryReads`), on real layers.
 */
import { describe, expect, test } from "bun:test";
import type {
  Caller,
  DocumentId,
  DocumentView,
  IsoDate,
  LineId,
  RequestKey,
  TaxRegime,
} from "@kvitbit/domain/contract";
import { Conflict, Documents, Forbidden, Invalid, NotFound } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Exit, Schema } from "effect";
import { VatMath } from "../../../src/engines/vat";
import {
  DocumentDeliveryReads,
  DocumentFixtures,
  DocumentPayments,
  DocumentsRepo,
  DocumentViewData,
  fakePdfBytes,
  type LineViewData,
  reportFigures,
} from "../../../src/modules/documents";
import { NumberingSeries } from "../../../src/modules/numbering";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import type { Services } from "./fixtures";
import { as, CZ_BUYER, dec, EUR, fixing, invoiceInput, issuer, scenario, str } from "./fixtures";

const WS = WORKSPACE_A;
const TODAY = "2026-11-23" as IsoDate;

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const illegal = new Conflict({ reason: "illegal_transition" });
const malformed = (path: ReadonlyArray<string | number>, reason: string) =>
  new Invalid({ issues: [{ path, code: "request.malformed", params: { reason } }] });
const exceeds = (remaining: string) =>
  new Invalid({
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
      ...(options.caller === undefined ? {} : { caller: options.caller }),
      ...(options.regimeA === undefined ? {} : { regimeA: options.regimeA }),
      ...(options.fixings === undefined ? {} : { fixings: options.fixings }),
    },
  );

const docs = Documents;
const issueInvoice = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  Effect.flatMap(docs, (d) => d.issue({ input: invoiceInput(extra) }));
const issueProforma = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  issueInvoice({ kind: "proforma", ...extra });

const amounts = (view: DocumentView) => ({
  net: str(view.totals.net.amount),
  vat: str(view.totals.vat.amount),
  gross: str(view.totals.gross.amount),
});
const buckets = (view: Pick<DocumentView, "totals">) =>
  view.totals.buckets.map((b) => [
    b.treatment,
    str(b.ratePercent),
    str(b.base),
    str(b.vat),
    str(b.gross),
    b.vatCzk === null ? null : str(b.vatCzk),
  ]);
const json = (view: DocumentView) =>
  Schema.encodeSync(Schema.toCodecJson(DocumentViewData))(view as never);
const lines = (view: DocumentView) => view.lines as unknown as ReadonlyArray<LineViewData>;
/** Lines without ids, JSON-encoded (decimal caches differ between equal values). */
const plainLines = (view: DocumentView) =>
  (json(view) as { readonly lines: ReadonlyArray<{ readonly id: string }> }).lines.map(
    ({ id: _id, ...l }) => l,
  );
const lineOf = (view: DocumentView, i: number) => lines(view)[i]?.id as LineId;

/** Records a payment the way Payments will: lock, settle, PTD in one transaction. */
const pay = (id: DocumentId, amount: string, paidOn: IsoDate = TODAY) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const seam = yield* DocumentPayments;
    return yield* store.transaction(
      Effect.gen(function* () {
        const targets = yield* seam.lock(WS, id);
        const on = targets.settleOn;
        const settled = yield* seam.settle(
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
            ? yield* seam.issuePaymentTaxDocument(WS, on.id, { amount: dec(amount), paidOn })
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
          const d = yield* docs;
          const original = yield* issueInvoice();
          const key = { requestKey: "corr-1" as RequestKey };
          const cn = yield* d.correct(original.id, { reason: " sleva ", lines: "full" }, key);
          const replay = yield* d.correct(original.id, { reason: " sleva ", lines: "full" }, key);
          return [original, cn, replay, yield* d.get(original.id), yield* d.history(original.id)];
        }),
      ),
    );
    expect(cn.kind).toBe("credit_note");
    expect(cn.number).toBe("OD-2026-0001");
    expect(cn.totals).toEqual(VatMath.negate(original.totals));
    expect(lines(cn).map((l) => str(l.quantity))).toEqual(["-2", "-1"]);
    expect(cn.related).toEqual([
      { relation: "corrects", id: original.id, kind: "invoice", number: "2026-0001" },
    ]);
    expect(json(replay)).toEqual(json(cn));
    expect(after.settlement).toBe("credited");
    expect(after.revision).toBe(original.revision + 1);
    expect(history.at(-1)).toMatchObject({ action: "document.correct", reason: "sleva" });
  });

  test("partial: picked quantities and prices, D7 cap per bucket, then the remainder", async () => {
    const [original, first, priced, over, rest, after, again] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const original = yield* issueInvoice();
          const first = yield* d.correct(original.id, {
            reason: "1 hodina méně",
            lines: [{ line: lineOf(original, 0), quantity: dec("1") }],
          });
          const priced = yield* d.correct(original.id, {
            reason: "sleva na knihu",
            lines: [{ line: lineOf(original, 1), unitPrice: dec("100") }],
          });
          const over = yield* Effect.flip(
            d.correct(original.id, {
              reason: "znovu",
              lines: [{ line: lineOf(original, 0), quantity: dec("1.5") }],
            }),
          );
          const rest = yield* d.correct(original.id, { reason: "zbytek", lines: "full" });
          return [
            original,
            first,
            priced,
            over,
            rest,
            yield* d.get(original.id),
            yield* Effect.flip(d.correct(original.id, { reason: "x", lines: "full" })),
          ] as const;
        }),
      ),
    );
    expect(amounts(first)).toEqual({ net: "-1000", vat: "-210", gross: "-1210" });
    expect(
      lines(first).map((l) => [str(l.quantity), str(l.unitPrice), str(l.ratePercent)]),
    ).toEqual([["-1", "1000", "21"]]);
    expect(amounts(priced)).toEqual({ net: "-100", vat: "-12", gross: "-112" });
    expect(over).toEqual(exceeds("1658"));
    expect(amounts(rest)).toEqual({ net: "-1400", vat: "-258", gross: "-1658" });
    expect(after.settlement).toBe("credited");
    expect(after.related.map((r) => r.relation)).toEqual([
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
          const d = yield* docs;
          const repo = yield* DocumentsRepo;
          const original = yield* issueInvoice();
          const input = {
            reason: "reklamace",
            lines: [{ line: lineOf(original, 0), quantity: dec("0.5") }],
            correctedOn: "2026-11-23" as IsoDate,
          };
          const before = (yield* repo.search(WS, {}, { limit: 50 })).rows.length;
          const preview = yield* d.previewCorrection(original.id, input);
          const after = (yield* repo.search(WS, {}, { limit: 50 })).rows.length;
          const issued = yield* d.correct(original.id, input);
          return [preview, issued, before, after] as const;
        }),
      ),
    );
    expect(countAfter).toBe(countBefore);
    expect(preview.number).toBeNull();
    expect(preview.totals).toEqual(issued.totals);
    expect(preview.dates).toEqual(issued.dates);
    expect(plainLines(preview)).toEqual(plainLines(issued));
    expect(preview.related).toEqual(issued.related);
  });

  test("input, kind and state checks", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
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
                correctedOn: "2026-11-24" as IsoDate,
              }),
            ),
            yield* Effect.flip(
              d.correct(inv.id, {
                reason: "x",
                lines: "full",
                correctedOn: "2026-11-22" as IsoDate,
              }),
            ),
            yield* Effect.flip(d.correct(inv.id, pick("nope" as LineId))),
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
      new Conflict({ reason: "document_locked" }),
      illegal,
      illegal,
    ]);
  });

  test("a partial credit lowers what is owed: paying the rest settles the invoice", async () => {
    const [paid, overpaid] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const a = yield* issueInvoice();
          yield* d.correct(a.id, {
            reason: "sleva",
            lines: [{ line: lineOf(a, 0), quantity: dec("1") }],
          });
          const paid = yield* pay(a.id, "1770");
          const b = yield* issueInvoice();
          yield* pay(b.id, "2980");
          yield* d.correct(b.id, {
            reason: "vratka",
            lines: [{ line: lineOf(b, 1), quantity: dec("1") }],
          });
          return [paid.settled.settlement, (yield* d.get(b.id)).settlement] as const;
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
          const d = yield* docs;
          const p = yield* issueProforma();
          const result = yield* pay(p.id, "1000", "2026-11-20" as IsoDate);
          const ptdId = result.ptd?.id as DocumentId;
          return [result, yield* d.get(p.id), yield* d.history(ptdId), yield* d.history(p.id)];
        }),
      ),
    );
    const ptd = result.ptd as DocumentView;
    expect(ptd.kind).toBe("payment_tax_document");
    expect(ptd.number).toBe("DD-2026-0001");
    expect(ptd.taxDocument).toBe(true);
    expect(ptd.settlement).toBe("paid");
    expect(ptd.dates).toEqual({
      issuedOn: TODAY,
      taxableSupplyOn: "2026-11-20" as IsoDate,
      dueOn: TODAY,
    });
    expect(buckets(ptd)).toEqual([
      ["standard", "21", "671.14", "140.94", "812.08", null],
      ["reduced", "12", "167.79", "20.13", "187.92", null],
    ]);
    expect(str(ptd.totals.gross.amount)).toBe("1000");
    expect(ptd.related).toEqual([
      { relation: "advance_of", id: proforma.id, kind: "proforma", number: "ZF-2026-0001" },
    ]);
    expect(result.settled.settlement).toBe("partially_paid");
    expect(proforma.settlement).toBe("partially_paid");
    expect(proforma.related.map((r) => [r.relation, r.id])).toEqual([["tax_document_for", ptd.id]]);
    // settle and the PTD link each bump the Proforma's revision.
    expect(proforma.revision).toBe(3);
    expect(ptdHistory.map((e) => e.action)).toEqual(["document.issue"]);
    expect(pHistory.map((e) => e.action)).toEqual([
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
          return (yield* pay(p.id, "605", "2026-11-21" as IsoDate)).ptd as DocumentView;
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
          const d = yield* docs;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
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
                  WS,
                  p.id,
                  { amount: dec(amount), payments },
                  { action, reason: "test" },
                ),
              ),
            );
          const steps = [
            first.settled.settlement,
            (yield* set("1000", 2, "payment.record")).settlement,
            (yield* set("1500", 3, "payment.record")).settlement,
            (yield* set("1000", 2, "payment.remove")).settlement,
            (yield* set("0", 0, "payment.remove")).settlement,
          ];
          return [first.ptd, steps, yield* d.history(p.id)] as const;
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
          const d = yield* docs;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const draft = yield* d.createDraft(invoiceInput());
          const inv = yield* issueInvoice();
          const cn = yield* d.correct(inv.id, { reason: "x", lines: "full" });
          const proforma = yield* issueProforma();
          const cancelled = (yield* d.cancel(proforma.id, { reason: "x" })).document;
          const settle = (id: DocumentId, amount: string, payments: number) =>
            Effect.flip(
              store.transaction(
                seam.settle(
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
      new NotFound({ entity: "Document", id: results[5] instanceof NotFound ? results[5].id : "" }),
    ]);
  });

  test("lock takes the Proforma first and settles on its Final Invoice once it has one", async () => {
    const [locks, viaProforma, viaInvoice] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          const fi = yield* d.issueFinalInvoice(p.id);
          const locks: Array<DocumentId> = [];
          const spy = DocumentsRepo.of({
            ...repo,
            lock: (ws, id) =>
              Effect.andThen(
                Effect.sync(() => locks.push(id)),
                repo.lock(ws, id),
              ),
          });
          const lockAs = (id: DocumentId) =>
            Effect.provideService(store.transaction(seam.lock(WS, id)), DocumentsRepo, spy);
          const viaInvoice = yield* lockAs(fi.id);
          const first = [...locks];
          locks.length = 0;
          const viaProforma = yield* lockAs(p.id);
          return [
            { invoice: first, proforma: [...locks], p: p.id, fi: fi.id },
            viaProforma,
            viaInvoice,
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
          const d = yield* docs;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const blocked = (target: DocumentId, ptd: DocumentId | null) =>
            store.transaction(seam.removalBlocked(WS, target, ptd));
          const a = yield* issueProforma();
          const ptdA = (yield* pay(a.id, "500")).ptd as DocumentView;
          const before = yield* blocked(a.id, ptdA.id);
          yield* d.correct(ptdA.id, { reason: "chybná záloha", lines: "full" });
          const credited = yield* blocked(a.id, ptdA.id);
          const b = yield* issueProforma();
          const ptdB = (yield* pay(b.id, "500")).ptd as DocumentView;
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
          const d = yield* docs;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma({ due: { on: TODAY } });
          yield* pay(p.id, "3000");
          const fi = yield* d.issueFinalInvoice(p.id);
          return [yield* store.transaction(seam.lock(WS, fi.id)), yield* d.get(p.id)] as const;
        }),
      ),
    );
    expect(str(targets.settleOn.owed.amount)).toBe("-20");
    expect(str(targets.settleOn.refundDue.amount)).toBe("20");
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
          const d = yield* docs;
          const p = yield* issueProforma();
          const { ptd } = yield* pay(p.id, "1000");
          const preview = yield* d.previewFinalInvoice(p.id);
          const key = { requestKey: "fi-1" as RequestKey };
          const fi = yield* d.issueFinalInvoice(p.id, undefined, key);
          const replay = yield* d.issueFinalInvoice(p.id, undefined, key);
          return [
            ptd as DocumentView,
            preview,
            fi,
            replay,
            yield* d.get(p.id),
            yield* Effect.flip(d.issueFinalInvoice(p.id)),
            yield* d.history(p.id),
          ] as const;
        }),
      ),
    );
    expect(fi.kind).toBe("invoice");
    expect(fi.number).toBe("2026-0001");
    expect(lines(fi).map((l) => [str(l.quantity), str(l.unitPrice), l.deducts])).toEqual([
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
    expect(fi.related.map((r) => [r.relation, r.id])).toEqual([
      ["advance_of", proforma.id],
      ["deducts", ptd.id],
    ]);
    expect(proforma.related.map((r) => r.relation)).toEqual([
      "tax_document_for",
      "final_invoice_for",
    ]);
    expect(json(replay)).toEqual(json(fi));
    expect(dup).toEqual(new Conflict({ reason: "duplicate" }));
    expect(preview.number).toBeNull();
    expect(preview.totals).toEqual(fi.totals);
    expect(plainLines(preview)).toEqual(plainLines(fi));
    expect(history.at(-1)).toMatchObject({ action: "document.finalInvoice" });
    // Reports: the full supply plus the deducted advance (#384).
    const figures = reportFigures({
      lines: lines(fi).map((l, i) => ({
        ...(l as never as object),
        deductedVat: i < 2 ? null : dec(i === 2 ? "-140.94" : "-20.13"),
        deductedVatCzk: null,
      })) as never,
      totals: fi.totals,
      currency: fi.totals.gross.currency,
      pricesIncludeVat: false,
    });
    expect(str(figures.totals.gross.amount)).toBe("2980");
    expect(figures.advanceDeductions).toEqual(ptd.totals.buckets);
  });

  test("a patch changes terms and lines but keeps the deductions; currency changes are refused", async () => {
    const [fi, currency] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          const currency = yield* Effect.flip(
            d.previewFinalInvoice(p.id, { patch: { currency: EUR } }),
          );
          const fi = yield* d.issueFinalInvoice(p.id, {
            patch: {
              lines: [{ description: "Dodávka", quantity: dec("3"), unitPrice: dec("1000") }],
              taxableSupplyOn: "2026-11-22" as IsoDate,
            },
          });
          return [fi, currency] as const;
        }),
        { fixings: [fixing("2026-11-23", "25.000")] },
      ),
    );
    expect(fi.dates.taxableSupplyOn).toBe("2026-11-22" as IsoDate);
    expect(lines(fi).map((l) => l.deducts === null)).toEqual([true, false, false]);
    expect(buckets(fi)).toEqual([
      ["standard", "21", "2328.86", "489.06", "2817.92", null],
      ["reduced", "12", "-167.79", "-20.13", "-187.92", null],
    ]);
    expect(currency).toEqual(
      new Invalid({
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
          const d = yield* docs;
          const p = yield* issueProforma({
            lines: [{ description: "Práce", unitPrice: dec("1000") }],
          });
          yield* pay(p.id, "300");
          const fi = yield* d.issueFinalInvoice(p.id);
          const q = yield* issueProforma({
            lines: [{ description: "Práce", unitPrice: dec("1000") }],
          });
          yield* pay(q.id, "1000");
          return [fi, yield* d.issueFinalInvoice(q.id)] as const;
        }),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(
      lines(fi).map((l) => [l.treatment, str(l.quantity), str(l.unitPrice), l.deducts]),
    ).toEqual([
      ["outside_scope", "1", "1000", null],
      ["outside_scope", "-1", "300", fi.related[0]?.id ?? null],
    ]);
    expect(amounts(fi)).toEqual({ net: "700", vat: "0", gross: "700" });
    expect(fi.related.map((r) => r.relation)).toEqual(["advance_of"]);
    expect(str(full.totals.gross.amount)).toBe("0");
    expect(full.settlement).toBe("paid");
    expect(full.overdue).toBe(false);
  });

  test("a full Credit Note of a Final Invoice reverses its deductions too", async () => {
    const [fi, cn] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          const fi = yield* d.issueFinalInvoice(p.id);
          return [fi, yield* d.correct(fi.id, { reason: "storno", lines: "full" })] as const;
        }),
      ),
    );
    expect(cn.totals).toEqual(VatMath.negate(fi.totals));
    expect(lines(cn).map((l) => l.deducts)).toEqual(lines(fi).map((l) => l.deducts));
    const partial = await run(
      Effect.gen(function* () {
        const d = yield* docs;
        const p = yield* issueProforma();
        yield* pay(p.id, "1000");
        const invoice = yield* d.issueFinalInvoice(p.id);
        return yield* Effect.flip(
          d.correct(invoice.id, { reason: "x", lines: [{ line: lineOf(invoice, 2) }] }),
        );
      }),
    );
    expect(ok(partial)).toEqual(malformed(["lines", 0, "line"], "deduction_line"));
  });

  test("checks: unpaid Proforma, not a Proforma, draft, cancelled", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
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
    const unpaid = new Invalid({
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
          const d = yield* docs;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          // A payment recorded without a PTD (user-flows 3.8: unticked).
          yield* store.transaction(
            Effect.andThen(seam.lock(WS, p.id), () =>
              seam.settle(
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
    expect(lines(fi).map((l) => [l.treatment, str(l.unitPrice), l.deducts !== null])).toEqual([
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
          const d = yield* docs;
          const inv = yield* issueInvoice({
            lines: [
              { description: "Práce", quantity: dec("2"), unitPrice: dec("1000") },
              { description: "Sleva", quantity: dec("-1"), unitPrice: dec("200") },
            ],
          });
          const cn = yield* Effect.flip(
            d.correct(inv.id, { reason: "sleva neplatí", lines: [{ line: lineOf(inv, 1) }] }),
          );
          // With a work line the net effect is a credit: the discount line runs positive.
          const both = yield* d.correct(inv.id, {
            reason: "storno části",
            lines: [{ line: lineOf(inv, 0), quantity: dec("1") }, { line: lineOf(inv, 1) }],
          });
          expect(lines(both).map((l) => [str(l.quantity), str(l.unitPrice)])).toEqual([
            ["-1", "1000"],
            ["1", "200"],
          ]);
          expect(amounts(both)).toEqual({ net: "-800", vat: "-168", gross: "-968" });
          const zero = yield* Effect.flip(
            d.correct(inv.id, {
              reason: "x",
              lines: [{ line: lineOf(inv, 0), unitPrice: dec("0") }],
            }),
          );
          return [cn, zero] as const;
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
          const d = yield* docs;
          const p = yield* issueProforma();
          yield* pay(p.id, "1000");
          const fi = yield* d.issueFinalInvoice(p.id);
          const partial = yield* d.correct(fi.id, {
            reason: "méně hodin",
            lines: [{ line: lineOf(fi, 0), quantity: dec("1") }],
          });
          const rest = yield* d.correct(fi.id, { reason: "zbytek", lines: "full" });
          return [yield* d.get(fi.id), partial, rest] as const;
        }),
      ),
    );
    expect(fi.settlement).toBe("credited");
    expect(lines(rest).map((l) => [str(l.quantity), str(l.unitPrice), l.deducts !== null])).toEqual(
      [
        ["-1", "1000", false],
        ["-1", "500", false],
        ["1", "671.14", true],
        ["1", "167.79", true],
      ],
    );
    const sum = (k: "net" | "vat" | "gross") =>
      str(
        [fi, partial, rest].reduce(
          (acc, v) => BigDecimal.sum(acc, v.totals[k].amount),
          BigDecimal.fromBigInt(0n),
        ),
      );
    expect([sum("net"), sum("vat"), sum("gross")]).toEqual(["0", "0", "0"]);
    const deductions = reportFigures({
      ...(rest as never as object),
      lines: lines(rest).map((l) => ({
        ...l,
        deductedVat:
          l.deducts === null ? null : dec(str(l.unitPrice) === "671.14" ? "140.94" : "20.13"),
        deductedVatCzk: null,
      })) as never,
      totals: rest.totals,
      currency: rest.totals.gross.currency,
      pricesIncludeVat: false,
    }).advanceDeductions;
    expect(deductions.map((b) => str(b.gross))).toEqual(["-812.08", "-187.92"]);
  });
});

describe("diff council follow-ups", () => {
  test("a prepaid Final Invoice can be credited partially and is credited only once its deductions are reversed", async () => {
    const [partial, afterPartial, afterFull, removal] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma();
          const { ptd } = yield* pay(p.id, "2980");
          const fi = yield* d.issueFinalInvoice(p.id);
          const partial = yield* d.correct(fi.id, {
            reason: "méně práce",
            lines: [{ line: lineOf(fi, 0), quantity: dec("1") }],
          });
          const afterPartial = yield* d.get(fi.id);
          yield* d.correct(fi.id, { reason: "storno", lines: "full" });
          return [
            partial,
            afterPartial,
            yield* d.get(fi.id),
            yield* store.transaction(seam.removalBlocked(WS, p.id, (ptd as DocumentView).id)),
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
          const d = yield* docs;
          const store = yield* CoreStore;
          const seam = yield* DocumentPayments;
          const p = yield* issueProforma();
          const ptd = (yield* pay(p.id, "1000")).ptd as DocumentView;
          yield* d.issueFinalInvoice(p.id);
          return [
            yield* Effect.flip(d.correct(ptd.id, { reason: "x", lines: "full" })),
            yield* Effect.flip(d.previewCorrection(ptd.id, { reason: "x", lines: "full" })),
            yield* Effect.flip(d.cancel(ptd.id, { reason: "x" })),
            yield* Effect.flip(
              store.transaction(
                seam.issuePaymentTaxDocument(WS, p.id, { amount: dec("1"), paidOn: TODAY }),
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
          const d = yield* docs;
          const p = yield* issueProforma();
          const ptd = (yield* pay(p.id, "1000")).ptd as DocumentView;
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
          const d = yield* docs;
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
          const d = yield* docs;
          const f = yield* DocumentFixtures;
          yield* f.putIssuer({
            ...issuer(WS, "vat_payer", { seriesByKind: {} }),
            paymentRounding: "whole_unit",
          });
          const original = yield* issueInvoice({
            lines: [{ description: "Práce", unitPrice: dec("100.40") }],
          });
          const cn = yield* d.correct(original.id, {
            reason: "vše",
            lines: [{ line: lineOf(original, 0) }],
          });
          return [original, cn, yield* d.get(original.id)] as const;
        }),
      ),
    );
    expect(str(original.totals.gross.amount)).toBe("121");
    expect(str(cn.totals.roundingAdjustment.amount)).toBe(
      str(BigDecimal.negate(original.totals.roundingAdjustment.amount)),
    );
    expect(str(cn.totals.gross.amount)).toBe("-121");
    expect(after.settlement).toBe("credited");
  });

  test("a Final Invoice refuses a number in its patch", async () => {
    const error = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const p = yield* issueProforma();
          yield* pay(p.id, "100");
          return yield* Effect.flip(d.issueFinalInvoice(p.id, { patch: { number: "X-1" } }));
        }),
      ),
    );
    expect(error).toEqual(malformed(["number"], "not_allowed"));
  });
});

// Authorization, scoping, delivery reads ----------------------------------------------------

describe("authorization and scoping", () => {
  test("accountants cannot correct or issue a Final Invoice; another Workspace sees NotFound", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
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
    expect(results.slice(0, 4).every((e) => e instanceof Forbidden)).toBe(true);
    expect(results.slice(4, 8).every((e) => e instanceof NotFound)).toBe(true);
    expect(results[8]).toBe("credit_note");
  });

  test("a changed request under a used key is an idempotency mismatch", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const inv = yield* issueInvoice();
          const key = { requestKey: "k-1" as RequestKey };
          yield* d.correct(inv.id, { reason: "a", lines: [{ line: lineOf(inv, 0) }] }, key);
          const p = yield* issueProforma();
          yield* pay(p.id, "100");
          const fiKey = { requestKey: "k-2" as RequestKey };
          yield* d.issueFinalInvoice(p.id, undefined, fiKey);
          return [
            yield* Effect.flip(d.correct(inv.id, { reason: "b", lines: "full" }, key)),
            yield* Effect.flip(d.issueFinalInvoice(p.id, { patch: { note: "x" } }, fiKey)),
          ];
        }),
      ),
    );
    expect(results).toEqual([
      new Conflict({ reason: "idempotency_mismatch" }),
      new Conflict({ reason: "idempotency_mismatch" }),
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
          const loaded = yield* reads.load(WS, inv.id, { deliveries: [] });
          const bytes = yield* reads.render(loaded.view, { template: "classic", language: "cs" });
          return [loaded, bytes, yield* Effect.flip(reads.load(WORKSPACE_B, inv.id))] as const;
        }),
      ),
    );
    expect(loaded.record.id).toBe(loaded.view.id);
    expect(loaded.contactId).toBe(CZ_BUYER);
    expect(loaded.dueOn).toBe("2026-12-07" as IsoDate);
    expect(loaded.reminders).toEqual({ choice: "inherit", on: false });
    expect(loaded.settlement).toBe("unpaid");
    expect(loaded.overdue).toBe(false);
    expect(bytes).toEqual(fakePdfBytes(loaded.view, { template: "classic", language: "cs" }));
    expect(missing).toBeInstanceOf(NotFound);
  });
});
