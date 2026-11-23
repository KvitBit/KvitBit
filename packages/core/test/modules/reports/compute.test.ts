import { describe, expect, test } from "bun:test";
import type { IsoDate } from "@kvitbit/domain/contract";
import { ReportCompute } from "../../../src/modules/reports";
import {
  bucket,
  contactId,
  d,
  docId,
  document,
  EUR,
  expense,
  expenseId,
  fx,
  payment,
  s,
} from "./fixtures";

const NOV = { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate };

const line = (l: {
  month: string;
  treatment: string;
  ratePercent: unknown;
  base: { amount: never } | unknown;
  vat: unknown;
  documents: ReadonlyArray<string>;
}) => ({
  month: l.month,
  treatment: l.treatment,
  rate: s(l.ratePercent as never),
  base: s(l.base as never),
  vat: s(l.vat as never),
  documents: l.documents,
});

describe("vatSummary", () => {
  const documents = [
    // CZK, two rates
    document(1, {
      buckets: [bucket("standard", "21", "1000", "210"), bucket("reduced", "12", "500", "60")],
    }),
    // EUR at 25.125: base converted, bucket vatCzk taken as stored (21 x 25.125 = 527.625 -> 527.63)
    document(2, {
      currency: EUR,
      fx: fx("25.125"),
      taxPoint: "2026-11-10" as IsoDate,
      buckets: [bucket("standard", "21", "100", "21", "527.63")],
    }),
    // Credit Note: signed negative
    document(3, {
      kind: "credit_note",
      taxPoint: "2026-11-12" as IsoDate,
      buckets: [bucket("standard", "21", "-200", "-42")],
    }),
    // reverse charge: base only
    document(4, {
      taxPoint: "2026-11-15" as IsoDate,
      buckets: [bucket("reverse_charge", "0", "3000", "0")],
    }),
    // Final Invoice: full totals minus the advance already taxed on the PTD
    document(5, {
      finalInvoice: true,
      taxPoint: "2026-11-20" as IsoDate,
      buckets: [bucket("standard", "21", "2000", "420")],
      advanceDeductions: [bucket("standard", "21", "1000", "210")],
    }),
    // the Payment Tax Document for that advance
    document(6, {
      kind: "payment_tax_document",
      taxPoint: "2026-11-03" as IsoDate,
      buckets: [bucket("standard", "21", "1000", "210")],
    }),
    // excluded: Proforma, cancelled, outside the period
    document(7, { kind: "proforma", taxPoint: null }),
    document(8, { status: "cancelled" }),
    document(9, { taxPoint: "2026-12-01" as IsoDate }),
  ];
  const expenses = [
    expense(1),
    // EU service, reverse charge: supplier bucket at vat 0, self-assessed 21 % (output and input)
    expense(2, {
      currency: EUR,
      fx: fx("25"),
      buckets: [bucket("reverse_charge", "0", "100", "0", "0")],
      selfAssessed: [bucket("standard", "21", "100", "21", "525")],
    }),
    // outside scope: no input VAT line
    expense(3, { buckets: [bucket("outside_scope", "0", "999", "0")] }),
    // 50 % deductible: 12.33 x 0.5 = 6.165 -> 6.17 (half away from zero, once per bucket)
    expense(4, {
      deductiblePercent: 50,
      buckets: [bucket("reduced", "12", "102.75", "12.33")],
    }),
    expense(5, { taxPoint: "2026-10-31" as IsoDate }),
  ];

  const view = ReportCompute.vatSummary(documents, expenses, NOV);

  test("output VAT per rate bucket in CZK, credit notes and final-invoice advances netted", () => {
    expect(view.output.map(line)).toEqual([
      {
        month: "2026-11",
        treatment: "standard",
        rate: "21",
        // 1000 + 2512.50 - 200 + (2000 - 1000) + 1000 + 2500 (self-assessed)
        base: "7812.5",
        // 210 + 527.63 - 42 + (420 - 210) + 210 + 525
        vat: "1640.63",
        documents: [docId(1), docId(2), docId(3), docId(5), docId(6), expenseId(2)].sort(),
      },
      {
        month: "2026-11",
        treatment: "reduced",
        rate: "12",
        base: "500",
        vat: "60",
        documents: [docId(1)],
      },
      {
        month: "2026-11",
        treatment: "reverse_charge",
        rate: "0",
        base: "3000",
        vat: "0",
        documents: [docId(4)],
      },
    ]);
  });

  test("input VAT from expenses, deductible share rounded per bucket", () => {
    expect(view.input.map(line)).toEqual([
      {
        month: "2026-11",
        treatment: "standard",
        rate: "21",
        base: "2900",
        vat: "609",
        documents: [expenseId(1), expenseId(2)],
      },
      {
        month: "2026-11",
        treatment: "reduced",
        rate: "12",
        base: "102.75",
        vat: "6.17",
        documents: [expenseId(4)],
      },
    ]);
  });

  test("totals: payable = output - input", () => {
    expect({
      output: s(view.totals.output),
      input: s(view.totals.input),
      payable: s(view.totals.payable),
      currency: String(view.totals.payable.currency),
    }).toEqual({ output: "1700.63", input: "615.17", payable: "1085.46", currency: "CZK" });
  });

  test("groups by tax point month, oldest first", () => {
    const q = { from: "2026-10-01" as IsoDate, to: "2026-11-30" as IsoDate };
    const v = ReportCompute.vatSummary(
      [document(1), document(2, { taxPoint: "2026-10-31" as IsoDate })],
      [],
      q,
    );
    expect(v.output.map((l) => [l.month, s(l.vat)])).toEqual([
      ["2026-10", "210"],
      ["2026-11", "210"],
    ]);
  });

  test("a non-CZK bucket without stored vatCzk converts with the document's rate", () => {
    const v = ReportCompute.vatSummary(
      [
        document(1, {
          currency: EUR,
          fx: fx("24.5"),
          buckets: [bucket("standard", "21", "10", "2.1")],
        }),
      ],
      [],
      NOV,
    );
    // 2.1 x 24.5 = 51.45; base 245
    expect(v.output.map((l) => [s(l.base), s(l.vat)])).toEqual([["245", "51.45"]]);
  });

  test("rates differing within a treatment stay separate buckets, higher rate first", () => {
    const v = ReportCompute.vatSummary(
      [
        document(1, { buckets: [bucket("reduced", "10", "100", "10")] }),
        document(2, { buckets: [bucket("reduced", "15", "100", "15")] }),
      ],
      [],
      NOV,
    );
    expect(v.output.map((l) => s(l.ratePercent))).toEqual(["15", "10"]);
  });
});

