/**
 * Demo API handlers for the `records` page group (Expenses, Contacts, Price List, Reports, FX,
 * and Expense Payments). Returns encoded wire JSON matching @kvitbit/api-contract and core views.
 */

import { ContactRole, FromIcoInput, RecordPaymentInput } from "@kvitbit/api-contract";
import {
  ContactDefaults,
  ContactId,
  CurrencyCode,
  ExpenseStatus,
  IsoDate,
  Money,
  type VatBreakdown,
  type VatBucket,
  VatTreatment,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type DemoRoute, status } from "./router";
import { demoId } from "./shell";

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

const NullableText = Schema.NullOr(Schema.String);
const TextField = Schema.optionalKey(NullableText);
const DecimalText = Schema.String.check(
  Schema.makeFilter((value) => Option.isSome(BigDecimal.fromString(value)), {
    expected: "a decimal string",
  }),
);

// The domain contracts leave some record fields open. Check the fields the demo reads.
const decodeContact = Schema.decodeUnknownResult(
  Schema.Struct({
    roles: ContactRole.pipe(Schema.Array, Schema.NullOr, Schema.optionalKey),
    name: TextField,
    ico: TextField,
    dic: TextField,
    legalForm: TextField,
    address: Schema.Struct({
      street: TextField,
      city: TextField,
      postalCode: TextField,
      country: TextField,
    }).pipe(Schema.NullOr, Schema.optionalKey),
    billingEmails: Schema.String.pipe(Schema.Array, Schema.NullOr, Schema.optionalKey),
    phone: TextField,
    note: TextField,
    defaults: ContactDefaults.pipe(Schema.NullOr, Schema.optionalKey),
  }),
);

const decodeFromIco = Schema.decodeUnknownResult(FromIcoInput);

const decodePriceListItem = Schema.decodeUnknownResult(
  Schema.Struct({
    name: TextField,
    description: TextField,
    unit: TextField,
    unitPrice: Schema.optionalKey(DecimalText),
    currency: CurrencyCode.pipe(Schema.NullOr, Schema.optionalKey),
    vat: VatTreatment.pipe(Schema.NullOr, Schema.optionalKey),
  }),
);

const ExpenseSupplierInput = Schema.Union([
  Schema.Struct({ contact: ContactId }),
  Schema.Struct({ ico: Schema.String }),
  Schema.Struct({ manual: Schema.Struct({ name: TextField, ico: TextField, dic: TextField }) }),
]);

const ExpenseVatInput = Schema.Struct({
  treatment: VatTreatment,
  base: DecimalText,
  vat: Schema.optionalKey(DecimalText),
  selfAssessed: Schema.Literals(["standard", "reduced"]).pipe(Schema.NullOr, Schema.optionalKey),
});

const ExpenseDeductibility = Schema.Union([
  Schema.Literals(["full", "none"]),
  Schema.Struct({ partial: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })) }),
]);

const ExpenseDateField = IsoDate.pipe(Schema.NullOr, Schema.optionalKey);
const decodeExpense = Schema.decodeUnknownResult(
  Schema.Struct({
    status: Schema.optionalKey(ExpenseStatus),
    supplier: ExpenseSupplierInput.pipe(Schema.NullOr, Schema.optionalKey),
    supplierDocumentNumber: TextField,
    issuedOn: ExpenseDateField,
    taxableSupplyOn: ExpenseDateField,
    dueOn: ExpenseDateField,
    currency: CurrencyCode.pipe(Schema.NullOr, Schema.optionalKey),
    total: DecimalText.pipe(Schema.NullOr, Schema.optionalKey),
    vat: ExpenseVatInput.pipe(Schema.Array, Schema.NullOr, Schema.optionalKey),
    deductibility: Schema.optionalKey(ExpenseDeductibility),
    category: TextField,
    tags: Schema.String.pipe(Schema.Array, Schema.NullOr, Schema.optionalKey),
    note: TextField,
  }),
);

const decodePayment = Schema.decodeUnknownResult(
  Schema.Struct({
    ...RecordPaymentInput.fields,
    amount: Schema.optionalKey(Schema.Struct({ ...Money.fields, amount: DecimalText })),
  }),
);

const malformedBody = () =>
  status(422, {
    _tag: "Invalid",
    issues: [{ path: [], code: "request.malformed" }],
  });

// --- Seeded demo fixtures ------------------------------------------------------------------------

let nextSeq = 500;
const nextId = (): string => demoId(++nextSeq);

interface DemoContact {
  id: string;
  roles: ReadonlyArray<ContactRole>;
  name: string;
  ico: string | null;
  dic: string | null;
  legalForm: string | null;
  address: {
    street: string | null;
    city: string | null;
    postalCode: string | null;
    country: string;
  };
  billingEmails: ReadonlyArray<string>;
  phone: string | null;
  note: string | null;
  defaults: ContactDefaults;
  registryFetchedAt: string | null;
  archived: boolean;
  revision: number;
}

