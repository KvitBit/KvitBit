/**
 * Demo API handlers for the `documents` page group (screens 08-12).
 * Stateful in-memory fixtures so dashboard, list, editor, detail dialogs, payments, share links,
 * and templates/recurring work end-to-end in demo mode without apps/server.
 */
import {
  FromIcoInput,
  IssueFromInputPayload,
  RecordPaymentInput,
  ScheduleInput,
  SendInput,
} from "@kvitbit/api-contract";
import { DocumentInput, DocumentPatch, type DocumentView, TemplateInput } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type {
  ContactOptionData,
  ContactSnapshotData,
  PaymentViewData,
  TemplateViewData,
} from "../page/documents/shared";
import type { DemoRoute } from "./router";
import { status } from "./router";
import { DEMO_WORKSPACE, demoId } from "./shell";

const WS_ID = DEMO_WORKSPACE.id;

const CONTACT_1_ID = demoId(201);
const CONTACT_2_ID = demoId(202);
const ITEM_1_ID = demoId(301);
const ITEM_2_ID = demoId(302);
const SERIES_INV_ID = demoId(401);
const SERIES_PRO_ID = demoId(402);
const BANK_CZK_ID = demoId(501);
const BANK_EUR_ID = demoId(502);
const DOC_1_ID = demoId(601);
const DOC_2_ID = demoId(602);
const DOC_3_ID = demoId(603);
const DOC_4_ID = demoId(604);
const PAY_1_ID = demoId(701);
const TPL_1_ID = demoId(801);
const TPL_2_ID = demoId(802);
const SCHED_1_ID = demoId(811);
const SCHED_2_ID = demoId(812);

let nextSeq = 900;
const nextId = (): string => demoId(++nextSeq);

// The JSON codec represents BigDecimal values as strings in the demo store.
type DemoWire<T> = T extends BigDecimal.BigDecimal
  ? string
  : T extends object
    ? { -readonly [Key in keyof T]: DemoWire<T[Key]> }
    : T;

type DemoContact = Omit<typeof ContactOptionData.Encoded, "defaults"> & {
  defaults: Partial<(typeof ContactOptionData.Encoded)["defaults"]>;
};
type DemoDocument = DemoWire<typeof DocumentView.Encoded> & {
  contact: typeof ContactSnapshotData.Encoded;
};
type DemoPayment = Omit<DemoWire<typeof PaymentViewData.Encoded>, "target"> & {
  target: { document: string | undefined };
};
type DemoTemplate = Omit<DemoWire<typeof TemplateViewData.Encoded>, "input"> & {
  input: Schema.Json;
};

const decodeFromIco = Schema.decodeUnknownOption(FromIcoInput);
const decodeDocumentInput = Schema.decodeUnknownOption(Schema.toCodecJson(DocumentInput));
const decodeIssueInput = Schema.decodeUnknownOption(Schema.toCodecJson(IssueFromInputPayload));
const decodeDocumentPatch = Schema.decodeUnknownOption(Schema.toCodecJson(DocumentPatch));
const decodeDelivery = Schema.decodeUnknownOption(SendInput);
const decodePayment = Schema.decodeUnknownOption(Schema.toCodecJson(RecordPaymentInput));
const templateCodec = Schema.toCodecJson(TemplateInput);
const decodeTemplate = Schema.decodeUnknownOption(templateCodec);
const encodeTemplate = Schema.encodeOption(templateCodec);
const decodeSchedule = Schema.decodeUnknownOption(ScheduleInput);

const contacts: [DemoContact, DemoContact, ...Array<DemoContact>] = [
  {
    id: CONTACT_1_ID,
    roles: ["customer"],
    name: "Alza.cz a.s.",
    ico: "27082440",
    dic: "CZ27082440",
    legalForm: "Akciová společnost",
    address: { street: "Jankovcova 1522/53", city: "Praha 7", postalCode: "170 00", country: "CZ" },
    billingEmails: ["fakturace@alza.example.cz"],
    phone: "+420 225 340 111",
    note: null,
    defaults: { dueDays: 14, currency: "CZK", language: "cs", paymentMethod: "bank_transfer" },
    archived: false,
    revision: 1,
  },
  {
    id: CONTACT_2_ID,
    roles: ["customer"],
    name: "Nordic Studio GmbH",
    ico: null,
    dic: "DE298765432",
    legalForm: "GmbH",
    address: { street: "Torstraße 94", city: "Berlin", postalCode: "10119", country: "DE" },
    billingEmails: ["ap@nordicstudio.example.de"],
    phone: null,
    note: null,
    defaults: { dueDays: 30, currency: "EUR", language: "en", paymentMethod: "bank_transfer" },
    archived: false,
    revision: 1,
  },
];

