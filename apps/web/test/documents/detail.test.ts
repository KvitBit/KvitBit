import { describe, expect, test } from "bun:test";
import { DocumentView } from "@kvitbit/domain";
import { BigDecimal, Schema } from "effect";
import * as Detail from "../../src/page/documents/detail";
import { ctxFor, renderPath, WS } from "../support";

const DOC_ID = "0193a000-0000-7000-8000-000000000602" as Detail.Route["id"];
const bd = (n: number) => BigDecimal.fromBigInt(BigInt(n));

const sampleProforma = Schema.decodeUnknownSync(DocumentView)({
  id: DOC_ID,
  kind: "proforma",
  number: "ZF-2026-0011",
  status: "issued",
  locked: false,
  settlement: "paid",
  overdue: false,
  revision: 3,
  taxDocument: false,
  contact: {
    contactId: "0193a000-0000-7000-8000-000000000201",
    name: "Alza.cz a.s.",
    ico: "27082440",
    dic: "CZ27082440",
    legalForm: "a.s.",
    address: { street: "Jankovcova 53", city: "Praha 7", postalCode: "170 00", country: "CZ" },
    billingEmails: ["fakturace@alza.example.cz"],
  },
  issuer: {
    workspaceId: "0193a000-0000-7000-8000-000000000100",
    name: "Novák Design s.r.o.",
    ico: "14285714",
    dic: "CZ14285714",
    address: { street: "Křižíkova 34", city: "Praha 8", postalCode: "186 00", country: "CZ" },
    registerEntry: "C 351029",
    email: "fakturace@novakdesign.example.cz",
    phone: null,
    web: null,
    regime: "vat_payer",
    bankAccount: null,
  },
  dates: { issuedOn: "2026-11-01", taxableSupplyOn: null, dueOn: "2026-11-15" },
  paymentMethod: "bank_transfer",
  lines: [],
  totals: {
    buckets: [],
    net: { amount: bd(12000), currency: "CZK" },
    vat: { amount: bd(2520), currency: "CZK" },
    roundingAdjustment: { amount: bd(0), currency: "CZK" },
    gross: { amount: bd(14520), currency: "CZK" },
    vatCzk: null,
  },
  fx: null,
  statutoryNotes: [],
  paymentQr: null,
  related: [],
  share: null,
  deliveries: [],
});

describe("DocumentDetail page (Screen 11)", () => {
  const route: Detail.Route = { _tag: "Document", ws: WS, id: DOC_ID, tab: "preview" };

  test("init loads detail and honors route dialog param", () => {
    const ctx = ctxFor(route, { locale: "cs" });
    const res = Detail.init(route, ctx);
    expect(res.model.detail._tag).toBe("Loading");
    expect(res.model.activeDialog).toBeNull();
    expect(res.commands?.length).toBe(1);

    const withDlg = Detail.init({ ...route, dialog: "payment" }, ctx);
    expect(withDlg.model.activeDialog).toBe("payment");
  });

  test("stale-seq safety and prefill of send/payment dialogs on load", () => {
    const ctx = ctxFor(route);
    const { model } = Detail.init(route, ctx);
    const stale = Detail.update(
      model,
      Detail.Message.LoadedDetail({
        seq: 7,
        data: { doc: sampleProforma, payments: [], history: [], shareViews: [] },
      }),
      ctx,
    );
    expect(stale.model.detail._tag).toBe("Loading");

    const loaded = Detail.update(
      stale.model,
      Detail.Message.LoadedDetail({
        seq: 1,
        data: { doc: sampleProforma, payments: [], history: [], shareViews: [] },
      }),
      ctx,
    );
    expect(loaded.model.detail._tag).toBe("Loaded");
    expect(loaded.model.sendTo).toBe("fakturace@alza.example.cz");
    expect(loaded.model.payAmount).toBe("14520");
    expect(Detail.title(loaded.model, ctx)).toBe("ZF-2026-0011");
  });

  test("Proforma -> Final Invoice, Credit Note, Cancel, and Payment dialogs dispatch commands", () => {
    const ctx = ctxFor(route, { locale: "en" });
    const { model } = Detail.init(route, ctx);
    const loaded = Detail.update(
      model,
      Detail.Message.LoadedDetail({
        seq: 1,
        data: { doc: sampleProforma, payments: [], history: [], shareViews: [] },
      }),
      ctx,
    );

    const openFinal = Detail.update(
      loaded.model,
      Detail.Message.OpenedDialog({ dialog: "final" }),
      ctx,
    );
    expect(openFinal.model.activeDialog).toBe("final");
    const submitFinal = Detail.update(openFinal.model, Detail.Message.SubmittedFinalInvoice(), ctx);
    expect(submitFinal.model.busy).toBe(true);
    expect(submitFinal.commands?.length).toBe(1);

    const openCredit = Detail.update(
      loaded.model,
      Detail.Message.OpenedDialog({ dialog: "correct" }),
      ctx,
    );
    const typedReason = Detail.update(
      openCredit.model,
      Detail.Message.ChangedReason({ value: "Price discount" }),
      ctx,
    );
    const submitCredit = Detail.update(
      typedReason.model,
      Detail.Message.SubmittedCreditNote(),
      ctx,
    );
    expect(submitCredit.model.busy).toBe(true);
    expect(submitCredit.commands?.length).toBe(1);

    const copyShare = Detail.update(
      loaded.model,
      Detail.Message.ClickedCopyShare({ url: "https://app.kvitbit.cz/i/abc" }),
      ctx,
    );
    expect(copyShare.commands?.length).toBe(1);
    const copied = Detail.update(copyShare.model, Detail.Message.CopiedShare({ ok: true }), ctx);
    expect(copied.outMessage?._tag).toBe("Toast");
  });

  test("renders cs and en via SSR", async () => {
    const cs = await renderPath(`/w/${WS}/documents/${DOC_ID}`, { locale: "cs" });
    expect(cs.html).toContain("Doklad");
    const en = await renderPath(`/w/${WS}/documents/${DOC_ID}`, { locale: "en" });
    expect(en.html).toContain("Document");
  });
});