const contacts: Array<DemoContact> = [
  {
    id: demoId(201),
    roles: ["customer"],
    name: "Nordic Craft s.r.o.",
    ico: "04829132",
    dic: "CZ04829132",
    legalForm: "Společnost s ručením omezeným",
    address: { street: "Křižíkova 148/34", city: "Praha 8", postalCode: "186 00", country: "CZ" },
    billingEmails: ["fakturace@nordiccraft.cz"],
    phone: "+420 222 111 333",
    note: "Preferuje faktury v EUR pro zahraniční projekty.",
    defaults: {
      currency: CurrencyCode.make("EUR"),
      language: "en",
      dueDays: 21,
      paymentMethod: "bank_transfer",
      reminderPolicy: { mode: "custom", offsetsDays: [7, 14] },
    },
    registryFetchedAt: "2026-11-10T09:15:00.000Z",
    archived: false,
    revision: 2,
  },
  {
    id: demoId(202),
    roles: ["supplier"],
    name: "Alza.cz a.s.",
    ico: "27082440",
    dic: "CZ27082440",
    legalForm: "Akciová společnost",
    address: { street: "Jankovcova 1522/53", city: "Praha 7", postalCode: "170 00", country: "CZ" },
    billingEmails: ["fakturace@alza.cz"],
    phone: "+420 225 340 111",
    note: null,
    defaults: { reminderPolicy: { mode: "inherit" } },
    registryFetchedAt: "2026-11-01T10:00:00.000Z",
    archived: false,
    revision: 1,
  },
  {
    id: demoId(203),
    roles: ["customer", "supplier"],
    name: "Studio Křivánek s.r.o.",
    ico: "06412345",
    dic: "CZ06412345",
    legalForm: "Společnost s ručením omezeným",
    address: { street: "Lidická 26", city: "Brno", postalCode: "602 00", country: "CZ" },
    billingEmails: ["ucetni@krivanek.cz"],
    phone: null,
    note: null,
    defaults: { dueDays: 14, reminderPolicy: { mode: "inherit" } },
    registryFetchedAt: "2026-10-18T12:00:00.000Z",
    archived: false,
    revision: 1,
  },
];

const expenseSupplier = (
  supplier: typeof ExpenseSupplierInput.Type | null | undefined,
): DemoExpense["supplier"] => {
  if (supplier === null || supplier === undefined) return null;
  if ("manual" in supplier) {
    const { name = null, ico = null, dic = null } = supplier.manual;
    return { contactId: null, name, ico, dic };
  }
  if ("contact" in supplier) {
    const contact = Option.getOrUndefined(
      Arr.findFirst(contacts, ({ id }) => id === supplier.contact),
    );
    if (contact !== undefined) {
      return { contactId: contact.id, name: contact.name, ico: contact.ico, dic: contact.dic };
    }
  }
  return null;
};

interface DemoPriceListItem {
  id: string;
  name: string;
  description: string | null;
  unit: string | null;
  unitPrice: string;
  currency: string;
  vat: string | null;
  archived: boolean;
  revision: number;
}

const priceListItems: Array<DemoPriceListItem> = [
  {
    id: demoId(301),
    name: "UX & produktový design",
    description: "Návrh rozhraní, prototypování a uživatelské testování",
    unit: "hod",
    unitPrice: "1850.00",
    currency: "CZK",
    vat: "standard",
    archived: false,
    revision: 1,
  },
  {
    id: demoId(302),
    name: "Frontend konzultace (EU)",
    description: "Technická konzultace pro klienty z EU (přenesená daňová povinnost)",
    unit: "hod",
    unitPrice: "70.00",
    currency: "EUR",
    vat: "reverse_charge",
    archived: false,
    revision: 2,
  },
  {
    id: demoId(303),
    name: "Měsíční správa design systému",
    description: null,
    unit: "měs.",
    unitPrice: "18000.00",
    currency: "CZK",
    vat: "standard",
    archived: false,
    revision: 1,
  },
];

interface DemoExpense {
  id: string;
  revision: number;
  status: "complete" | "incomplete";
  supplier: {
    contactId: string | null;
    name: string | null;
    ico: string | null;
    dic: string | null;
  } | null;
  supplierDocumentNumber: string | null;
  issuedOn: string | null;
  taxableSupplyOn: string | null;
  dueOn: string | null;
  currency: string | null;
  total: string | null;
  vat: Array<{
    treatment: string;
    base: string;
    vat: string;
    selfAssessed: "standard" | "reduced" | null;
  }> | null;
  totals: Schema.toCodecJson<typeof VatBreakdown>["Encoded"] | null;
  selfAssessed: ReadonlyArray<Schema.toCodecJson<typeof VatBucket>["Encoded"]>;
  fx: {
    rate: string;
    quantity: number;
    fixingDate: string | null;
    source: "cnb" | "manual";
  } | null;
  totalCzk: string | null;
  deductibility: "full" | "none" | { partial: number };
  deductibleVat: { amount: string; currency: string } | null;
  deductibleVatCzk: string | null;
  category: string | null;
  tags: ReadonlyArray<string>;
  note: string | null;
  attachments: Array<{
    id: string;
    expenseId: string;
    name: string;
    contentType: string;
    bytes: number;
    sha256: string;
    createdAt: string;
  }>;
  payment: {
    settlement: "unpaid" | "partially_paid" | "paid" | "overpaid";
    paid: { amount: string; currency: string } | null;
    payments: number;
  };
  createdAt: string;
  updatedAt: string;
}