const priceList = [
  {
    id: ITEM_1_ID,
    name: "UX & produktový design",
    description: "Hodinová sazba senior designéra",
    unit: "hod",
    unitPrice: "1800",
    currency: "CZK",
    vat: "standard",
    archived: false,
    revision: 1,
  },
  {
    id: ITEM_2_ID,
    name: "Měsíční podpora webu",
    description: "Paušální správa a údržba",
    unit: "měs",
    unitPrice: "12000",
    currency: "CZK",
    vat: "standard",
    archived: false,
    revision: 1,
  },
];

const numberingSeries = [
  {
    id: SERIES_INV_ID,
    kind: "invoice",
    name: "Faktury",
    pattern: "YYYY-NNNN",
    isDefault: true,
    periodKey: "2026",
    nextCounter: 43,
    nextNumber: "2026-0043",
  },
  {
    id: SERIES_PRO_ID,
    kind: "proforma",
    name: "Zálohy",
    pattern: "ZF-YYYY-NNNN",
    isDefault: true,
    periodKey: "2026",
    nextCounter: 12,
    nextNumber: "ZF-2026-0012",
  },
];

const bankAccounts = [
  {
    id: BANK_CZK_ID,
    name: "Fio CZK",
    currency: "CZK",
    accountNumber: "2401234567/2010",
    iban: "CZ6520100000002401234567",
    bic: "FIOBCZPPXXX",
    isDefault: true,
  },
  {
    id: BANK_EUR_ID,
    name: "Fio EUR",
    currency: "EUR",
    accountNumber: null,
    iban: Arr.join(["CZ12", "2010", "0000", "0029", "0987", "6543"], ""),
    bic: "FIOBCZPPXXX",
    isDefault: true,
  },
];

const ISSUER_SNAPSHOT = {
  workspaceId: WS_ID,
  name: "Novák Design s.r.o.",
  ico: "14285714",
  dic: "CZ14285714",
  address: { street: "Křižíkova 148/34", city: "Praha 8", postalCode: "186 00", country: "CZ" },
  registerEntry: "Spisová značka C 351029 vedená u Městského soudu v Praze.",
  email: "fakturace@novakdesign.example.cz",
  phone: "+420 602 111 222",
  web: "https://novakdesign.example.cz",
  regime: "vat_payer",
  bankAccount: bankAccounts[0],
};

const toContactSnapshot = (c: DemoContact) => ({
  contactId: c.id,
  name: c.name,
  ico: c.ico,
  dic: c.dic,
  legalForm: c.legalForm,
  address: c.address,
  billingEmails: c.billingEmails,
});

