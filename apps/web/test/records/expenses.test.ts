import { describe, expect, test } from "bun:test";
import { ExpenseId } from "@kvitbit/domain";
import * as Expenses from "../../src/page/records/expenses";
import {
  computeExpensePreview,
  type ExpenseSummaryRecord,
  type ExpenseViewRecord,
} from "../../src/page/records/shared";
import { ctxFor, renderPath, WS } from "../support";

const SAMPLE_SUMMARY: ExpenseSummaryRecord = {
  id: "0193a000-0000-7000-8000-000000000401",
  revision: 1,
  status: "complete",
  supplierName: "Alza.cz a.s.",
  supplierDocumentNumber: "2026-ALZ-1",
  issuedOn: "2026-11-16",
  total: "24200.00",
  currency: "CZK",
  category: "Hardware",
  tags: ["monitor"],
  attachments: 1,
  settlement: "paid",
};

const SAMPLE_INCOMPLETE: ExpenseSummaryRecord = {
  id: "0193a000-0000-7000-8000-000000000403",
  revision: 1,
  status: "incomplete",
  supplierName: null,
  supplierDocumentNumber: null,
  issuedOn: null,
  total: null,
  currency: null,
  category: null,
  tags: [],
  attachments: 1,
  settlement: "unpaid",
};

const SAMPLE_VIEW: ExpenseViewRecord = {
  id: "0193a000-0000-7000-8000-000000000401",
  revision: 2,
  status: "complete",
  supplier: { contactId: null, name: "Alza.cz a.s.", ico: "27082440", dic: "CZ27082440" },
  supplierDocumentNumber: "2026-ALZ-1",
  issuedOn: "2026-11-16",
  taxableSupplyOn: "2026-11-16",
  dueOn: "2026-11-30",
  currency: "CZK",
  total: "24200.00",
  vat: [{ treatment: "standard", base: "20000.00", vat: "4200.00", selfAssessed: null }],
  totals: null,
  selfAssessed: [],
  fx: null,
  totalCzk: "24200.00",
  deductibility: "full",
  deductibleVat: { amount: "4200.00", currency: "CZK" },
  deductibleVatCzk: "4200.00",
  category: "Hardware",
  tags: ["monitor"],
  note: null,
  attachments: [],
  payment: { settlement: "unpaid", paid: null, payments: 0 },
  createdAt: "2026-11-16T08:00:00.000Z",
  updatedAt: "2026-11-16T08:00:00.000Z",
};

