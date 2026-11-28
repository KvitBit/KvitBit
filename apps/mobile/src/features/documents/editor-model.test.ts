import { describe, expect, test } from "bun:test";
import {
  BankAccountId,
  ContactId,
  ContactSnapshot,
  CurrencyCode,
  DocumentId,
  DocumentSummary,
  type DocumentView,
  type FxRateView,
  IsoDate,
  IssuerSnapshot,
  LineId,
  LineView,
  MoneyMath,
  NumberingSeriesId,
  type NumberingSeriesView,
  PaymentId,
  PaymentView,
  PriceListItemId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { translator } from "@kvitbit/ui-port/i18n";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import { documentActions, documentStatusBadge, settlementBadge } from "./badges";
import {
  addDaysIso,
  type BankAccountOption,
  type ContactOption,
  type PriceListOption,
  parseDecimalInput,
  parseDocumentSummary,
  parsePaymentView,
  type WorkspaceDefaultsView,
} from "./codecs";
import {
  applyContactDefaults,
  applyPriceListItem,
  buildDocumentInput,
  buildDocumentPatch,
  computeLivePreview,
  draftForNew,
  validateEditorDraft,
} from "./editor-model";

const WS_DEFAULTS: WorkspaceDefaultsView = {
  taxRegime: "vat_payer",
  currency: CurrencyCode.make("CZK"),
  language: "cs",
  dueDays: 14,
  paymentMethod: "bank_transfer",
  paymentRounding: "none",
  note: "Děkujeme za spolupráci.",
  preferredSeriesByKind: {
    invoice: NumberingSeriesId.make("01937c7a-0000-7000-8000-000000000101"),
    proforma: NumberingSeriesId.make("01937c7a-0000-7000-8000-000000000102"),
  },
};

const BANK_ACCOUNTS: ReadonlyArray<BankAccountOption> = [
  {
    id: BankAccountId.make("01937c7a-0000-7000-8000-000000000103"),
    name: "CZK hlavní",
    iban: "CZ6508000000192000145399",
    bic: "GIBACZPX",
    currency: CurrencyCode.make("CZK"),
    isDefault: true,
  },
  {
    id: BankAccountId.make("01937c7a-0000-7000-8000-000000000104"),
    name: "EUR účet",
    iban: "CZ6508000000192000145400",
    bic: "GIBACZPX",
    currency: CurrencyCode.make("EUR"),
    isDefault: true,
  },
];

const SERIES: ReadonlyArray<NumberingSeriesView> = [
  {
    id: NumberingSeriesId.make("01937c7a-0000-7000-8000-000000000101"),
    kind: "invoice",
    name: "Faktury",
    pattern: "YYYY-NNNN",
    isDefault: true,
    periodKey: "2026",
    nextCounter: 1,
    nextNumber: "2026-0001",
  },
  {
    id: NumberingSeriesId.make("01937c7a-0000-7000-8000-000000000102"),
    kind: "proforma",
    name: "Zálohy",
    pattern: "ZF-YYYY-NNN",
    isDefault: true,
    periodKey: "2026",
    nextCounter: 1,
    nextNumber: "ZF-2026-001",
  },
];

const CONTACT: ContactOption = {
  id: ContactId.make("01937c7a-0000-7000-8000-000000000105"),
  name: "Acme s.r.o.",
  ico: "12345678",
  dic: "CZ12345678",
  billingEmails: ["billing@acme.cz"],
  archived: false,
  defaults: {
    currency: CurrencyCode.make("EUR"),
    dueDays: 30,
    language: "en",
    paymentMethod: "card",
  },
};

const makeDoc = (overrides: Partial<DocumentView> = {}): DocumentView => ({
  id: DocumentId.make("01937c7a-0000-7000-8000-000000000106"),
  kind: "invoice",
  number: "2026-0001",
  status: "issued",
  locked: false,
  settlement: "unpaid",
  overdue: false,
  revision: 2,
  taxDocument: true,
  contact: ContactSnapshot.make({
    contactId: "01937c7a-0000-7000-8000-000000000105",
    name: "Acme s.r.o.",
    ico: "12345678",
    dic: "CZ12345678",
    legalForm: "s.r.o.",
    address: { street: "Ulice 1", city: "Praha", postalCode: "11000", country: "CZ" },
    billingEmails: ["billing@acme.cz"],
  }),
  issuer: IssuerSnapshot.make({
    workspaceId: WorkspaceId.make("01937c7a-0000-7000-8000-000000000109"),
    name: "Kvitbit s.r.o.",
    ico: "87654321",
    dic: "CZ87654321",
    address: { street: "Hlavní 2", city: "Brno", postalCode: "60200", country: "CZ" },
    registerEntry: null,
    email: "info@kvitbit.cz",
    phone: null,
    web: null,
    regime: "vat_payer",
    bankAccount: {
      id: "01937c7a-0000-7000-8000-000000000103",
      name: "CZK hlavní",
      currency: "CZK",
      accountNumber: null,
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
    },
  }),
  dates: {
    issuedOn: IsoDate.make("2026-11-24"),
    taxableSupplyOn: IsoDate.make("2026-11-24"),
    dueOn: IsoDate.make("2026-12-08"),
  },
  paymentMethod: "bank_transfer",
  lines: [
    LineView.make({
      id: LineId.make("01937c7a-0000-7000-8000-000000000107"),
      item: null,
      description: "Consulting",
      quantity: "2",
      unit: "h",
      unitPrice: "1000",
      treatment: "standard",
      ratePercent: "21",
      amount: "2000",
      deducts: null,
    }),
  ],
  totals: {
    buckets: [],
    net: MoneyMath.make(BigDecimal.fromBigInt(2000n), CurrencyCode.make("CZK")),
    vat: MoneyMath.make(BigDecimal.fromBigInt(420n), CurrencyCode.make("CZK")),
    roundingAdjustment: MoneyMath.zero(CurrencyCode.make("CZK")),
    gross: MoneyMath.make(BigDecimal.fromBigInt(2420n), CurrencyCode.make("CZK")),
    vatCzk: null,
  },
  fx: null,
  statutoryNotes: [],
  paymentQr: null,
  related: [],
  share: null,
  deliveries: [],
  ...overrides,
});

describe("documents codecs & badges", () => {
  test("parseDecimalInput handles dot, comma, spaces and rejects invalid input", () => {
    const a = parseDecimalInput("1 234,50");
    const b = parseDecimalInput("42.25");
    expect(a?.pipe(BigDecimal.format)).toBe("1234.5");
    expect(b?.pipe(BigDecimal.format)).toBe("42.25");
    expect(parseDecimalInput("")).toBeNull();
    expect(parseDecimalInput("abc")).toBeNull();
  });

  test("addDaysIso advances calendar dates across month boundaries", () => {
    expect(String(addDaysIso("2026-11-24", 14))).toBe("2026-12-08");
  });

  test("parseDocumentSummary and parsePaymentView decode opaque wire shapes", () => {
    const summary = parseDocumentSummary(
      DocumentSummary.make({
        id: "01937c7a-0000-7000-8000-000000000001",
        kind: "proforma",
        number: "ZF-2026-001",
        status: "issued",
        locked: false,
        settlement: "partially_paid",
        overdue: true,
        revision: 3,
        contact: { id: "01937c7a-0000-7000-8000-000000000002", name: "Acme s.r.o." },
        issuedOn: "2026-11-01",
        dueOn: "2026-11-15",
        total: { amount: "12100.00", currency: "CZK" },
      }),
    );
    expect(summary.number).toBe("ZF-2026-001");
    expect(summary.contact.name).toBe("Acme s.r.o.");
    expect(summary.total.amount.pipe(BigDecimal.format)).toBe("12100");

    const payment = parsePaymentView(
      PaymentView.make({
        id: PaymentId.make("01937c7a-0000-7000-8000-000000000003"),
        revision: 1,
        amount: { amount: "5000", currency: "CZK" },
        paidOn: "2026-11-10",
        method: "bank_transfer",
        note: "Deposit",
        taxDocument: "01937c7a-0000-7000-8000-000000000004",
        createdAt: "2026-11-10T10:00:00Z",
      }),
    );
    expect(String(payment.taxDocument)).toBe("01937c7a-0000-7000-8000-000000000004");
    expect(payment.amount.amount.pipe(BigDecimal.format)).toBe("5000");
  });

  test("badges map status, settlement and overdue accurately", () => {
    const { t } = translator("en");
    expect(documentStatusBadge("draft", t)).toEqual({ label: "Draft", tone: "draft" });
    expect(settlementBadge("unpaid", true, t)).toEqual({ label: "Overdue", tone: "warning" });
    expect(settlementBadge("paid", true, t)).toEqual({ label: "Paid", tone: "success" });
  });

  test("documentActions gates lifecycle transitions by status, kind, lock and role", () => {
    const draft = makeDoc({ status: "draft", number: null });
    expect(documentActions(draft, "member")).toMatchObject({
      canEdit: true,
      canIssue: true,
      canDiscard: true,
      canRecordPayment: false,
      canSendEmail: false,
    });
    expect(documentActions(draft, "accountant")).toMatchObject({
      canEdit: false,
      canIssue: false,
      canDiscard: false,
      canDownloadPdf: true,
    });

    const locked = makeDoc({ locked: true });
    expect(documentActions(locked, "member")).toMatchObject({
      canEdit: false,
      canUnlock: false,
      canCreateCreditNote: true,
    });
    expect(documentActions(locked, "admin").canUnlock).toBe(true);

    const paidProforma = makeDoc({ kind: "proforma", settlement: "paid" });
    expect(documentActions(paidProforma, "member")).toMatchObject({
      canIssueFinalInvoice: true,
      canCreateCreditNote: false,
      canRecordPayment: true,
    });

    const unpaidProforma = makeDoc({ kind: "proforma", settlement: "unpaid" });
    expect(documentActions(unpaidProforma, "member").canIssueFinalInvoice).toBe(false);

    const ptd = makeDoc({ kind: "payment_tax_document" });
    expect(documentActions(ptd, "member")).toMatchObject({
      canRecordPayment: false,
      canCreateCreditNote: true,
    });
  });
});

describe("document editor model", () => {
  test("draftForNew and applyContactDefaults resolve contact -> workspace defaults", () => {
    const base = draftForNew({
      kind: "invoice",
      workspaceDefaults: WS_DEFAULTS,
      bankAccounts: BANK_ACCOUNTS,
      seriesList: SERIES,
      today: IsoDate.make("2026-11-24"),
    });
    expect(base.currency).toBe(CurrencyCode.make("CZK"));
    expect(base.dueOn).toBe("2026-12-08");
    expect(base.bankAccountId).toBe(BankAccountId.make("01937c7a-0000-7000-8000-000000000103"));
    expect(base.seriesId).toBe(NumberingSeriesId.make("01937c7a-0000-7000-8000-000000000101"));

    const withContact = applyContactDefaults(base, CONTACT, WS_DEFAULTS, BANK_ACCOUNTS, SERIES);
    expect(withContact.contactId).toBe(ContactId.make("01937c7a-0000-7000-8000-000000000105"));
    expect(withContact.currency).toBe(CurrencyCode.make("EUR"));
    expect(withContact.dueOn).toBe("2026-12-24");
    expect(withContact.bankAccountId).toBe(
      BankAccountId.make("01937c7a-0000-7000-8000-000000000104"),
    );
    expect(withContact.paymentMethod).toBe("card");
  });

  test("applyPriceListItem copies fields and flags currency mismatch", () => {
    const base = draftForNew({
      kind: "invoice",
      workspaceDefaults: WS_DEFAULTS,
      bankAccounts: BANK_ACCOUNTS,
      seriesList: SERIES,
      today: IsoDate.make("2026-11-24"),
    });
    const item: PriceListOption = {
      id: PriceListItemId.make("01937c7a-0000-7000-8000-000000000108"),
      name: "Retainer",
      description: "Monthly",
      unit: "month",
      unitPrice: BigDecimal.fromBigInt(500n),
      currency: CurrencyCode.make("EUR"),
      vat: "standard",
      archived: false,
    };
    const firstLine = base.lines[0];
    if (firstLine === undefined) throw new Error("expected initial line");
    const { draft, currencyMismatch } = applyPriceListItem(base, firstLine.key, item, "vat_payer");
    expect(currencyMismatch).toBe(CurrencyCode.make("EUR"));
    expect(draft.lines[0]?.description).toBe("Retainer — Monthly");
    expect(draft.lines[0]?.unitPrice).toBe("500");
    expect(draft.lines[0]?.unit).toBe("month");
  });

  test("computeLivePreview calculates VAT buckets and EUR->CZK conversion", () => {
    const base = draftForNew({
      kind: "invoice",
      workspaceDefaults: WS_DEFAULTS,
      contact: CONTACT,
      bankAccounts: BANK_ACCOUNTS,
      seriesList: SERIES,
      today: IsoDate.make("2026-11-24"),
    });
    const firstLine = base.lines[0];
    if (firstLine === undefined) throw new Error("expected initial line");
    const draft = {
      ...base,
      lines: [
        {
          ...firstLine,
          description: "Dev",
          quantity: "10",
          unitPrice: "100",
          treatment: "standard" as const,
        },
      ],
    };
    const cnbFx: FxRateView = {
      currency: CurrencyCode.make("EUR"),
      rate: Option.getOrThrow(BigDecimal.fromString("25.20")),
      quantity: 1,
      fixingDate: IsoDate.make("2026-11-24"),
      source: "cnb",
    };
    const preview = computeLivePreview(draft, "vat_payer", "none", cnbFx);
    expect(preview?.breakdown.net.amount.pipe(BigDecimal.format)).toBe("1000");
    expect(preview?.breakdown.vat.amount.pipe(BigDecimal.format)).toBe("210");
    expect(preview?.breakdown.gross.amount.pipe(BigDecimal.format)).toBe("1210");
    expect(preview?.breakdown.vatCzk?.amount.pipe(BigDecimal.format)).toBe("5292");
  });

  test("validateEditorDraft catches missing contact, bad dates and empty lines", () => {
    const base = draftForNew({
      kind: "invoice",
      workspaceDefaults: WS_DEFAULTS,
      bankAccounts: BANK_ACCOUNTS,
      seriesList: SERIES,
      today: IsoDate.make("2026-11-24"),
    });
    const firstLine = base.lines[0];
    if (firstLine === undefined) throw new Error("expected initial line");
    const bad = { ...base, dueOn: "2026-11-01" };
    const res = validateEditorDraft(bad, {
      contactRequired: "contact",
      invalidDate: "date",
      dueBeforeIssue: "due",
      invalidLine: "line",
      invalidFx: "fx",
    });
    expect(res.hasErrors).toBe(true);
    expect(res.contact).toBe("contact");
    expect(res.dueOn).toBe("due");
    expect(res.lines[firstLine.key]).toBe("line");
  });

  test("buildDocumentInput and buildDocumentPatch emit contract-valid payloads", () => {
    const base = draftForNew({
      kind: "invoice",
      workspaceDefaults: WS_DEFAULTS,
      contact: CONTACT,
      bankAccounts: BANK_ACCOUNTS,
      seriesList: SERIES,
      today: IsoDate.make("2026-11-24"),
    });
    const firstLine = base.lines[0];
    if (firstLine === undefined) throw new Error("expected initial line");
    const filled = {
      ...base,
      fxMode: "manual" as const,
      manualFxRate: "25.5",
      manualFxQuantity: "1",
      overrideNumber: "2026-9999",
      refreshParties: true,
      lines: [{ ...firstLine, description: "Work", quantity: "2", unit: "h", unitPrice: "500" }],
    };
    const input = buildDocumentInput(filled);
    expect(input.kind).toBe("invoice");
    expect(input.contact).toBe(ContactId.make("01937c7a-0000-7000-8000-000000000105"));
    expect(input.lines.length).toBe(1);
    expect(input.fx?.manual.quantity).toBe(1);

    const patch = buildDocumentPatch(filled, base, makeDoc(), "admin");
    expect(patch.number).toBe("2026-9999");
    expect(patch.refreshParties).toBe(true);
    expect(patch).not.toHaveProperty("language");
    expect(patch).not.toHaveProperty("pricesIncludeVat");
    const memberPatch = buildDocumentPatch(filled, base, makeDoc(), "member");
    expect(memberPatch.number).toBeUndefined();

    const unverified = { ...base, language: null, pricesIncludeVat: null };
    const explicit = { ...unverified, language: "cs" as const, pricesIncludeVat: false };
    expect(buildDocumentPatch(explicit, unverified, makeDoc(), "member")).toEqual({
      language: "cs",
      pricesIncludeVat: false,
    });
  });
});