const expenses: Array<DemoExpense> = [
  {
    id: demoId(401),
    revision: 2,
    status: "complete",
    supplier: { contactId: demoId(202), name: "Alza.cz a.s.", ico: "27082440", dic: "CZ27082440" },
    supplierDocumentNumber: "2026-ALZ-88412",
    issuedOn: "2026-11-16",
    taxableSupplyOn: "2026-11-16",
    dueOn: "2026-11-30",
    currency: "CZK",
    total: "24200.00",
    vat: [{ treatment: "standard", base: "20000.00", vat: "4200.00", selfAssessed: null }],
    totals: {
      buckets: [
        {
          treatment: "standard",
          ratePercent: "21",
          base: "20000.00",
          vat: "4200.00",
          gross: "24200.00",
          vatCzk: null,
        },
      ],
      net: { amount: "20000.00", currency: "CZK" },
      vat: { amount: "4200.00", currency: "CZK" },
      roundingAdjustment: { amount: "0.00", currency: "CZK" },
      gross: { amount: "24200.00", currency: "CZK" },
      vatCzk: null,
    },
    selfAssessed: [],
    fx: null,
    totalCzk: "24200.00",
    deductibility: "full",
    deductibleVat: { amount: "4200.00", currency: "CZK" },
    deductibleVatCzk: "4200.00",
    category: "Hardware",
    tags: ["kancelář", "monitor"],
    note: "Monitor 4K pro design stanici",
    attachments: [
      {
        id: demoId(451),
        expenseId: demoId(401),
        name: "alza-2026-88412.pdf",
        contentType: "application/pdf",
        bytes: 148200,
        sha256: "demo-sha256-451",
        createdAt: "2026-11-16T08:30:00.000Z",
      },
    ],
    payment: { settlement: "paid", paid: { amount: "24200.00", currency: "CZK" }, payments: 1 },
    createdAt: "2026-11-16T08:30:00.000Z",
    updatedAt: "2026-11-16T09:00:00.000Z",
  },
  {
    id: demoId(402),
    revision: 1,
    status: "complete",
    supplier: { contactId: null, name: "Hetzner Online GmbH", ico: null, dic: "DE812871812" },
    supplierDocumentNumber: "INV-DE-99104",
    issuedOn: "2026-11-10",
    taxableSupplyOn: "2026-11-10",
    dueOn: "2026-11-24",
    currency: "EUR",
    total: "120.00",
    vat: [{ treatment: "reverse_charge", base: "120.00", vat: "0.00", selfAssessed: "standard" }],
    totals: {
      buckets: [
        {
          treatment: "reverse_charge",
          ratePercent: "0",
          base: "120.00",
          vat: "0.00",
          gross: "120.00",
          vatCzk: "0.00",
        },
      ],
      net: { amount: "120.00", currency: "EUR" },
      vat: { amount: "0.00", currency: "EUR" },
      roundingAdjustment: { amount: "0.00", currency: "EUR" },
      gross: { amount: "120.00", currency: "EUR" },
      vatCzk: { amount: "0.00", currency: "CZK" },
    },
    selfAssessed: [
      {
        treatment: "reverse_charge",
        ratePercent: "21",
        base: "120.00",
        vat: "25.20",
        gross: "145.20",
        vatCzk: "635.04",
      },
    ],
    fx: { rate: "25.20", quantity: 1, fixingDate: "2026-11-10", source: "cnb" },
    totalCzk: "3024.00",
    deductibility: "full",
    deductibleVat: { amount: "25.20", currency: "EUR" },
    deductibleVatCzk: "635.04",
    category: "Cloud & Hosting",
    tags: ["infra", "eu"],
    note: "Měsíční servery",
    attachments: [],
    payment: { settlement: "unpaid", paid: null, payments: 0 },
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
  },
  {
    id: demoId(403),
    revision: 1,
    status: "incomplete",
    supplier: null,
    supplierDocumentNumber: null,
    issuedOn: null,
    taxableSupplyOn: null,
    dueOn: null,
    currency: null,
    total: null,
    vat: null,
    totals: null,
    selfAssessed: [],
    fx: null,
    totalCzk: null,
    deductibility: "full",
    deductibleVat: null,
    deductibleVatCzk: null,
    category: null,
    tags: [],
    note: "uctenka-kavarna.jpg",
    attachments: [],
    payment: { settlement: "unpaid", paid: null, payments: 0 },
    createdAt: "2026-11-22T14:20:00.000Z",
    updatedAt: "2026-11-22T14:20:00.000Z",
  },
];