describe("receivables aging", () => {
  const asOf = "2026-11-23" as IsoDate;
  const due = (n: number, dueOn: string | null) =>
    document(n, { dueOn: dueOn as IsoDate | null, outstanding: d("100") });

  test("bucket boundaries: 0 not due, 1-30, 31-60, 61-90, over 90", () => {
    const cases: ReadonlyArray<[string | null, string]> = [
      ["2026-12-31", "not_due"],
      ["2026-11-23", "not_due"],
      [null, "not_due"],
      ["2026-11-22", "1_30"], // 1 day
      ["2026-10-24", "1_30"], // 30 days
      ["2026-10-23", "31_60"], // 31
      ["2026-09-24", "31_60"], // 60
      ["2026-09-23", "61_90"], // 61
      ["2026-08-25", "61_90"], // 90
      ["2026-08-24", "over_90"], // 91
    ];
    const view = ReportCompute.receivables(
      cases.map(([dueOn], i) => due(i + 1, dueOn)),
      NOV,
      asOf,
    );
    const placed = new Map<string, string>();
    for (const b of view.buckets) for (const r of b.documents) placed.set(r.id, b.bucket);
    expect(cases.map((_, i) => placed.get(docId(i + 1)))).toEqual(cases.map(([, b]) => b));
    expect(view.buckets.map((b) => [b.bucket, b.count])).toEqual([
      ["not_due", 3],
      ["1_30", 2],
      ["31_60", 2],
      ["61_90", 2],
      ["over_90", 1],
    ]);
    expect([s(view.total), s(view.overdue.total), view.overdue.count]).toEqual(["1000", "700", 7]);
  });

  test("foreign outstanding in CZK at the document rate; most overdue first", () => {
    const view = ReportCompute.receivables(
      [
        document(1, { dueOn: "2026-11-20" as IsoDate, outstanding: d("50") }),
        document(2, {
          currency: EUR,
          fx: fx("25.3"),
          dueOn: "2026-11-10" as IsoDate,
          outstanding: d("10.01"),
        }),
        document(3, { dueOn: "2026-11-20" as IsoDate, outstanding: d("0") }),
      ],
      NOV,
      asOf,
    );
    const rows = view.buckets.find((b) => b.bucket === "1_30")?.documents ?? [];
    expect(rows.map((r) => [r.id, r.daysOverdue, s(r.outstanding), s(r.outstandingCzk)])).toEqual([
      [docId(2), 13, "10.01", "253.25"], // 10.01 x 25.3 = 253.253
      [docId(1), 3, "50", "50"],
    ]);
  });
});

