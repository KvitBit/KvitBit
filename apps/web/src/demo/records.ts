/**
 * Demo API handlers for the `records` page group (Expenses, Contacts, Price List, Reports, FX,
 * and Expense Payments). Returns encoded wire JSON matching @kvitbit/api-contract and core views.
 */
import { type DemoRoute, status } from "./router";
import { demoId } from "./shell";

// --- Seeded demo fixtures ------------------------------------------------------------------------

let nextSeq = 500;
const nextId = (): string => demoId(++nextSeq);

interface DemoContact {
  id: string;
  roles: Array<"customer" | "supplier">;
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
  billingEmails: Array<string>;
  phone: string | null;
  note: string | null;
  defaults: Record<string, unknown>;
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
      currency: "EUR",
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
  totals: Record<string, unknown> | null;
  selfAssessed: Array<Record<string, unknown>>;
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
  tags: Array<string>;
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
  const pays = expensePayments.filter((p) => p.target.expense === exp.id);
  const sum = pays.reduce((acc, p) => acc + Number(p.amount.amount), 0);
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
        incomplete: expenses.filter((e) => e.status === "incomplete").length,
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
      const text = (req.query.get("text") ?? "").trim().toLowerCase();
      const role = req.query.get("role");
      const items = contacts.filter((c) => {
        if (role !== null && !c.roles.includes(role as "customer" | "supplier")) return false;
        if (text === "") return true;
        return (
          c.name.toLowerCase().includes(text) ||
          (c.ico ?? "").includes(text) ||
          c.billingEmails.some((e) => e.toLowerCase().includes(text))
        );
      });
      return { items, nextCursor: null };
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/contacts/:contactId",
    respond: (req) => {
      const found = contacts.find((c) => c.id === req.params.contactId);
      return (
        found ?? status(404, { _tag: "NotFound", entity: "Contact", id: req.params.contactId })
      );
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/contacts",
    respond: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const created: DemoContact = {
        id: nextId(),
        roles: (body.roles as Array<"customer" | "supplier">) ?? ["customer"],
        name: String(body.name ?? "Nový kontakt"),
        ico: (body.ico as string | null) ?? null,
        dic: (body.dic as string | null) ?? null,
        legalForm: (body.legalForm as string | null) ?? null,
        address: {
          street:
            ((body.address as Record<string, unknown> | undefined)?.street as string | null) ??
            null,
          city:
            ((body.address as Record<string, unknown> | undefined)?.city as string | null) ?? null,
          postalCode:
            ((body.address as Record<string, unknown> | undefined)?.postalCode as string | null) ??
            null,
          country: String((body.address as Record<string, unknown> | undefined)?.country ?? "CZ"),
        },
        billingEmails: Array.isArray(body.billingEmails)
          ? (body.billingEmails as Array<string>)
          : [],
        phone: (body.phone as string | null) ?? null,
        note: (body.note as string | null) ?? null,
        defaults: (body.defaults as Record<string, unknown>) ?? {
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
      const idx = contacts.findIndex((c) => c.id === req.params.contactId);
      if (idx < 0)
        return status(404, { _tag: "NotFound", entity: "Contact", id: req.params.contactId });
      // biome-ignore lint/style/noNonNullAssertion: idx checked above
      const existing = contacts[idx]!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated: DemoContact = {
        ...existing,
        roles: (body.roles as Array<"customer" | "supplier">) ?? existing.roles,
        name: typeof body.name === "string" ? body.name : existing.name,
        ico: body.ico !== undefined ? (body.ico as string | null) : existing.ico,
        dic: body.dic !== undefined ? (body.dic as string | null) : existing.dic,
        legalForm:
          body.legalForm !== undefined ? (body.legalForm as string | null) : existing.legalForm,
        address:
          typeof body.address === "object" && body.address !== null
            ? { ...existing.address, ...(body.address as Partial<DemoContact["address"]>) }
            : existing.address,
        billingEmails: Array.isArray(body.billingEmails)
          ? (body.billingEmails as Array<string>)
          : existing.billingEmails,
        phone: body.phone !== undefined ? (body.phone as string | null) : existing.phone,
        note: body.note !== undefined ? (body.note as string | null) : existing.note,
        defaults: (body.defaults as Record<string, unknown>) ?? existing.defaults,
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
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ico = String(body.ico ?? "").replace(/\s/g, "");
      const existing = contacts.find((c) => c.ico === ico);
      if (existing !== undefined) {
        existing.registryFetchedAt = new Date().toISOString();
        return existing;
      }
      const created: DemoContact = {
        id: nextId(),
        roles: [body.role === "supplier" ? "supplier" : "customer"],
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
        registryFetchedAt: new Date().toISOString(),
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
      const found = contacts.find((c) => c.id === req.params.contactId);
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "Contact", id: req.params.contactId });
      }
      found.archived = true;
      return undefined;
    },
  },