interface DemoPayment {
  id: string;
  revision: number;
  target: { expense: string };
  amount: { amount: string; currency: string };
  paidOn: string;
  method: string;
  note: string | null;
  taxDocument: null;
  createdAt: string;
}

const expensePayments: Array<DemoPayment> = [
  {
    id: demoId(480),
    revision: 1,
    target: { expense: demoId(401) },
    amount: { amount: "24200.00", currency: "CZK" },
    paidOn: "2026-11-16",
    method: "card",
    note: "Firemní karta",
    taxDocument: null,
    createdAt: "2026-11-16T09:00:00.000Z",
  },
];

const toExpenseSummary = (e: DemoExpense) => ({
  id: e.id,
  revision: e.revision,
  status: e.status,
  supplierName: e.supplier?.name ?? null,
  supplierDocumentNumber: e.supplierDocumentNumber,
  issuedOn: e.issuedOn,
  total: e.total,
  currency: e.currency,
  category: e.category,
  tags: e.tags,
  attachments: e.attachments.length,
  settlement: e.payment.settlement,
});

const recomputeExpensePayment = (exp: DemoExpense): void => {
  const pays = Arr.filter(expensePayments, (p) => p.target.expense === exp.id);
  const sum = Arr.reduce(pays, 0, (acc, p) => acc + Number(p.amount.amount));
  const total = Number(exp.total ?? "0");
  exp.payment = {
    payments: pays.length,
    paid: pays.length === 0 ? null : { amount: sum.toFixed(2), currency: exp.currency ?? "CZK" },
    settlement:
      pays.length === 0 || sum <= 0
        ? "unpaid"
        : sum < total
          ? "partially_paid"
          : sum === total
            ? "paid"
            : "overpaid",
  };
};

// --- Report fixtures -----------------------------------------------------------------------------