describe("Expenses page TEA", () => {
  test("init loads expenses list and uses Czech term Náklady in cs", () => {
    const route: Expenses.Route = { _tag: "Expenses", ws: WS, query: {} };
    const ctxCs = ctxFor(route, { locale: "cs" });
    const ctxEn = ctxFor(route, { locale: "en" });
    const res = Expenses.init(route, ctxCs);
    expect(res.model.list._tag).toBe("Loading");
    expect(res.commands?.length).toBe(1);
    expect(Expenses.title(res.model, ctxCs)).toBe("Náklady");
    expect(Expenses.title(res.model, ctxEn)).toBe("Expenses");
  });

  test("stale-seq safety drops out-of-order list responses", () => {
    const route: Expenses.Route = { _tag: "Expenses", ws: WS, query: {} };
    const ctx = ctxFor(route);
    let { model } = Expenses.init(route, ctx);
    // Switch filter bumps seq to 2
    model = Expenses.update(
      model,
      Expenses.Message.SelectedFilter({ filter: "incomplete" }),
      ctx,
    ).model;
    expect(model.list._tag).toBe("Loading");
    // Late seq 1 response must be ignored
    model = Expenses.update(
      model,
      Expenses.Message.LoadedList({ seq: 1, items: [SAMPLE_SUMMARY] }),
      ctx,
    ).model;
    expect(model.list._tag).toBe("Loading");
    // Current seq 2 response succeeds
    model = Expenses.update(
      model,
      Expenses.Message.LoadedList({ seq: 2, items: [SAMPLE_INCOMPLETE] }),
      ctx,
    ).model;
    expect(model.list._tag).toBe("Loaded");
    if (model.list._tag !== "Loaded") throw new Error("Expected Loaded");
    expect(model.list.data).toHaveLength(1);
    expect(model.list.data[0]?.status).toBe("incomplete");
  });

  test("VAT & FX math preview computes partial deductibility and CNB CZK equivalent", () => {
    const preview = computeExpensePreview({
      total: "121.00",
      currency: "EUR",
      vatLines: [{ treatment: "standard", base: "100.00", vat: "21.00", selfAssessed: null }],
      deductibilityMode: "partial",
      deductibilityPercent: "50",
      fxRate: "25.20",
      fxQuantity: 1,
    });
    expect(preview.sumBase).toBe(100);
    expect(preview.sumVat).toBe(21);
    expect(preview.sumGross).toBe(121);
    expect(preview.difference).toBe(0);
    expect(preview.deductiblePercent).toBe(50);
    expect(preview.deductibleVat).toBe(10.5);
    expect(preview.totalCzk).toBe(3049.2);
    expect(preview.deductibleVatCzk).toBe(264.6);
  });

  test("reverse charge self-assessed VAT contributes to deductible VAT", () => {
    const preview = computeExpensePreview({
      total: "100.00",
      currency: "EUR",
      vatLines: [
        { treatment: "reverse_charge", base: "100.00", vat: "0.00", selfAssessed: "standard" },
      ],
      deductibilityMode: "full",
      deductibilityPercent: "100",
      fxRate: "25.00",
      fxQuantity: 1,
    });
    expect(preview.difference).toBe(0);
    expect(preview.deductibleVat).toBe(21);
    expect(preview.deductibleVatCzk).toBe(525);
  });

  test("editor validates supplier IČO before calling ARES and fills supplier on success", () => {
    const route: Expenses.Route = { _tag: "Expense", ws: WS, id: "new", mode: "edit" };
    const ctx = ctxFor(route);
    let { model } = Expenses.init(route, ctx);
    model = Expenses.update(
      model,
      Expenses.Message.ChangedEditorField({ field: "supplierIco", value: "123" }),
      ctx,
    ).model;
    const bad = Expenses.update(model, Expenses.Message.ClickedAresLookup(), ctx);
    expect(bad.commands ?? []).toHaveLength(0);
    expect(bad.model.editor?.aresError).not.toBeNull();

    // Valid Czech IČO (Alza: 27082440) triggers ARES command
    model = Expenses.update(
      model,
      Expenses.Message.ChangedEditorField({ field: "supplierIco", value: "27082440" }),
      ctx,
    ).model;
    const ok = Expenses.update(model, Expenses.Message.ClickedAresLookup(), ctx);
    expect(ok.commands?.length).toBe(1);
    expect(ok.model.editor?.aresBusy).toBe(true);
    const seq = ok.model.editor?.aresSeq ?? 0;

    // Stale ARES seq is ignored
    const stale = Expenses.update(
      ok.model,
      Expenses.Message.LoadedAresSupplier({
        seq: seq - 1,
        contactId: "c-old",
        name: "Old",
        ico: "27082440",
        dic: null,
      }),
      ctx,
    );
    expect(stale.model.editor?.supplierName).toBe("");

    // Current ARES seq fills supplier fields
    const loaded = Expenses.update(
      ok.model,
      Expenses.Message.LoadedAresSupplier({
        seq,
        contactId: "c-alza",
        name: "Alza.cz a.s.",
        ico: "27082440",
        dic: "CZ27082440",
      }),
      ctx,
    );
    expect(loaded.model.editor?.supplierName).toBe("Alza.cz a.s.");
    expect(loaded.model.editor?.supplierDic).toBe("CZ27082440");
    expect(loaded.model.editor?.supplierContactId).toBe("c-alza");
  });

  test("currency change to EUR fetches CNB FX rate and updates preview", () => {
    const route: Expenses.Route = { _tag: "Expense", ws: WS, id: "new", mode: "edit" };
    const ctx = ctxFor(route);
    const { model } = Expenses.init(route, ctx);
    const changed = Expenses.update(
      model,
      Expenses.Message.ChangedEditorField({ field: "currency", value: "EUR" }),
      ctx,
    );
    expect(changed.commands?.length).toBe(1);
    expect(changed.model.editor?.fxBusy).toBe(true);
    const seq = changed.model.editor?.fxSeq ?? 0;
    const fxLoaded = Expenses.update(
      changed.model,
      Expenses.Message.LoadedFxRate({ seq, rate: "25.20", quantity: 1, fixingDate: "2026-11-24" }),
      ctx,
    );
    expect(fxLoaded.model.editor?.fxRate).toBe("25.20");
    expect(fxLoaded.model.editor?.fxBusy).toBe(false);
  });

  test("expense detail opens payment dialog and records payment", () => {
    const route: Expenses.Route = {
      _tag: "Expense",
      ws: WS,
      id: ExpenseId.make(SAMPLE_VIEW.id),
      mode: "view",
    };
    const ctx = ctxFor(route);
    let { model } = Expenses.init(route, ctx);
    model = Expenses.update(
      model,
      Expenses.Message.LoadedDetail({ seq: 1, expense: SAMPLE_VIEW }),
      ctx,
    ).model;
    const opened = Expenses.update(
      model,
      Expenses.Message.OpenedPaymentDialog({ presetFull: true }),
      ctx,
    );
    expect(opened.model.paymentDialog?.amount).toBe("24200.00");
    const submitted = Expenses.update(opened.model, Expenses.Message.SubmittedPayment(), ctx);
    expect(submitted.commands?.length).toBe(1);
    expect(submitted.model.paymentDialog?.submitting).toBe(true);
  });

  test("SSR renders expenses list, capture, and editor routes in cs and en", async () => {
    const csList = await renderPath(`/w/${WS}/expenses`, { locale: "cs" });
    expect(csList.title).toContain("Náklady");
    expect(csList.html).toContain("kb-dropzone");

    const enList = await renderPath(`/w/${WS}/expenses`, { locale: "en" });
    expect(enList.title).toContain("Expenses");

    const capture = await renderPath(`/w/${WS}/expenses/capture`, { locale: "cs" });
    expect(capture.html).toContain("kb-capture-stage");

    const newExp = await renderPath(`/w/${WS}/expenses/new?mode=edit`, { locale: "en" });
    expect(newExp.html).toContain("kb-expense-split");
  });
});