const documentFixtures: [DemoDocument, ...Array<DemoDocument>] = [
  {
    id: DOC_1_ID,
    kind: "invoice",
    number: "2026-0041",
    status: "issued",
    locked: false,
    settlement: "unpaid",
    overdue: true,
    revision: 2,
    taxDocument: true,
    contact: toContactSnapshot(contacts[0]),
    issuer: ISSUER_SNAPSHOT,
    dates: { issuedOn: "2026-10-15", taxableSupplyOn: "2026-10-15", dueOn: "2026-10-29" },
    paymentMethod: "bank_transfer",
    lines: [
      {
        id: demoId(651),
        item: ITEM_1_ID,
        description: "UX & produktový design — říjen",
        quantity: "40",
        unit: "hod",
        unitPrice: "1800",
        treatment: "standard",
        ratePercent: "21",
        amount: "72000",
        deducts: null,
      },
    ],
    totals: {
      buckets: [
        {
          treatment: "standard",
          ratePercent: "21",
          base: "72000",
          vat: "15120",
          gross: "87120",
          vatCzk: null,
        },
      ],
      net: { amount: "72000", currency: "CZK" },
      vat: { amount: "15120", currency: "CZK" },
      roundingAdjustment: { amount: "0", currency: "CZK" },
      gross: { amount: "87120", currency: "CZK" },
      vatCzk: null,
    },
    fx: null,
    statutoryNotes: [
      { code: "register", text: "Spisová značka C 351029 vedená u Městského soudu v Praze." },
    ],
    paymentQr: null,
    related: [],
    share: {
      url: "https://app.kvitbit.cz/i/demo-share-token-0041",
      views: 3,
      lastViewedAt: "2026-11-20T10:15:00Z",
    },
    deliveries: [
      {
        id: demoId(671),
        to: ["fakturace@alza.example.cz"],
        purpose: "document",
        status: "sent",
        at: "2026-10-15T09:05:00Z",
      },
    ],
  },
  {
    id: DOC_2_ID,
    kind: "proforma",
    number: "ZF-2026-0011",
    status: "issued",
    locked: false,
    settlement: "paid",
    overdue: false,
    revision: 3,
    taxDocument: false,
    contact: toContactSnapshot(contacts[0]),
    issuer: ISSUER_SNAPSHOT,
    dates: { issuedOn: "2026-11-01", taxableSupplyOn: null, dueOn: "2026-11-15" },
    paymentMethod: "bank_transfer",
    lines: [
      {
        id: demoId(652),
        item: ITEM_2_ID,
        description: "Měsíční podpora webu — listopad",
        quantity: "1",
        unit: "měs",
        unitPrice: "12000",
        treatment: "standard",
        ratePercent: "21",
        amount: "12000",
        deducts: null,
      },
    ],
    totals: {
      buckets: [
        {
          treatment: "standard",
          ratePercent: "21",
          base: "12000",
          vat: "2520",
          gross: "14520",
          vatCzk: null,
        },
      ],
      net: { amount: "12000", currency: "CZK" },
      vat: { amount: "2520", currency: "CZK" },
      roundingAdjustment: { amount: "0", currency: "CZK" },
      gross: { amount: "14520", currency: "CZK" },
      vatCzk: null,
    },
    fx: null,
    statutoryNotes: [],
    paymentQr: null,
    related: [
      {
        relation: "tax_document_for",
        id: DOC_3_ID,
        kind: "payment_tax_document",
        number: "DD-2026-0004",
      },
    ],
    share: null,
    deliveries: [],
  },
  {
    id: DOC_3_ID,
    kind: "payment_tax_document",
    number: "DD-2026-0004",
    status: "issued",
    locked: true,
    settlement: "paid",
    overdue: false,
    revision: 1,
    taxDocument: true,
    contact: toContactSnapshot(contacts[0]),
    issuer: ISSUER_SNAPSHOT,
    dates: { issuedOn: "2026-11-05", taxableSupplyOn: "2026-11-05", dueOn: "2026-11-05" },
    paymentMethod: "bank_transfer",
    lines: [
      {
        id: demoId(653),
        item: null,
        description: "Přijatá platba k záloze ZF-2026-0011",
        quantity: "1",
        unit: "ks",
        unitPrice: "12000",
        treatment: "standard",
        ratePercent: "21",
        amount: "12000",
        deducts: null,
      },
    ],
    totals: {
      buckets: [
        {
          treatment: "standard",
          ratePercent: "21",
          base: "12000",
          vat: "2520",
          gross: "14520",
          vatCzk: null,
        },
      ],
      net: { amount: "12000", currency: "CZK" },
      vat: { amount: "2520", currency: "CZK" },
      roundingAdjustment: { amount: "0", currency: "CZK" },
      gross: { amount: "14520", currency: "CZK" },
      vatCzk: null,
    },
    fx: null,
    statutoryNotes: [],
    paymentQr: null,
    related: [{ relation: "advance_of", id: DOC_2_ID, kind: "proforma", number: "ZF-2026-0011" }],
    share: null,
    deliveries: [],
  },
  {
    id: DOC_4_ID,
    kind: "invoice",
    number: null,
    status: "draft",
    locked: false,
    settlement: "unpaid",
    overdue: false,
    revision: 1,
    taxDocument: true,
    contact: toContactSnapshot(contacts[1]),
    issuer: ISSUER_SNAPSHOT,
    dates: { issuedOn: "2026-11-24", taxableSupplyOn: "2026-11-24", dueOn: "2026-12-24" },
    paymentMethod: "bank_transfer",
    lines: [
      {
        id: demoId(654),
        item: null,
        description: "Design system workshop",
        quantity: "2",
        unit: "day",
        unitPrice: "1200",
        treatment: "reverse_charge",
        ratePercent: "0",
        amount: "2400",
        deducts: null,
      },
    ],
    totals: {
      buckets: [
        {
          treatment: "reverse_charge",
          ratePercent: "0",
          base: "2400",
          vat: "0",
          gross: "2400",
          vatCzk: "0",
        },
      ],
      net: { amount: "2400", currency: "EUR" },
      vat: { amount: "0", currency: "EUR" },
      roundingAdjustment: { amount: "0", currency: "EUR" },
      gross: { amount: "2400", currency: "EUR" },
      vatCzk: { amount: "0", currency: "CZK" },
    },
    fx: { rate: "25.15", quantity: 1, fixingDate: "2026-11-24", source: "cnb" },
    statutoryNotes: [
      { code: "reverse_charge", text: "Reverse charge — customer accounts for VAT." },
    ],
    paymentQr: null,
    related: [],
    share: null,
    deliveries: [],
  },
];

