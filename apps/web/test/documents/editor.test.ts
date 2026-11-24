import { describe, expect, test } from "bun:test";
import { ViewModels } from "@kvitbit/ui-port";
import { BigDecimal, Result, Schema } from "effect";
import * as Editor from "../../src/page/documents/editor";
import { ContactOptionData } from "../../src/page/documents/shared";
import { ctxFor, renderPath, WS } from "../support";

const sampleContact = Schema.decodeUnknownSync(ContactOptionData)({
  id: "0193a000-0000-7000-8000-000000000201",
  roles: ["customer"],
  name: "Alza.cz a.s.",
  ico: "27082440",
  dic: "CZ27082440",
  legalForm: "a.s.",
  address: { street: "Jankovcova 53", city: "Praha 7", postalCode: "170 00", country: "CZ" },
  billingEmails: ["fakturace@alza.example.cz"],
  phone: null,
  note: null,
  defaults: { dueDays: 21, currency: "EUR", language: "en", paymentMethod: "bank_transfer" },
  archived: false,
  revision: 1,
});

describe("DocumentEditor page (Screen 10)", () => {
  const newInvoiceRoute: Editor.Route = { _tag: "DocumentNew", ws: WS, kind: "invoice" };

  test("init loads lookups and starts with one line", () => {
    const ctxCs = ctxFor(newInvoiceRoute, { locale: "cs" });
    const ctxEn = ctxFor(newInvoiceRoute, { locale: "en" });
    const res = Editor.init(newInvoiceRoute, ctxCs);
    expect(res.model.lookups._tag).toBe("Loading");
    expect(res.model.lines.length).toBe(1);
    expect(Editor.title(res.model, ctxCs)).toBe("Nová faktura");
    expect(Editor.title(res.model, ctxEn)).toBe("New invoice");
  });

  test("line items add, update, move, and remove cleanly", () => {
    const ctx = ctxFor(newInvoiceRoute);
    const { model } = Editor.init(newInvoiceRoute, ctx);
    const s1 = Editor.update(
      model,
      Editor.Message.UpdatedLineField({ key: "l1", field: "description", value: "First" }),
      ctx,
    );
    const s2 = Editor.update(s1.model, Editor.Message.AddedLine(), ctx);
    expect(s2.model.lines.length).toBe(2);
    const s3 = Editor.update(
      s2.model,
      Editor.Message.UpdatedLineField({ key: "l2", field: "description", value: "Second" }),
      ctx,
    );
    const moved = Editor.update(
      s3.model,
      Editor.Message.MovedLine({ key: "l2", direction: "up" }),
      ctx,
    );
    expect(moved.model.lines[0]?.description).toBe("Second");
    expect(moved.model.lines[1]?.description).toBe("First");

    const removed = Editor.update(moved.model, Editor.Message.RemovedLine({ key: "l2" }), ctx);
    expect(removed.model.lines.length).toBe(1);
    expect(removed.model.lines[0]?.key).toBe("l1");
  });

  test("ARES quick-add selects returned contact and stale lookup seq is dropped", () => {
    const ctx = ctxFor(newInvoiceRoute);
    const { model } = Editor.init(newInvoiceRoute, ctx);
    const stale = Editor.update(
      model,
      Editor.Message.LoadedLookups({
        seq: 999,
        data: {
          workspace: null,
          contacts: [sampleContact],
          priceList: [],
          series: [],
          bankAccounts: [],
          templates: [],
          existingDoc: null,
        },
      }),
      ctx,
    );
    expect(stale.model.lookups._tag).toBe("Loading");

    const loaded = Editor.update(
      stale.model,
      Editor.Message.LoadedLookups({
        seq: 1,
        data: {
          workspace: null,
          contacts: [],
          priceList: [],
          series: [],
          bankAccounts: [],
          templates: [],
          existingDoc: null,
        },
      }),
      ctx,
    );
    const toggled = Editor.update(loaded.model, Editor.Message.ToggledAres(), ctx);
    expect(toggled.model.aresOpen).toBe(true);
    const added = Editor.update(
      toggled.model,
      Editor.Message.AresSucceeded({ contact: sampleContact }),
      ctx,
    );
    expect(added.model.contactId).toBe(sampleContact.id);
    expect(added.model.aresOpen).toBe(false);
    expect(added.outMessage?._tag).toBe("Toast");
  });

  test("validation rejects missing contact before submitting", () => {
    const ctx = ctxFor(newInvoiceRoute, { locale: "en" });
    const { model } = Editor.init(newInvoiceRoute, ctx);
    const res = Editor.update(model, Editor.Message.ClickedSaveDraft(), ctx);
    expect(res.model.submitError).toContain("customer");
    expect(res.commands).toBeUndefined();
  });

  test("VAT/FX calculation engine matches standard 21% and EUR->CZK conversion", () => {
    const calc = ViewModels.calculate({
      lines: [
        {
          quantity: BigDecimal.fromBigInt(2n),
          unitPrice: BigDecimal.fromBigInt(1000n),
          treatment: "standard",
        },
      ],
      currency: "EUR" as never,
      taxPoint: "2026-11-24" as never,
      pricesIncludeVat: false,
      fx: { rate: BigDecimal.fromBigInt(25n), quantity: 1 },
      paymentRounding: "none",
      direction: "outgoing",
      taxRegime: "vat_payer",
      kind: "invoice",
    });
    expect(Result.isSuccess(calc)).toBe(true);
    if (Result.isSuccess(calc)) {
      expect(BigDecimal.format(calc.success.breakdown.net.amount)).toBe("2000");
      expect(BigDecimal.format(calc.success.breakdown.vat.amount)).toBe("420");
      expect(BigDecimal.format(calc.success.breakdown.gross.amount)).toBe("2420");
      expect(calc.success.breakdown.vatCzk).not.toBeNull();
      if (calc.success.breakdown.vatCzk !== null) {
        expect(BigDecimal.format(calc.success.breakdown.vatCzk.amount)).toBe("10500");
      }
    }
  });

  test("renders cs and en via SSR with plain copy (no Live or Živá qualifiers)", async () => {
    const cs = await renderPath(`/w/${WS}/documents/new/invoice`, { locale: "cs" });
    expect(cs.html).toContain("Náhled faktury");
    expect(cs.html).toContain("Rekapitulace DPH");
    expect(cs.html).not.toContain("Živá");
    const en = await renderPath(`/w/${WS}/documents/new/invoice`, { locale: "en" });
    expect(en.html).toContain("Invoice preview");
    expect(en.html).toContain("VAT summary");
    expect(en.html).not.toContain("Live ");
  });
});
