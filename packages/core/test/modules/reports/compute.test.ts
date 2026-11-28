import { describe, expect, test } from "bun:test";
import { IsoDate } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { ReportCompute } from "../../../src/modules/reports";
import type { VatSummaryView } from "../../../src/modules/reports/views";
import { regimeOn as workspaceRegimeOn } from "../../../src/modules/workspaces";
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

const NOV = { from: IsoDate.make("2026-11-01"), to: IsoDate.make("2026-11-30") };
const PAYER = [{ effectiveFrom: IsoDate.make("2020-01-01"), regime: "vat_payer" as const }];

const line = (l: VatSummaryView["output"][number]) => ({
  month: l.month,
  treatment: l.treatment,
  rate: s(l.ratePercent),
  base: s(l.base),
  vat: s(l.vat),
  documents: EffectArray.map(l.documents, (ref) => ref.id),
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
      taxPoint: IsoDate.make("2026-11-10"),
      buckets: [bucket("standard", "21", "100", "21", "527.63")],
    }),
    // Credit Note: signed negative
    document(3, {
      kind: "credit_note",
      taxPoint: IsoDate.make("2026-11-12"),
      buckets: [bucket("standard", "21", "-200", "-42")],
    }),
    // reverse charge: base only
    document(4, {
      taxPoint: IsoDate.make("2026-11-15"),
      buckets: [bucket("reverse_charge", "0", "3000", "0")],
    }),
    // Final Invoice: full totals minus the advance already taxed on the PTD
    document(5, {
      finalInvoice: true,
      taxPoint: IsoDate.make("2026-11-20"),
      buckets: [bucket("standard", "21", "2000", "420")],
      advanceDeductions: [bucket("standard", "21", "1000", "210")],
    }),
    // the Payment Tax Document for that advance
    document(6, {
      kind: "payment_tax_document",
      taxPoint: IsoDate.make("2026-11-03"),
      buckets: [bucket("standard", "21", "1000", "210")],
    }),
    // excluded: Proforma, cancelled, outside the period
    document(7, { kind: "proforma", taxPoint: null }),
    document(8, { status: "cancelled" }),
    document(9, { taxPoint: IsoDate.make("2026-12-01") }),
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
    expense(5, { taxPoint: IsoDate.make("2026-10-31") }),
  ];

  const view = ReportCompute.vatSummary(documents, expenses, PAYER, NOV);

  test("output VAT per rate bucket in CZK, credit notes and final-invoice advances netted", () => {
    expect(EffectArray.map(view.output, line)).toEqual([
      {
        month: "2026-11",
        treatment: "standard",
        rate: "21",
        // 1000 + 2512.50 - 200 + (2000 - 1000) + 1000 + 2500 (self-assessed)
        base: "7812.5",
        // 210 + 527.63 - 42 + (420 - 210) + 210 + 525
        vat: "1640.63",
        documents: EffectArray.sort(
          [docId(1), docId(2), docId(3), docId(5), docId(6), expenseId(2)],
          Order.String,
        ),
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
    expect(EffectArray.map(view.input, line)).toEqual([
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
    const q = { from: IsoDate.make("2026-10-01"), to: IsoDate.make("2026-11-30") };
    const v = ReportCompute.vatSummary(
      [document(1), document(2, { taxPoint: IsoDate.make("2026-10-31") })],
      [],
      PAYER,
      q,
    );
    expect(EffectArray.map(v.output, (l) => [l.month, s(l.vat)])).toEqual([
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
      PAYER,
      NOV,
    );
    // 2.1 x 24.5 = 51.45; base 245
    expect(EffectArray.map(v.output, (l) => [s(l.base), s(l.vat)])).toEqual([["245", "51.45"]]);
  });

  test("rates differing within a treatment stay separate buckets, higher rate first", () => {
    const v = ReportCompute.vatSummary(
      [
        document(1, { buckets: [bucket("reduced", "10", "100", "10")] }),
        document(2, { buckets: [bucket("reduced", "15", "100", "15")] }),
      ],
      [],
      PAYER,
      NOV,
    );
    expect(EffectArray.map(v.output, (l) => s(l.ratePercent))).toEqual(["15", "10"]);
  });
});

describe("receivables aging", () => {
  const asOf = IsoDate.make("2026-11-23");
  const due = (n: number, dueOn: string | null) =>
    document(n, { dueOn: dueOn === null ? null : IsoDate.make(dueOn), outstanding: d("100") });

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
      EffectArray.map(cases, ([dueOn], i) => due(i + 1, dueOn)),
      NOV,
      asOf,
    );
    const placed = new Map<string, string>();
    for (const b of view.buckets) for (const r of b.documents) placed.set(r.id, b.bucket);
    expect(EffectArray.map(cases, (_, i) => placed.get(docId(i + 1)))).toEqual(
      EffectArray.map(cases, ([, b]) => b),
    );
    expect(EffectArray.map(view.buckets, (b) => [b.bucket, b.count])).toEqual([
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
        document(1, { dueOn: IsoDate.make("2026-11-20"), outstanding: d("50") }),
        document(2, {
          currency: EUR,
          fx: fx("25.3"),
          dueOn: IsoDate.make("2026-11-10"),
          outstanding: d("10.01"),
        }),
        document(3, { dueOn: IsoDate.make("2026-11-20"), outstanding: d("0") }),
      ],
      NOV,
      asOf,
    );
    const rows =
      Option.getOrUndefined(EffectArray.findFirst(view.buckets, (b) => b.bucket === "1_30"))
        ?.documents ?? [];
    expect(
      EffectArray.map(rows, (r) => [r.id, r.daysOverdue, s(r.outstanding), s(r.outstandingCzk)]),
    ).toEqual([
      [docId(2), 13, "10.01", "253.25"], // 10.01 x 25.3 = 253.253
      [docId(1), 3, "50", "50"],
    ]);
  });
});

describe("revenue", () => {
  const documents = [
    document(1, {
      issuedOn: IsoDate.make("2026-11-02"),
      contact: { id: contactId(2), name: "Beta" },
    }),
    document(2, {
      currency: EUR,
      fx: fx("25"),
      issuedOn: IsoDate.make("2026-11-03"),
      buckets: [bucket("standard", "21", "100", "21", "525")],
    }),
    document(3, { kind: "credit_note", buckets: [bucket("standard", "21", "-100", "-21")] }),
    document(4, { kind: "proforma" }),
    document(5, { kind: "payment_tax_document" }),
    document(6, { finalInvoice: true, issuedOn: IsoDate.make("2026-10-30") }),
    document(7, { status: "cancelled" }),
  ];

  test("by currency: Credit Notes subtract, Proformas and PTDs excluded", () => {
    const view = ReportCompute.revenue(documents, NOV, "currency");
    expect(
      EffectArray.map(view.rows, (r) => [
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
    expect(EffectArray.map(view.rows, (r) => [r.key, r.label, r.count])).toEqual([
      [contactId(1), "Odběratel s.r.o.", 2],
      [contactId(2), "Beta", 1],
    ]);
  });

  test("Final Invoices count once, in full, by issue date", () => {
    const oct = { from: IsoDate.make("2026-10-01"), to: IsoDate.make("2026-10-31") };
    const view = ReportCompute.revenue(documents, oct, "month");
    expect(EffectArray.map(view.rows, (r) => [r.key, s(r.net)])).toEqual([["2026-10", "1000"]]);
  });
});

describe("cashflow", () => {
  test("payments in vs out per month by payment date, CZK at the target's rate, empty months zero", () => {
    const q = { from: IsoDate.make("2026-09-15"), to: IsoDate.make("2026-11-30") };
    const view = ReportCompute.cashflow(
      [
        payment(1, "in", "2026-09-15", "1000"),
        payment(2, "in", "2026-11-01", "10", EUR, fx("25.1")),
        payment(3, "out", "2026-11-30", "300"),
        payment(4, "in", "2026-12-01", "999"),
      ],
      q,
    );
    expect(EffectArray.map(view.points, (p) => [p.month, s(p.in), s(p.out), s(p.net)])).toEqual([
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
    expect(EffectArray.map(byCategory.rows, (r) => [r.key, r.label, s(r.net)])).toEqual([
      ["", null, "50"],
      ["software", "software", "400"],
    ]);
    expect(byCategory.incomplete).toBe(2);
    const p = ReportCompute.profit([document(1)], records, PAYER, {
      from: IsoDate.make("2026-10-01"),
      to: IsoDate.make("2026-11-30"),
    });
    expect(
      EffectArray.map(p.rows, (r) => [r.month, s(r.revenue), s(r.expenses), s(r.profit)]),
    ).toEqual([
      ["2026-10", "0", "0", "0"],
      ["2026-11", "1000", "450", "550"],
    ]);
  });
});

describe("months", () => {
  test("twelve months ending at period.to, oldest first", () => {
    const w = ReportCompute.twelveMonthsEnding(IsoDate.make("2026-02-10"));
    if (w === null) throw new Error("window");
    expect([w.from, w.months[0], w.months[11], w.months.length]).toEqual([
      "2025-03-01",
      "2025-03",
      "2026-02",
      12,
    ]);
  });
});

describe("regimeOn (W2, same resolution as Workspaces)", () => {
  const periods = [
    { effectiveFrom: IsoDate.make("2026-11-23"), regime: "vat_payer" as const },
    { effectiveFrom: IsoDate.make("2027-01-01"), regime: "non_vat_payer" as const },
  ];
  test("latest period on or before the date; before the first, the first period's regime", () => {
    expect(ReportCompute.regimeOn(periods, IsoDate.make("2026-11-01"))).toBe("vat_payer");
    expect(ReportCompute.regimeOn(periods, IsoDate.make("2026-12-31"))).toBe("vat_payer");
    expect(ReportCompute.regimeOn(periods, IsoDate.make("2027-01-01"))).toBe("non_vat_payer");
    expect(ReportCompute.regimeOn([], IsoDate.make("2026-11-01"))).toBe("non_vat_payer");
  });
  test("two entries effective the same day: the last in stored order wins, before and on it", () => {
    // A regime changed on the Workspace's creation day keeps the creation baseline first.
    const tie = [
      { effectiveFrom: IsoDate.make("2026-11-23"), regime: "non_vat_payer" as const },
      { effectiveFrom: IsoDate.make("2026-11-23"), regime: "vat_payer" as const },
      { effectiveFrom: IsoDate.make("2027-01-01"), regime: "identified_person" as const },
    ];
    for (const date of ["2026-11-01", "2026-11-23", "2026-12-31", "2027-01-01"]) {
      const day = IsoDate.make(date);
      expect(ReportCompute.regimeOn(tie, day)).toBe(workspaceRegimeOn(tie, day));
    }
    expect(ReportCompute.regimeOn(tie, IsoDate.make("2026-11-23"))).toBe("vat_payer");
    // Before the first day: the first stored entry's regime, as in Workspaces.
    expect(ReportCompute.regimeOn(tie, IsoDate.make("2026-11-01"))).toBe("non_vat_payer");
  });
});
