import { describe, expect, test } from "bun:test";
import { BigDecimal, Exit, Schema } from "effect";
import {
  AuditEntry,
  ContactView,
  DocumentQuery,
  DocumentSummary,
  type Documents,
  DocumentView,
  type ExpenseInput,
  ExpenseQuery,
  ExpenseView,
  Page,
  PriceListItemView,
  SharedDocumentView,
  TemplateInput,
  TemplateView,
  type WorkspaceView,
} from "../src/index";

const id = (n: number) => `0192f0c4-1b2c-7d3e-8f40-${String(n).padStart(12, "0")}`;
const czk = (amount: string) => ({ amount, currency: "CZK" });

const documentJson = {
  id: id(1),
  kind: "invoice",
  number: "2026-0001",
  status: "issued",
  locked: false,
  settlement: "unpaid",
  overdue: false,
  revision: 3,
  taxDocument: true,
  contact: { name: "Buyer s.r.o.", ico: "12345678" },
  issuer: { name: "Seller", registerEntry: null },
  dates: { issuedOn: "2026-11-23", taxableSupplyOn: "2026-11-23", dueOn: "2026-12-07" },
  paymentMethod: "bank_transfer",
  lines: [{ description: "Work", ratePercent: "21" }],
  totals: {
    buckets: [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "1000",
        vat: "210",
        gross: "1210",
        vatCzk: null,
      },
    ],
    net: czk("1000"),
    vat: czk("210"),
    roundingAdjustment: czk("0"),
    gross: czk("1210"),
    vatCzk: null,
  },
  fx: null,
  statutoryNotes: [{ code: "tax_document", text: "Faktura – daňový doklad" }],
  paymentQr: { format: "spayd", payload: "SPD*1.0*ACC:CZ..." },
  related: [],
  share: null,
  deliveries: [
    {
      id: id(2),
      to: ["buyer@example.cz"],
      purpose: "document",
      status: "sent",
      at: "2026-11-23T10:00:00Z",
    },
  ],
};

describe("DocumentView runtime schema", () => {
  const json = Schema.toCodecJson(DocumentView);
  test("decodes and re-encodes a full view", () => {
    const view = Schema.decodeUnknownSync(json)(documentJson);
    expect(BigDecimal.format(view.totals.gross.amount)).toBe("1210");
    expect(String(view.dates.dueOn)).toBe(documentJson.dates.dueOn);
    expect(Schema.encodeSync(json)(view)).toEqual(documentJson);
  });
  test("rejects an unknown status and a malformed id", () => {
    expect(
      Exit.isFailure(Schema.decodeUnknownExit(json)({ ...documentJson, status: "paid" })),
    ).toBe(true);
    expect(Exit.isFailure(Schema.decodeUnknownExit(json)({ ...documentJson, id: "x" }))).toBe(true);
  });
  test("list query fields spread into a query struct; summaries page", () => {
    const query = Schema.Struct({
      ...DocumentQuery.fields,
      cursor: Schema.optional(Schema.String),
    });
    expect(
      Schema.decodeUnknownSync(query)({ kind: "proforma", overdue: true, from: "2026-01-01" }),
    ).toEqual({
      kind: "proforma",
      overdue: true,
      from: "2026-01-01",
    } as never);
    const page = Schema.decodeUnknownSync(Page(DocumentSummary))({
      items: [{ any: "row" }],
      nextCursor: null,
    });
    expect(page.items).toHaveLength(1);
  });
});