const documents = [...documentFixtures];

const payments: Array<DemoPayment> = [
  {
    id: PAY_1_ID,
    revision: 1,
    target: { document: DOC_2_ID },
    amount: { amount: "14520", currency: "CZK" },
    paidOn: "2026-11-05",
    method: "bank_transfer",
    note: "Bankovní převod",
    taxDocument: DOC_3_ID,
    createdAt: "2026-11-05T14:20:00Z",
  },
];

const templates: Array<DemoTemplate> = [
  {
    id: TPL_1_ID,
    name: "Měsíční podpora webu — Alza",
    revision: 2,
    archived: false,
    input: {
      kind: "invoice",
      contact: CONTACT_1_ID,
      currency: "CZK",
      due: { inDays: 14 },
      paymentMethod: "bank_transfer",
      pricesIncludeVat: false,
      lines: [
        {
          description: "Měsíční podpora webu",
          quantity: "1",
          unit: "měs",
          unitPrice: "12000",
          vat: "standard",
        },
      ],
    },
    schedule: {
      id: SCHED_1_ID,
      every: { months: 1 },
      startOn: "2026-01-01",
      endOn: null,
      issueAs: "invoice",
      autoSend: true,
      nextOccurrence: "2026-12-01",
      paused: false,
      pausedReason: null,
      pausedError: null,
    },
  },
  {
    id: TPL_2_ID,
    name: "Kvartální retainer — Nordic Studio",
    revision: 3,
    archived: false,
    input: {
      kind: "invoice",
      contact: CONTACT_2_ID,
      currency: "EUR",
      due: { inDays: 30 },
      paymentMethod: "bank_transfer",
      pricesIncludeVat: false,
      lines: [
        {
          description: "Quarterly design retainer",
          quantity: "1",
          unit: "qtr",
          unitPrice: "3500",
          vat: "reverse_charge",
        },
      ],
    },
    schedule: {
      id: SCHED_2_ID,
      every: { months: 3 },
      startOn: "2026-01-01",
      endOn: null,
      issueAs: "invoice",
      autoSend: true,
      nextOccurrence: "2026-10-01",
      paused: true,
      pausedReason: "fx.rate_missing",
      pausedError: null,
    },
  },
];

const runsByTemplate = new Map([
  [
    TPL_1_ID,
    [
      {
        occurrence: "2026-11-01",
        outcome: "issued",
        at: "2026-11-01T07:00:12Z",
        document: { id: DOC_1_ID, number: "2026-0041" },
        delivery: { id: demoId(851), status: "sent" },
        failure: null,
      },
    ],
  ],
  [
    TPL_2_ID,
    [
      {
        occurrence: "2026-10-01",
        outcome: "failed",
        at: "2026-10-01T07:00:05Z",
        document: null,
        delivery: null,
        failure: "fx.rate_missing",
      },
    ],
  ],
]);

const toSummary = (doc: DemoDocument) => ({
  id: doc.id,
  kind: doc.kind,
  number: doc.number,
  status: doc.status,
  locked: doc.locked,
  settlement: doc.settlement,
  overdue: doc.overdue,
  revision: doc.revision,
  contact: { id: doc.contact.contactId, name: doc.contact.name },
  issuedOn: doc.dates.issuedOn,
  dueOn: doc.dates.dueOn,
  total: doc.totals.gross,
});