const buildDemoReport = (report: string, from: string, to: string, groupBy?: string) => {
  const period = { from, to };
  switch (report) {
    case "expenses":
      return {
        report: "expenses",
        period,
        groupBy: groupBy ?? "month",
        rows: [
          {
            key: groupBy === "category" ? "Hardware" : "2026-10",
            label: groupBy === "category" ? "Hardware" : null,
            count: 2,
            net: { amount: "32000.00", currency: "CZK" },
            vat: { amount: "6720.00", currency: "CZK" },
            gross: { amount: "38720.00", currency: "CZK" },
            original: null,
          },
          {
            key: groupBy === "category" ? "Cloud & Hosting" : "2026-11",
            label: groupBy === "category" ? "Cloud & Hosting" : null,
            count: 2,
            net: { amount: "23024.00", currency: "CZK" },
            vat: { amount: "4200.00", currency: "CZK" },
            gross: { amount: "27224.00", currency: "CZK" },
            original: null,
          },
        ],
        totals: {
          count: 4,
          net: { amount: "55024.00", currency: "CZK" },
          vat: { amount: "10920.00", currency: "CZK" },
          gross: { amount: "65944.00", currency: "CZK" },
        },
        incomplete: Arr.filter(expenses, (e) => e.status === "incomplete").length,
      };
    case "cashflow":
      return {
        report: "cashflow",
        period,
        points: [
          {
            month: "2026-09",
            in: { amount: "145000.00", currency: "CZK" },
            out: { amount: "31200.00", currency: "CZK" },
            net: { amount: "113800.00", currency: "CZK" },
          },
          {
            month: "2026-10",
            in: { amount: "182500.00", currency: "CZK" },
            out: { amount: "38720.00", currency: "CZK" },
            net: { amount: "143780.00", currency: "CZK" },
          },
          {
            month: "2026-11",
            in: { amount: "128400.00", currency: "CZK" },
            out: { amount: "24200.00", currency: "CZK" },
            net: { amount: "104200.00", currency: "CZK" },
          },
        ],
        totals: {
          in: { amount: "455900.00", currency: "CZK" },
          out: { amount: "94120.00", currency: "CZK" },
          net: { amount: "361780.00", currency: "CZK" },
        },
      };
    case "receivables":
      return {
        report: "receivables",
        period,
        asOf: to,
        buckets: [
          {
            bucket: "not_due",
            count: 1,
            total: { amount: "58685.00", currency: "CZK" },
            documents: [
              {
                id: demoId(601),
                kind: "invoice",
                number: "2026-0042",
                contact: { id: demoId(201), name: "Nordic Craft s.r.o." },
                currency: "CZK",
                dueOn: "2026-12-05",
                daysOverdue: 0,
                outstanding: { amount: "58685.00", currency: "CZK" },
                outstandingCzk: { amount: "58685.00", currency: "CZK" },
              },
            ],
          },
          {
            bucket: "1_30",
            count: 2,
            total: { amount: "79890.00", currency: "CZK" },
            documents: [
              {
                id: demoId(602),
                kind: "invoice",
                number: "2026-0041",
                contact: { id: demoId(201), name: "Nordic Craft s.r.o." },
                currency: "EUR",
                dueOn: "2026-11-12",
                daysOverdue: 12,
                outstanding: { amount: "2450.00", currency: "EUR" },
                outstandingCzk: { amount: "61740.00", currency: "CZK" },
              },
              {
                id: demoId(603),
                kind: "invoice",
                number: "2026-0038",
                contact: { id: demoId(203), name: "Studio Křivánek s.r.o." },
                currency: "CZK",
                dueOn: "2026-11-20",
                daysOverdue: 4,
                outstanding: { amount: "18150.00", currency: "CZK" },
                outstandingCzk: { amount: "18150.00", currency: "CZK" },
              },
            ],
          },
        ],
        total: { amount: "138575.00", currency: "CZK" },
        overdue: { total: { amount: "79890.00", currency: "CZK" }, count: 2 },
      };
    case "vat_summary":
      return {
        report: "vat_summary",
        period,
        output: [
          {
            month: "2026-11",
            treatment: "standard",
            ratePercent: "21",
            base: { amount: "380000.00", currency: "CZK" },
            vat: { amount: "79800.00", currency: "CZK" },
            documents: [
              { _tag: "Document", id: demoId(601) },
              { _tag: "Document", id: demoId(603) },
            ],
          },
          {
            month: "2026-11",
            treatment: "reverse_charge",
            ratePercent: "21",
            base: { amount: "3024.00", currency: "CZK" },
            vat: { amount: "635.04", currency: "CZK" },
            documents: [{ _tag: "Expense", id: demoId(402) }],
          },
        ],
        input: [
          {
            month: "2026-11",
            treatment: "standard",
            ratePercent: "21",
            base: { amount: "20000.00", currency: "CZK" },
            vat: { amount: "4200.00", currency: "CZK" },
            documents: [{ _tag: "Expense", id: demoId(401) }],
          },
          {
            month: "2026-11",
            treatment: "reverse_charge",
            ratePercent: "21",
            base: { amount: "3024.00", currency: "CZK" },
            vat: { amount: "635.04", currency: "CZK" },
            documents: [{ _tag: "Expense", id: demoId(402) }],
          },
        ],
        totals: {
          output: { amount: "80435.04", currency: "CZK" },
          input: { amount: "4835.04", currency: "CZK" },
          payable: { amount: "75600.00", currency: "CZK" },
        },
      };
    case "profit":
      return {
        report: "profit",
        period,
        rows: [
          {
            month: "2026-10",
            revenue: { amount: "198000.00", currency: "CZK" },
            expenses: { amount: "32000.00", currency: "CZK" },
            profit: { amount: "166000.00", currency: "CZK" },
          },
          {
            month: "2026-11",
            revenue: { amount: "242000.00", currency: "CZK" },
            expenses: { amount: "23024.00", currency: "CZK" },
            profit: { amount: "218976.00", currency: "CZK" },
          },
        ],
        totals: {
          revenue: { amount: "440000.00", currency: "CZK" },
          expenses: { amount: "55024.00", currency: "CZK" },
          profit: { amount: "384976.00", currency: "CZK" },
        },
      };
    default:
      return {
        report: "revenue",
        period,
        groupBy: groupBy ?? "month",
        rows: [
          {
            key: groupBy === "contact" ? demoId(201) : groupBy === "currency" ? "EUR" : "2026-09",
            label:
              groupBy === "contact" ? "Nordic Craft s.r.o." : groupBy === "currency" ? "EUR" : null,
            count: 3,
            net: { amount: "165000.00", currency: "CZK" },
            vat: { amount: "34650.00", currency: "CZK" },
            gross: { amount: "199650.00", currency: "CZK" },
            original: groupBy === "currency" ? { amount: "7922.62", currency: "EUR" } : null,
          },
          {
            key: groupBy === "contact" ? demoId(203) : groupBy === "currency" ? "CZK" : "2026-10",
            label:
              groupBy === "contact"
                ? "Studio Křivánek s.r.o."
                : groupBy === "currency"
                  ? "CZK"
                  : null,
            count: 4,
            net: { amount: "198000.00", currency: "CZK" },
            vat: { amount: "41580.00", currency: "CZK" },
            gross: { amount: "239580.00", currency: "CZK" },
            original: groupBy === "currency" ? { amount: "239580.00", currency: "CZK" } : null,
          },
          {
            key: groupBy === "contact" ? "other" : groupBy === "currency" ? "USD" : "2026-11",
            label:
              groupBy === "contact" ? "Ostatní klienti" : groupBy === "currency" ? "USD" : null,
            count: 5,
            net: { amount: "242000.00", currency: "CZK" },
            vat: { amount: "50820.00", currency: "CZK" },
            gross: { amount: "292820.00", currency: "CZK" },
            original: groupBy === "currency" ? { amount: "12460.00", currency: "USD" } : null,
          },
        ],
        totals: {
          count: 12,
          net: { amount: "605000.00", currency: "CZK" },
          vat: { amount: "127050.00", currency: "CZK" },
          gross: { amount: "732050.00", currency: "CZK" },
        },
      };
  }
};