describe("partly specified types expose their specified fields", () => {
  test("ContactView.defaults is readable and other fields survive decoding", () => {
    const view = Schema.decodeUnknownSync(ContactView)({
      name: "Buyer",
      defaults: { dueDays: 30 },
      revision: 2,
    });
    expect(view.defaults.dueDays).toBe(30);
    expect(view.name).toBe("Buyer");
    const etag: number = view.revision;
    expect(etag).toBe(2);
    expect(Exit.isFailure(Schema.decodeUnknownExit(ContactView)({ defaults: {} }))).toBe(true);
  });
  test("an incomplete Expense can be recorded and listed", () => {
    const input: ExpenseInput = { status: "incomplete" };
    expect(input.status).toBe("incomplete");
    expect(Schema.decodeUnknownSync(ExpenseQuery)({ incomplete: true, limit: 20 }).incomplete).toBe(
      true,
    );
    expect(Exit.isFailure(Schema.decodeUnknownExit(ExpenseQuery)({ limit: 0 }))).toBe(true);
  });
  test("revisioned views type their revision as a number", () => {
    const expense = Schema.decodeUnknownSync(ExpenseView)({ status: "complete", revision: 5 });
    const item = Schema.decodeUnknownSync(PriceListItemView)({ name: "Hosting", revision: 1 });
    const revisions: ReadonlyArray<number> = [expense.revision, item.revision];
    expect(revisions).toEqual([5, 1]);
  });
  test("TemplateView exposes the schedule pause reason", () => {
    const view = Schema.decodeUnknownSync(TemplateView)({
      name: "Monthly",
      revision: 3,
      schedule: { startOn: "2026-01-31", pausedReason: "schedule.missed_occurrences" },
    });
    expect(view.schedule?.pausedReason).toBe("schedule.missed_occurrences");
    expect(
      Schema.decodeUnknownSync(TemplateView)({ revision: 1, schedule: null }).schedule,
    ).toBeNull();
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(TemplateView)({ revision: 1, schedule: { pausedReason: "oops" } }),
      ),
    ).toBe(true);
  });
  test("WorkspaceView requires slug, branding and revision", () => {
    // @ts-expect-error slug, branding and revision are specified and required
    const partial: WorkspaceView = { name: "Firm" };
    expect(partial).toBeDefined();
  });
  test("TemplateInput is DocumentInput without dates plus name and relative due", () => {
    const ok = Schema.decodeUnknownSync(TemplateInput)({
      kind: "invoice",
      contact: id(3),
      lines: [{ description: "Hosting" }],
      name: "Monthly hosting",
      due: { inDays: 14 },
    });
    expect(ok.name).toBe("Monthly hosting");
    expect(
      Exit.isFailure(Schema.decodeUnknownExit(TemplateInput)({ ...ok, due: { on: "2026-12-01" } })),
    ).toBe(true);
    expect("issuedOn" in TemplateInput.fields).toBe(false);
  });
});

describe("SharedDocumentView is a closed recipient projection", () => {
  const json = Schema.toCodecJson(SharedDocumentView);
  const branding = {
    pdfTemplate: "classic",
    accentColor: "#1D4ED8",
    footerText: null,
    theme: null,
    logo: null,
    stamp: null,
  };
  const shared = {
    kind: documentJson.kind,
    number: documentJson.number,
    status: documentJson.status,
    settlement: documentJson.settlement,
    taxDocument: documentJson.taxDocument,
    dates: documentJson.dates,
    issuer: documentJson.issuer,
    branding,
    contact: documentJson.contact,
    lines: documentJson.lines,
    totals: documentJson.totals,
    statutoryNotes: documentJson.statutoryNotes,
    paymentQr: documentJson.paymentQr,
    pdfUrl: "https://kvitbit.example/s/v1.abc/pdf",
    viewerIsIssuer: false,
  };
  test("encoding drops private fields", () => {
    const view = Schema.decodeUnknownSync(json)({
      ...shared,
      deliveries: documentJson.deliveries,
      internalNote: "chase hard",
    });
    expect(view.paymentQr?.payload).toBe(documentJson.paymentQr.payload);
    const encoded = Schema.encodeSync(json)({
      ...view,
      deliveries: [{ to: ["buyer@example.cz"] }],
      internalNote: "chase hard",
    } as typeof view);
    expect(encoded).toEqual(shared);
    expect(encoded).not.toHaveProperty("deliveries");
    expect(encoded).not.toHaveProperty("internalNote");
  });
});

describe("Documents.list takes filter and paging", () => {
  test("cursor and limit are part of the port input", () => {
    type ListInput = Parameters<Documents["Service"]["list"]>[0];
    const next: ListInput = { kind: "invoice", cursor: "c2", limit: 20 };
    expect(next.cursor).toBe("c2");
    expect(next.limit).toBe(20);
  });
});

describe("AuditEntry runtime schema", () => {
  test("round-trips a System actor", () => {
    const entry = {
      id: id(4),
      at: "2026-11-23T10:00:00Z",
      actor: { _tag: "System", job: { _tag: "PaymentReminders", documentId: id(1) } },
      subject: { entity: "Document", id: id(1) },
      action: "document.send",
      revision: 4,
      changes: [{ path: "dueOn", before: "2026-12-01", after: "2026-12-07" }],
      reason: null,
    };
    const json = Schema.toCodecJson(AuditEntry);
    expect(Schema.encodeSync(json)(Schema.decodeUnknownSync(json)(entry))).toEqual(entry);
  });
});