const dashboardFixture = {
  period: { from: "2026-01-01", to: "2026-11-24" },
  revenue: { amount: "642500", currency: "CZK" },
  unpaid: { amount: "87120", currency: "CZK" },
  overdue: { total: { amount: "87120", currency: "CZK" }, count: 1 },
  expenses: { amount: "184200", currency: "CZK" },
  incompleteExpenses: 2,
  cashflow: [
    {
      month: "2025-12",
      in: { amount: "52000", currency: "CZK" },
      out: { amount: "18000", currency: "CZK" },
      net: { amount: "34000", currency: "CZK" },
    },
    {
      month: "2026-01",
      in: { amount: "61000", currency: "CZK" },
      out: { amount: "21000", currency: "CZK" },
      net: { amount: "40000", currency: "CZK" },
    },
    {
      month: "2026-02",
      in: { amount: "48000", currency: "CZK" },
      out: { amount: "15000", currency: "CZK" },
      net: { amount: "33000", currency: "CZK" },
    },
    {
      month: "2026-03",
      in: { amount: "79000", currency: "CZK" },
      out: { amount: "24000", currency: "CZK" },
      net: { amount: "55000", currency: "CZK" },
    },
    {
      month: "2026-04",
      in: { amount: "64000", currency: "CZK" },
      out: { amount: "19000", currency: "CZK" },
      net: { amount: "45000", currency: "CZK" },
    },
    {
      month: "2026-05",
      in: { amount: "82000", currency: "CZK" },
      out: { amount: "22000", currency: "CZK" },
      net: { amount: "60000", currency: "CZK" },
    },
    {
      month: "2026-06",
      in: { amount: "55000", currency: "CZK" },
      out: { amount: "17000", currency: "CZK" },
      net: { amount: "38000", currency: "CZK" },
    },
    {
      month: "2026-07",
      in: { amount: "44000", currency: "CZK" },
      out: { amount: "14000", currency: "CZK" },
      net: { amount: "30000", currency: "CZK" },
    },
    {
      month: "2026-08",
      in: { amount: "68000", currency: "CZK" },
      out: { amount: "16000", currency: "CZK" },
      net: { amount: "52000", currency: "CZK" },
    },
    {
      month: "2026-09",
      in: { amount: "91000", currency: "CZK" },
      out: { amount: "26000", currency: "CZK" },
      net: { amount: "65000", currency: "CZK" },
    },
    {
      month: "2026-10",
      in: { amount: "74000", currency: "CZK" },
      out: { amount: "20000", currency: "CZK" },
      net: { amount: "54000", currency: "CZK" },
    },
    {
      month: "2026-11",
      in: { amount: "86520", currency: "CZK" },
      out: { amount: "21200", currency: "CZK" },
      net: { amount: "65320", currency: "CZK" },
    },
  ],
};