  // Price List
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/price-list-items",
    respond: (req) => {
      const text = (req.query.get("text") ?? "").trim().toLowerCase();
      const includeArchived = req.query.get("includeArchived") === "true";
      return priceListItems.filter((item) => {
        if (!includeArchived && item.archived) return false;
        if (text === "") return true;
        return (
          item.name.toLowerCase().includes(text) ||
          (item.description ?? "").toLowerCase().includes(text)
        );
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/price-list-items",
    respond: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const created: DemoPriceListItem = {
        id: nextId(),
        name: String(body.name ?? "Položka"),
        description: (body.description as string | null) ?? null,
        unit: (body.unit as string | null) ?? null,
        unitPrice: String(body.unitPrice ?? "0.00"),
        currency: String(body.currency ?? "CZK"),
        vat: (body.vat as string | null) ?? null,
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
      const idx = priceListItems.findIndex((i) => i.id === req.params.itemId);
      if (idx < 0)
        return status(404, { _tag: "NotFound", entity: "PriceListItem", id: req.params.itemId });
      // biome-ignore lint/style/noNonNullAssertion: idx checked above
      const existing = priceListItems[idx]!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated: DemoPriceListItem = {
        ...existing,
        name: typeof body.name === "string" ? body.name : existing.name,
        description:
          body.description !== undefined
            ? (body.description as string | null)
            : existing.description,
        unit: body.unit !== undefined ? (body.unit as string | null) : existing.unit,
        unitPrice: body.unitPrice !== undefined ? String(body.unitPrice) : existing.unitPrice,
        currency: typeof body.currency === "string" ? body.currency : existing.currency,
        vat: body.vat !== undefined ? (body.vat as string | null) : existing.vat,
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
      const found = priceListItems.find((i) => i.id === req.params.itemId);
      if (found === undefined) {
        return status(404, { _tag: "NotFound", entity: "PriceListItem", id: req.params.itemId });
      }
      found.archived = true;
      return undefined;
    },
  },

  // Expenses
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/expenses",
    respond: (req) => {
      const incomplete = req.query.get("incomplete") === "true";
      const items = expenses
        .filter((e) => (!incomplete ? true : e.status === "incomplete"))
        .map(toExpenseSummary);
      return { items, nextCursor: null };
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/expenses",
    respond: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const now = new Date().toISOString();
      const supRaw = body.supplier as Record<string, unknown> | null | undefined;
      const supplier =
        supRaw && typeof supRaw === "object" && "manual" in supRaw
          ? {
              contactId: null,
              name: ((supRaw.manual as Record<string, unknown>).name as string | null) ?? null,
              ico: ((supRaw.manual as Record<string, unknown>).ico as string | null) ?? null,
              dic: ((supRaw.manual as Record<string, unknown>).dic as string | null) ?? null,
            }
          : supRaw && typeof supRaw === "object" && "contact" in supRaw
            ? (() => {
                const c = contacts.find((x) => x.id === supRaw.contact);
                return c ? { contactId: c.id, name: c.name, ico: c.ico, dic: c.dic } : null;
              })()
            : null;
      const created: DemoExpense = {
        id: nextId(),
        revision: 1,
        status: body.status === "incomplete" ? "incomplete" : "complete",
        supplier,
        supplierDocumentNumber: (body.supplierDocumentNumber as string | null) ?? null,
        issuedOn: (body.issuedOn as string | null) ?? null,
        taxableSupplyOn: (body.taxableSupplyOn as string | null) ?? null,
        dueOn: (body.dueOn as string | null) ?? null,
        currency: (body.currency as string | null) ?? null,
        total: body.total !== undefined && body.total !== null ? String(body.total) : null,
        vat: (body.vat as DemoExpense["vat"]) ?? null,
        totals: null,
        selfAssessed: [],
        fx: null,
        totalCzk: body.total !== undefined && body.total !== null ? String(body.total) : null,
        deductibility: (body.deductibility as DemoExpense["deductibility"]) ?? "full",
        deductibleVat: null,
        deductibleVatCzk: null,
        category: (body.category as string | null) ?? null,
        tags: Array.isArray(body.tags) ? (body.tags as Array<string>) : [],
        note: (body.note as string | null) ?? null,
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
      const found = expenses.find((e) => e.id === req.params.expenseId);
      return (
        found ?? status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId })
      );
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId",
    respond: (req) => {
      const idx = expenses.findIndex((e) => e.id === req.params.expenseId);
      if (idx < 0)
        return status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId });
      // biome-ignore lint/style/noNonNullAssertion: idx checked above
      const existing = expenses[idx]!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated: DemoExpense = {
        ...existing,
        revision: existing.revision + 1,
        status:
          body.status === "incomplete" || body.status === "complete"
            ? body.status
            : existing.status,
        supplierDocumentNumber:
          body.supplierDocumentNumber !== undefined
            ? (body.supplierDocumentNumber as string | null)
            : existing.supplierDocumentNumber,
        issuedOn:
          body.issuedOn !== undefined ? (body.issuedOn as string | null) : existing.issuedOn,
        taxableSupplyOn:
          body.taxableSupplyOn !== undefined
            ? (body.taxableSupplyOn as string | null)
            : existing.taxableSupplyOn,
        dueOn: body.dueOn !== undefined ? (body.dueOn as string | null) : existing.dueOn,
        currency:
          body.currency !== undefined ? (body.currency as string | null) : existing.currency,
        total:
          body.total !== undefined
            ? body.total === null
              ? null
              : String(body.total)
            : existing.total,
        category:
          body.category !== undefined ? (body.category as string | null) : existing.category,
        tags: Array.isArray(body.tags) ? (body.tags as Array<string>) : existing.tags,
        note: body.note !== undefined ? (body.note as string | null) : existing.note,
        updatedAt: new Date().toISOString(),
      };
      expenses[idx] = updated;
      return updated;
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId",
    respond: (req) => {
      const idx = expenses.findIndex((e) => e.id === req.params.expenseId);
      if (idx < 0)
        return status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId });
      expenses.splice(idx, 1);
      return undefined;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId/attachments",
    respond: (req) => {
      const exp = expenses.find((e) => e.id === req.params.expenseId);
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
        createdAt: new Date().toISOString(),
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
      const exp = expenses.find((e) => e.id === req.params.expenseId);
      if (exp === undefined) {
        return status(404, { _tag: "NotFound", entity: "Expense", id: req.params.expenseId });
      }
      exp.attachments = exp.attachments.filter((a) => a.id !== req.params.attachmentId);
      return undefined;
    },
  },