describe("revenue", () => {
  const documents = [
    document(1, { issuedOn: "2026-11-02" as IsoDate, contact: { id: contactId(2), name: "Beta" } }),
    document(2, {
      currency: EUR,
      fx: fx("25"),
      issuedOn: "2026-11-03" as IsoDate,
      buckets: [bucket("standard", "21", "100", "21", "525")],
    }),
    document(3, { kind: "credit_note", buckets: [bucket("standard", "21", "-100", "-21")] }),
    document(4, { kind: "proforma" }),
    document(5, { kind: "payment_tax_document" }),
    document(6, { finalInvoice: true, issuedOn: "2026-10-30" as IsoDate }),
    document(7, { status: "cancelled" }),
  ];

  test("by currency: Credit Notes subtract, Proformas and PTDs excluded", () => {
    const view = ReportCompute.revenue(documents, NOV, "currency");
    expect(
      view.rows.map((r) => [
        r.key,
        r.count,
        s(r.net),
        s(r.vat),
        s(r.gross),
        r.original && s(r.original),
      ]),
    ).toEqual([
      ["CZK", 2, "900", "189", "1089", "1089"],
      ["EUR", 1, "2500", "525", "3025", "121"],
    ]);
    expect([view.totals.count, s(view.totals.gross)]).toEqual([3, "4114"]);
  });

  test("by contact, sorted by key", () => {
    const view = ReportCompute.revenue(documents, NOV, "contact");
    expect(view.rows.map((r) => [r.key, r.label, r.count])).toEqual([
      [contactId(1), "Odběratel s.r.o.", 2],
      [contactId(2), "Beta", 1],
    ]);
  });

  test("Final Invoices count once, in full, by issue date", () => {
    const oct = { from: "2026-10-01" as IsoDate, to: "2026-10-31" as IsoDate };
    const view = ReportCompute.revenue(documents, oct, "month");
    expect(view.rows.map((r) => [r.key, s(r.net)])).toEqual([["2026-10", "1000"]]);
  });
});

describe("cashflow", () => {
  test("payments in vs out per month by payment date, CZK at the target's rate, empty months zero", () => {
    const q = { from: "2026-09-15" as IsoDate, to: "2026-11-30" as IsoDate };
    const view = ReportCompute.cashflow(
      [
        payment(1, "in", "2026-09-15", "1000"),
        payment(2, "in", "2026-11-01", "10", EUR, fx("25.1")),
        payment(3, "out", "2026-11-30", "300"),
        payment(4, "in", "2026-12-01", "999"),
      ],
      q,
    );
    expect(view.points.map((p) => [p.month, s(p.in), s(p.out), s(p.net)])).toEqual([
      ["2026-09", "1000", "0", "1000"],
      ["2026-10", "0", "0", "0"],
      ["2026-11", "251", "300", "-49"],
    ]);
    expect(s(view.totals.net)).toBe("951");
  });
});

describe("expenses and profit", () => {
  test("expenses by category; profit per month = revenue net - expense net", () => {
    const records = [
      expense(1),
      expense(2, { category: null, buckets: [bucket("outside_scope", "0", "50", "0")] }),
    ];
    const byCategory = ReportCompute.expenses(records, NOV, "category", 2);
    expect(byCategory.rows.map((r) => [r.key, r.label, s(r.net)])).toEqual([
      ["", null, "50"],
      ["software", "software", "400"],
    ]);
    expect(byCategory.incomplete).toBe(2);
    const p = ReportCompute.profit([document(1)], records, {
      from: "2026-10-01" as IsoDate,
      to: "2026-11-30" as IsoDate,
    });
    expect(p.rows.map((r) => [r.month, s(r.revenue), s(r.expenses), s(r.profit)])).toEqual([
      ["2026-10", "0", "0", "0"],
      ["2026-11", "1000", "450", "550"],
    ]);
  });
});

describe("months", () => {
  test("twelve months ending at period.to, oldest first", () => {
    const w = ReportCompute.twelveMonthsEnding("2026-02-10" as IsoDate);
    expect([w.from, w.months[0], w.months[11], w.months.length]).toEqual([
      "2025-03-01",
      "2025-03",
      "2026-02",
      12,
    ]);
  });
});