export const routes: ReadonlyArray<DemoRoute> = [
  // Dashboard & FX
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/reports/dashboard",
    respond: () => dashboardFixture,
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/fx-rates/:currency",
    respond: ({ params, query }) => ({
      currency: params.currency ?? "EUR",
      rate: params.currency === "USD" ? "23.45" : params.currency === "GBP" ? "29.80" : "25.15",
      quantity: 1,
      fixingDate: query.get("on") ?? "2026-11-24",
      source: "cnb",
    }),
  },
  // Workspace lookups needed by editor
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId",
    respond: () => ({
      slug: DEMO_WORKSPACE.slug,
      name: DEMO_WORKSPACE.name,
      revision: 1,
      branding: {
        pdfTemplate: "classic",
        accentColor: "#18181B",
        footerText: null,
        theme: null,
        logo: null,
        stamp: null,
      },
      defaults: {
        currency: "CZK",
        language: "cs",
        dueDays: 14,
        paymentMethod: "bank_transfer",
        defaultNote: null,
        paymentRounding: "none",
        paymentTaxDocumentAutoSend: true,
      },
    }),
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/numbering-series",
    respond: () => numberingSeries,
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/bank-accounts",
    respond: () => bankAccounts,
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/contacts",
    respond: () => ({ items: contacts, nextCursor: null }),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/contacts/from-ico",
    respond: ({ body }) => {
      const ico = Str.trim(Option.getOrUndefined(decodeFromIco(body))?.ico ?? "");
      const existing = Option.getOrUndefined(Arr.findFirst(contacts, (c) => c.ico === ico));
      if (existing !== undefined) return existing;
      const created: DemoContact = {
        id: nextId(),
        roles: ["customer"],
        name: `Společnost ${ico} s.r.o.`,
        ico,
        dic: `CZ${ico}`,
        legalForm: "Společnost s ručením omezeným",
        address: {
          street: "Václavské náměstí 1",
          city: "Praha 1",
          postalCode: "110 00",
          country: "CZ",
        },
        billingEmails: [`fakturace@${ico}.example.cz`],
        phone: null,
        note: null,
        defaults: {},
        archived: false,
        revision: 1,
      };
      contacts.unshift(created);
      return created;
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/price-list-items",
    respond: () => priceList,
  },
  // Documents CRUD & lifecycle
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/documents",
    respond: ({ query }) => {
      const kind = query.get("kind");
      const docStatus = query.get("status");
      const settlement = query.get("settlement");
      const overdue = query.get("overdue");
      const text = Str.trim(Str.toLowerCase(query.get("text") ?? ""));
      const filtered = Arr.filter(documents, (d) => {
        if (kind !== null && d.kind !== kind) return false;
        if (docStatus !== null && d.status !== docStatus) return false;
        if (settlement !== null && d.settlement !== settlement) return false;
        if (overdue === "true" && !d.overdue) return false;
        if (
          text !== "" &&
          !Str.includes(text)(Str.toLowerCase(d.number ?? "")) &&
          !Str.includes(text)(Str.toLowerCase(d.contact.name))
        ) {
          return false;
        }
        return true;
      });
      return { items: Arr.map(filtered, toSummary), nextCursor: null };
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents",
    respond: ({ body }) => {
      const input = Option.getOrUndefined(decodeDocumentInput(body));
      const contact =
        Option.getOrUndefined(Arr.findFirst(contacts, (c) => c.id === input?.contact)) ??
        contacts[0];
      const id = nextId();
      const created: DemoDocument = {
        ...(documents[0] ?? documentFixtures[0]),
        id,
        kind: input?.kind ?? "invoice",
        number: null,
        status: "draft",
        locked: false,
        settlement: "unpaid",
        overdue: false,
        revision: 1,
        contact: toContactSnapshot(contact),
        dates: {
          issuedOn: input?.issuedOn ?? "2026-11-24",
          taxableSupplyOn: input?.taxableSupplyOn ?? input?.issuedOn ?? "2026-11-24",
          dueOn: "2026-12-08",
        },
        related: [],
        share: null,
        deliveries: [],
      };
      documents.unshift(created);
      return status(201, created);
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents/issue",
    respond: ({ body }) => {
      const input = Option.getOrUndefined(decodeIssueInput(body))?.input;
      const contact =
        Option.getOrUndefined(Arr.findFirst(contacts, (c) => c.id === input?.contact)) ??
        contacts[0];
      const id = nextId();
      const created: DemoDocument = {
        ...(documents[0] ?? documentFixtures[0]),
        id,
        kind: input?.kind ?? "invoice",
        number: input?.kind === "proforma" ? `ZF-2026-00${nextSeq}` : `2026-00${nextSeq}`,
        status: "issued",
        locked: false,
        settlement: "unpaid",
        overdue: false,
        revision: 1,
        contact: toContactSnapshot(contact),
        dates: {
          issuedOn: input?.issuedOn ?? "2026-11-24",
          taxableSupplyOn: input?.taxableSupplyOn ?? input?.issuedOn ?? "2026-11-24",
          dueOn: "2026-12-08",
        },
        related: [],
        share: null,
        deliveries: [],
      };
      documents.unshift(created);
      return status(201, created);
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      return found ?? status(404, { _tag: "NotFound", entity: "Document", id: params.documentId });
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId",
    respond: ({ params, body }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Document", id: params.documentId });
      }
      const patch = Option.getOrUndefined(decodeDocumentPatch(body));
      if (patch?.number !== undefined) found.number = patch.number;
      found.revision += 1;
      return found;
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId",
    respond: ({ params }) => {
      const idx = Option.getOrUndefined(
        Arr.findFirstIndex(documents, (d) => d.id === params.documentId),
      );
      if (idx !== undefined) documents.splice(idx, 1);
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/issue",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Document", id: params.documentId });
      }
      found.status = "issued";
      found.number = found.kind === "proforma" ? `ZF-2026-00${++nextSeq}` : `2026-00${++nextSeq}`;
      found.revision += 1;
      return found;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/lock",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Document", id: params.documentId });
      }
      found.locked = true;
      found.revision += 1;
      return found;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/unlock",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Document", id: params.documentId });
      }
      found.locked = false;
      found.revision += 1;
      return found;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/cancel",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Document", id: params.documentId });
      }
      found.status = "cancelled";
      found.revision += 1;
      return { document: found, creditNote: null };
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/credit-notes",
    respond: ({ params }) => {
      const orig = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      if (orig === undefined) {
        return status(404, { _tag: "NotFound", entity: "Document", id: params.documentId });
      }
      const id = nextId();
      const number = `OD-2026-00${++nextSeq}`;
      const cn: DemoDocument = {
        ...orig,
        id,
        kind: "credit_note",
        number,
        status: "issued",
        locked: false,
        settlement: "paid",
        overdue: false,
        revision: 1,
        related: [
          { relation: "corrects", id: orig.id, kind: orig.kind, number: orig.number ?? "" },
        ],
      };
      orig.related = [
        ...orig.related,
        { relation: "corrected_by", id, kind: "credit_note", number },
      ];
      documents.unshift(cn);
      return status(201, cn);
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/final-invoice",
    respond: ({ params }) => {
      const proforma = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      if (proforma === undefined) {
        return status(404, { _tag: "NotFound", entity: "Document", id: params.documentId });
      }
      const id = nextId();
      const number = `2026-00${++nextSeq}`;
      const fi: DemoDocument = {
        ...proforma,
        id,
        kind: "invoice",
        number,
        status: "issued",
        locked: false,
        settlement: "paid",
        overdue: false,
        revision: 1,
        taxDocument: true,
        related: [
          {
            relation: "advance_of",
            id: proforma.id,
            kind: "proforma",
            number: proforma.number ?? "",
          },
        ],
      };
      proforma.related = [
        ...proforma.related,
        { relation: "final_invoice_for", id, kind: "invoice", number },
      ];
      documents.unshift(fi);
      return status(201, fi);
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/deliveries",
    respond: ({ params, body }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      const deliveryId = nextId();
      if (found !== undefined) {
        const input = Option.getOrUndefined(decodeDelivery(body));
        found.deliveries = [
          {
            id: deliveryId,
            to: [...(input?.to ?? found.contact.billingEmails)],
            purpose: input?.purpose ?? "document",
            status: "queued",
            at: "2026-11-24T13:00:00Z",
          },
          ...found.deliveries,
        ];
      }
      return status(202, { deliveryId, status: "queued" });
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/history",
    respond: ({ params }) => [
      {
        id: demoId(910),
        at: "2026-10-15T09:00:00Z",
        actor: { _tag: "Member", userId: demoId(1), channel: "web", client: null },
        subject: { entity: "Document", id: params.documentId ?? DOC_1_ID },
        action: "document.issue",
        revision: 1,
        changes: [],
        reason: null,
      },
    ],
  },
  // Share links
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/share-link",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      const url = `https://app.kvitbit.cz/i/demo-${params.documentId}`;
      if (found !== undefined) found.share = { url, views: 0, lastViewedAt: null };
      return { url };
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/share-link",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(documents, (d) => d.id === params.documentId),
      );
      if (found !== undefined) found.share = null;
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/share-link/views",
    respond: () => ({
      items: [
        { id: demoId(920), kind: "view", at: "2026-11-20T10:15:00Z", device: "desktop" },
        { id: demoId(921), kind: "download", at: "2026-11-20T10:16:00Z", device: "desktop" },
      ],
      nextCursor: null,
    }),
  },
  // Payments
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/documents/:documentId/payments",
    respond: ({ params }) => Arr.filter(payments, (p) => p.target.document === params.documentId),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/payments",
    respond: ({ body }) => {
      const input = Option.getOrUndefined(decodePayment(body));
      const docId =
        input !== undefined && "document" in input.target ? input.target.document : undefined;
      const doc = Option.getOrUndefined(Arr.findFirst(documents, (d) => d.id === docId));
      const amount = input?.amount;
      const payment: DemoPayment = {
        id: nextId(),
        revision: 1,
        target: { document: docId },
        amount:
          amount === undefined
            ? (doc?.totals.gross ?? { amount: "1000", currency: "CZK" })
            : { amount: BigDecimal.format(amount.amount), currency: amount.currency },
        paidOn: input?.paidOn ?? "2026-11-24",
        method: input?.method ?? "bank_transfer",
        note: input?.note ?? null,
        taxDocument: null,
        createdAt: "2026-11-24T13:10:00Z",
      };
      const issued: Array<DemoDocument> = [];
      if (doc !== undefined) {
        doc.settlement = "paid";
        doc.overdue = false;
        doc.revision += 1;
        if (doc.kind === "proforma") {
          const ptd: DemoDocument = {
            ...doc,
            id: nextId(),
            kind: "payment_tax_document",
            number: `DD-2026-00${++nextSeq}`,
            taxDocument: true,
            related: [
              { relation: "advance_of", id: doc.id, kind: "proforma", number: doc.number ?? "" },
            ],
          };
          payment.taxDocument = ptd.id;
          documents.unshift(ptd);
          issued.push(ptd);
        }
      }
      payments.unshift(payment);
      return status(201, { payment, settlement: "paid", issued });
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/payments/:paymentId/remove",
    respond: ({ params }) => {
      const idx = Option.getOrUndefined(
        Arr.findFirstIndex(payments, (p) => p.id === params.paymentId),
      );
      if (idx !== undefined) payments.splice(idx, 1);
    },
  },
  // Templates & Recurring
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/templates",
    respond: () => Arr.filter(templates, (t) => !t.archived),
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/templates/:templateId",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(templates, (t) => t.id === params.templateId),
      );
      return found ?? status(404, { _tag: "NotFound", entity: "Template", id: params.templateId });
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/templates",
    respond: ({ body }) => {
      const input = Option.getOrUndefined(decodeTemplate(body));
      const created: DemoTemplate = {
        id: nextId(),
        name: input?.name ?? "Šablona",
        revision: 1,
        archived: false,
        input: input === undefined ? {} : Option.getOrElse(encodeTemplate(input), () => ({})),
        schedule: null,
      };
      templates.unshift(created);
      return status(201, created);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/templates/:templateId",
    respond: ({ params, body }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(templates, (t) => t.id === params.templateId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Template", id: params.templateId });
      }
      const input = Option.getOrUndefined(decodeTemplate(body));
      found.name = input?.name ?? found.name;
      found.input = input === undefined ? {} : Option.getOrElse(encodeTemplate(input), () => ({}));
      found.revision += 1;
      return found;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/templates/:templateId/archive",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(templates, (t) => t.id === params.templateId),
      );
      if (found !== undefined) found.archived = true;
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/templates/:templateId/schedule",
    respond: ({ params, body }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(templates, (t) => t.id === params.templateId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Template", id: params.templateId });
      }
      const input = Option.getOrUndefined(decodeSchedule(body));
      found.schedule = {
        id: found.schedule?.id ?? nextId(),
        every: input?.every ?? { months: 1 },
        startOn: input?.startOn ?? "2026-12-01",
        endOn: input?.endOn ?? null,
        issueAs: input?.issueAs ?? "invoice",
        autoSend: input?.autoSend ?? false,
        nextOccurrence: input?.startOn ?? "2026-12-01",
        paused: false,
        pausedReason: null,
        pausedError: null,
      };
      found.revision += 1;
      return found;
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/templates/:templateId/schedule",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(templates, (t) => t.id === params.templateId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Template", id: params.templateId });
      }
      found.schedule = null;
      found.revision += 1;
      return found;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/templates/:templateId/resume",
    respond: ({ params }) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(templates, (t) => t.id === params.templateId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Template", id: params.templateId });
      }
      if (found.schedule !== null) {
        found.schedule.paused = false;
        found.schedule.pausedReason = null;
        found.schedule.pausedError = null;
      }
      found.revision += 1;
      return found;
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/templates/:templateId/runs",
    respond: ({ params }) => ({
      items: runsByTemplate.get(params.templateId ?? "") ?? [],
      nextCursor: null,
    }),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/templates/:templateId/documents",
    respond: () => status(201, documents[3] ?? documents[0]),
  },
];