  // Expense payments
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/expenses/:expenseId/payments",
    respond: (req) => expensePayments.filter((p) => p.target.expense === req.params.expenseId),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/payments",
    respond: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = (body.target ?? {}) as Record<string, unknown>;
      const expenseId = typeof target.expense === "string" ? target.expense : "";
      const exp = expenses.find((e) => e.id === expenseId);
      if (exp === undefined) {
        return status(404, { _tag: "NotFound", entity: "Expense", id: expenseId });
      }
      const amtRaw = (body.amount ?? {}) as Record<string, unknown>;
      const payment: DemoPayment = {
        id: nextId(),
        revision: 1,
        target: { expense: exp.id },
        amount: {
          amount: amtRaw.amount !== undefined ? String(amtRaw.amount) : (exp.total ?? "0.00"),
          currency: typeof amtRaw.currency === "string" ? amtRaw.currency : (exp.currency ?? "CZK"),
        },
        paidOn:
          typeof body.paidOn === "string" ? body.paidOn : new Date().toISOString().slice(0, 10),
        method: typeof body.method === "string" ? body.method : "bank_transfer",
        note: typeof body.note === "string" ? body.note : null,
        taxDocument: null,
        createdAt: new Date().toISOString(),
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
      const idx = expensePayments.findIndex((p) => p.id === req.params.paymentId);
      if (idx < 0)
        return status(404, { _tag: "NotFound", entity: "Payment", id: req.params.paymentId });
      // biome-ignore lint/style/noNonNullAssertion: idx checked above
      const removed = expensePayments[idx]!;
      expensePayments.splice(idx, 1);
      const exp = expenses.find((e) => e.id === removed.target.expense);
      if (exp !== undefined) recomputeExpensePayment(exp);
      return undefined;
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
      const rates: Record<string, string> = {
        EUR: "25.20",
        USD: "23.45",
        GBP: "29.80",
        PLN: "5.85",
        CHF: "26.90",
      };
      return {
        currency,
        rate: rates[currency] ?? "25.00",
        quantity: 1,
        fixingDate: req.query.get("on") ?? "2026-11-24",
        source: "cnb",
      };
    },
  },
];