// --- Routes --------------------------------------------------------------------------------------

export const routes: ReadonlyArray<DemoRoute> = [
  // Contacts
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/contacts",
    respond: (req) => {
      const text = Str.toLowerCase(Str.trim(req.query.get("text") ?? ""));
      const role = req.query.get("role");
      const items = Arr.filter(contacts, (c) => {
        if (role !== null && !Arr.some(c.roles, (value) => value === role)) return false;
        if (text === "") return true;
        return (
          Str.includes(text)(Str.toLowerCase(c.name)) ||
          Str.includes(text)(c.ico ?? "") ||
          Arr.some(c.billingEmails, (e) => Str.includes(text)(Str.toLowerCase(e)))
        );
      });
      return { items, nextCursor: null };
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/contacts/:contactId",
    respond: (req) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(contacts, (c) => c.id === req.params.contactId),
      );
      return (
        found ?? status(404, { _tag: "NotFound", entity: "Contact", id: req.params.contactId })
      );
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/contacts",
    respond: (req) => {
      const decoded = decodeContact(req.body ?? {});
      if (decoded._tag === "Failure") return malformedBody();
      const body = decoded.success;
      const created: DemoContact = {
        id: nextId(),
        roles: body.roles ?? ["customer"],
        name: body.name ?? "Nový kontakt",
        ico: body.ico ?? null,
        dic: body.dic ?? null,
        legalForm: body.legalForm ?? null,
        address: {
          street: body.address?.street ?? null,
          city: body.address?.city ?? null,
          postalCode: body.address?.postalCode ?? null,
          country: body.address?.country ?? "CZ",
        },
        billingEmails: body.billingEmails ?? [],
        phone: body.phone ?? null,
        note: body.note ?? null,
        defaults: body.defaults ?? {
          reminderPolicy: { mode: "inherit" },
        },
        registryFetchedAt: null,
        archived: false,
        revision: 1,
      };
      contacts.unshift(created);
      return status(201, created);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/contacts/:contactId",
    respond: (req) => {
      const idx = Option.getOrElse(
        Arr.findFirstIndex(contacts, (c) => c.id === req.params.contactId),
        () => -1,
      );
      const existing = contacts[idx];
      if (existing === undefined) {
        return status(404, { _tag: "NotFound", entity: "Contact", id: req.params.contactId });
      }
      const decoded = decodeContact(req.body ?? {});
      if (decoded._tag === "Failure") return malformedBody();
      const {
        roles,
        name,
        ico = existing.ico,
        dic = existing.dic,
        legalForm = existing.legalForm,
        address,
        billingEmails,
        phone = existing.phone,
        note = existing.note,
        defaults,
      } = decoded.success;
      const updated: DemoContact = {
        ...existing,
        roles: roles ?? existing.roles,
        name: name ?? existing.name,
        ico,
        dic,
        legalForm,
        address: {
          ...existing.address,
          ...address,
          country: address?.country ?? existing.address.country,
        },
        billingEmails: billingEmails ?? existing.billingEmails,
        phone,
        note,
        defaults: defaults ?? existing.defaults,
        revision: existing.revision + 1,
      };
      contacts[idx] = updated;
      return updated;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/contacts/from-ico",
    respond: (req) => {
      const decoded = decodeFromIco(req.body);
      if (decoded._tag === "Failure") return malformedBody();
      const ico = Str.replace(/\s/g, "")(decoded.success.ico);
      const existing = Option.getOrUndefined(Arr.findFirst(contacts, (c) => c.ico === ico));
      if (existing !== undefined) {
        existing.registryFetchedAt = nowIso();
        return existing;
      }
      const created: DemoContact = {
        id: nextId(),
        roles: [decoded.success.role ?? "customer"],
        name: `ARES Společnost ${ico} s.r.o.`,
        ico,
        dic: `CZ${ico}`,
        legalForm: "Společnost s ručením omezeným",
        address: {
          street: "Václavské náměstí 1",
          city: "Praha 1",
          postalCode: "110 00",
          country: "CZ",
        },
        billingEmails: [],
        phone: null,
        note: null,
        defaults: { reminderPolicy: { mode: "inherit" } },
        registryFetchedAt: nowIso(),
        archived: false,
        revision: 1,
      };
      contacts.unshift(created);
      return created;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/contacts/:contactId/archive",
    respond: (req) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(contacts, (c) => c.id === req.params.contactId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Contact", id: req.params.contactId });
      }
      found.archived = true;
    },
  },

  // Price List
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/price-list-items",
    respond: (req) => {
      const text = Str.toLowerCase(Str.trim(req.query.get("text") ?? ""));
      const includeArchived = req.query.get("includeArchived") === "true";
      return Arr.filter(priceListItems, (item) => {
        if (!includeArchived && item.archived) return false;
        if (text === "") return true;
        return (
          Str.includes(text)(Str.toLowerCase(item.name)) ||
          Str.includes(text)(Str.toLowerCase(item.description ?? ""))
        );
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/price-list-items",
    respond: (req) => {
      const decoded = decodePriceListItem(req.body ?? {});
      if (decoded._tag === "Failure") return malformedBody();
      const body = decoded.success;
      const created: DemoPriceListItem = {
        id: nextId(),
        name: body.name ?? "Položka",
        description: body.description ?? null,
        unit: body.unit ?? null,
        unitPrice: body.unitPrice ?? "0.00",
        currency: body.currency ?? "CZK",
        vat: body.vat ?? null,
        archived: false,
        revision: 1,
      };
      priceListItems.unshift(created);
      return status(201, created);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/price-list-items/:itemId",
    respond: (req) => {
      const idx = Option.getOrElse(
        Arr.findFirstIndex(priceListItems, (i) => i.id === req.params.itemId),
        () => -1,
      );
      const existing = priceListItems[idx];
      if (existing === undefined) {
        return status(404, { _tag: "NotFound", entity: "PriceListItem", id: req.params.itemId });
      }
      const decoded = decodePriceListItem(req.body ?? {});
      if (decoded._tag === "Failure") return malformedBody();
      const {
        name,
        description = existing.description,
        unit = existing.unit,
        unitPrice = existing.unitPrice,
        currency,
        vat = existing.vat,
      } = decoded.success;
      const updated: DemoPriceListItem = {
        ...existing,
        name: name ?? existing.name,
        description,
        unit,
        unitPrice,
        currency: currency ?? existing.currency,
        vat,
        revision: existing.revision + 1,
      };
      priceListItems[idx] = updated;
      return updated;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/price-list-items/:itemId/archive",
    respond: (req) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(priceListItems, (i) => i.id === req.params.itemId),
      );
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "PriceListItem", id: req.params.itemId });
      }
      found.archived = true;
    },
  },

  // Expenses
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/expenses",
    respond: (req) => {
      const incomplete = req.query.get("incomplete") === "true";
      const items = Arr.map(
        Arr.filter(expenses, (e) => (!incomplete ? true : e.status === "incomplete")),
        toExpenseSummary,
      );
      return { items, nextCursor: null };
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/expenses",
    respond: (req) => {
      const decoded = decodeExpense(req.body ?? {});
      if (decoded._tag === "Failure") return malformedBody();
      const body = decoded.success;
      const now = nowIso();
      const { total = null } = body;
      const created: DemoExpense = {
        id: nextId(),
        revision: 1,
        status: body.status ?? "complete",
        supplier: expenseSupplier(body.supplier),
        supplierDocumentNumber: body.supplierDocumentNumber ?? null,
        issuedOn: body.issuedOn ?? null,
        taxableSupplyOn: body.taxableSupplyOn ?? null,
        dueOn: body.dueOn ?? null,
        currency: body.currency ?? null,
        total,
        vat:
          body.vat === null || body.vat === undefined
            ? null
            : Arr.map(body.vat, ({ treatment, base, vat = "0.00", selfAssessed = null }) => ({
                treatment,
                base,
                vat,
                selfAssessed,
              })),
        totals: null,
        selfAssessed: [],
        fx: null,
        totalCzk: total,
        deductibility: body.deductibility ?? "full",
        deductibleVat: null,
        deductibleVatCzk: null,
        category: body.category ?? null,
        tags: body.tags ?? [],
        note: body.note ?? null,
        attachments: [],
        payment: { settlement: "unpaid", paid: null, payments: 0 },
        createdAt: now,
        updatedAt: now,
      };
      expenses.unshift(created);
      return status(201, created);
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId",
    respond: (req) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(expenses, (e) => e.id === req.params.expenseId),
      );
      return (
        found ?? status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId })
      );
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId",
    respond: (req) => {
      const idx = Option.getOrElse(
        Arr.findFirstIndex(expenses, (e) => e.id === req.params.expenseId),
        () => -1,
      );
      const existing = expenses[idx];
      if (existing === undefined) {
        return status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId });
      }
      const decoded = decodeExpense(req.body ?? {});
      if (decoded._tag === "Failure") return malformedBody();
      const {
        status: expenseStatus = existing.status,
        supplierDocumentNumber = existing.supplierDocumentNumber,
        issuedOn = existing.issuedOn,
        taxableSupplyOn = existing.taxableSupplyOn,
        dueOn = existing.dueOn,
        currency = existing.currency,
        total = existing.total,
        category = existing.category,
        tags,
        note = existing.note,
      } = decoded.success;
      const updated: DemoExpense = {
        ...existing,
        revision: existing.revision + 1,
        status: expenseStatus,
        supplierDocumentNumber,
        issuedOn,
        taxableSupplyOn,
        dueOn,
        currency,
        total,
        category,
        tags: tags ?? existing.tags,
        note,
        updatedAt: nowIso(),
      };
      expenses[idx] = updated;
      return updated;
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId",
    respond: (req) => {
      const idx = Option.getOrElse(
        Arr.findFirstIndex(expenses, (e) => e.id === req.params.expenseId),
        () => -1,
      );
      if (idx < 0)
        return status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId });
      expenses.splice(idx, 1);
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId/attachments",
    respond: (req) => {
      const exp = Option.getOrUndefined(
        Arr.findFirst(expenses, (e) => e.id === req.params.expenseId),
      );
      if (exp === undefined) {
        return status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId });
      }
      const att = {
        id: nextId(),
        expenseId: exp.id,
        name: "doklad-priloha.pdf",
        contentType: "application/pdf",
        bytes: 64200,
        sha256: "demo-sha256-upload",
        createdAt: nowIso(),
      };
      exp.attachments.push(att);
      exp.revision += 1;
      return status(201, { ...att, expenseRevision: exp.revision });
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId/attachments/:attachmentId",
    respond: () => status(200, { ok: true }),
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId/attachments/:attachmentId",
    respond: (req) => {
      const exp = Option.getOrUndefined(
        Arr.findFirst(expenses, (e) => e.id === req.params.expenseId),
      );
      if (exp === undefined) {
        return status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId });
      }
      exp.attachments = Arr.filter(exp.attachments, (a) => a.id !== req.params.attachmentId);
    },
  },

  // Expense payments
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId/payments",
    respond: (req) => Arr.filter(expensePayments, (p) => p.target.expense === req.params.expenseId),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/payments",
    respond: (req) => {
      const decoded = decodePayment(req.body);
      if (decoded._tag === "Failure") return malformedBody();
      const { target, amount, paidOn, method, note } = decoded.success;
      const expenseId = "expense" in target ? target.expense : "";
      const exp = Option.getOrUndefined(Arr.findFirst(expenses, (e) => e.id === expenseId));
      if (exp === undefined) {
        return status(404, { _tag: "NotFound", entity: "Expense", id: expenseId });
      }
      const payment: DemoPayment = {
        id: nextId(),
        revision: 1,
        target: { expense: exp.id },
        amount: amount ?? { amount: exp.total ?? "0.00", currency: exp.currency ?? "CZK" },
        paidOn: paidOn ?? Str.slice(0, 10)(nowIso()),
        method: method ?? "bank_transfer",
        note: note ?? null,
        taxDocument: null,
        createdAt: nowIso(),
      };
      expensePayments.unshift(payment);
      recomputeExpensePayment(exp);
      return status(201, {
        payment,
        settlement: exp.payment.settlement === "unpaid" ? "paid" : exp.payment.settlement,
        issued: [],
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/payments/:paymentId/remove",
    respond: (req) => {
      const idx = Option.getOrElse(
        Arr.findFirstIndex(expensePayments, (p) => p.id === req.params.paymentId),
        () => -1,
      );
      const removed = expensePayments[idx];
      if (removed === undefined) {
        return status(404, { _tag: "NotFound", entity: "Payment", id: req.params.paymentId });
      }
      expensePayments.splice(idx, 1);
      const exp = Option.getOrUndefined(
        Arr.findFirst(expenses, (e) => e.id === removed.target.expense),
      );
      if (exp !== undefined) recomputeExpensePayment(exp);
    },
  },

  // Reports & CNB FX
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/reports/:report",
    respond: (req) =>
      buildDemoReport(
        req.params.report ?? "revenue",
        req.query.get("from") ?? "2026-01-01",
        req.query.get("to") ?? "2026-12-31",
        req.query.get("groupBy") ?? undefined,
      ),
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/reports/:report/export",
    respond: (req) => ({
      report: req.params.report ?? "revenue",
      format: req.query.get("format") ?? "csv",
      exported: true,
    }),
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/fx-rates/:currency",
    respond: (req) => {
      const currency = req.params.currency ?? "EUR";
      const rates = new Map([
        ["EUR", "25.20"],
        ["USD", "23.45"],
        ["GBP", "29.80"],
        ["PLN", "5.85"],
        ["CHF", "26.90"],
      ]);
      return {
        currency,
        rate: rates.get(currency) ?? "25.00",
        quantity: 1,
        fixingDate: req.query.get("on") ?? "2026-11-24",
        source: "cnb",
      };
    },
  },
];
