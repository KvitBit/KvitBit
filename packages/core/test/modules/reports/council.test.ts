/** Regression cases from the council review of the Reports module. */
import { describe, expect, test } from "bun:test";
import type { CurrencyCode, IsoDate, TaxRegime, UserId } from "@kvitbit/domain/contract";
import { CurrentCaller, Forbidden, Invalid, Reports, Unavailable } from "@kvitbit/domain/contract";
import { Effect, Exit, Layer } from "effect";
import type { ReportsImpl } from "../../../src/modules/reports";
import {
  ExportsRepo,
  ExportsRepoMemory,
  encodeCsv,
  FakeExportWorkflow,
  FakeReportPdfRenderer,
  FxFixingCacheMemory,
  ONE_RUNNING_EXPORT,
  paymentsTable,
  ReportCompute,
  ReportsLive,
  ReportsSourceMemory,
} from "../../../src/modules/reports";
import { CoreStore, UniqueViolation } from "../../../src/store/CoreStore";
import { member, runTest, system, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { bucket, CZK, d, document, EUR, expense, fx, payment, s } from "./fixtures";

const NOV = { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate };
const regime = (r: TaxRegime, from = "2020-01-01") => [
  { effectiveFrom: from as IsoDate, regime: r },
];
const PAYER = regime("vat_payer");

const vatTotals = (v: ReturnType<typeof ReportCompute.vatSummary>) =>
  v.output.map((l) => [l.treatment, s(l.base), s(l.vat)]);

describe("credit notes and advances", () => {
  test("a credited Payment Tax Document without a Final Invoice nets to zero, never revenue", () => {
    const docs = [
      document(10, { kind: "payment_tax_document", taxPoint: "2026-11-03" as IsoDate }),
      document(11, {
        kind: "credit_note",
        correctsKind: "payment_tax_document",
        buckets: [bucket("standard", "21", "-1000", "-210")],
      }),
    ];
    expect(ReportCompute.revenue(docs, NOV, "month").rows).toEqual([]);
    const v = ReportCompute.vatSummary(docs, [], PAYER, NOV);
    expect(vatTotals(v)).toEqual([["standard", "0", "0"]]);
    expect(s(v.totals.output)).toBe("0");
  });

  test("Proforma -> PTD -> Final Invoice fully reversed nets to zero in revenue and VAT", () => {
    const docs = [
      document(20, { kind: "proforma", taxPoint: null }),
      document(21, { kind: "payment_tax_document", taxPoint: "2026-11-02" as IsoDate }),
      document(22, {
        finalInvoice: true,
        buckets: [bucket("standard", "21", "3000", "630")],
        advanceDeductions: [bucket("standard", "21", "1000", "210")],
      }),
      document(23, {
        kind: "credit_note",
        correctsKind: "invoice",
        buckets: [bucket("standard", "21", "-3000", "-630")],
        advanceDeductions: [bucket("standard", "21", "-1000", "-210")],
      }),
      document(24, {
        kind: "credit_note",
        correctsKind: "payment_tax_document",
        buckets: [bucket("standard", "21", "-1000", "-210")],
      }),
    ];
    const rev = ReportCompute.revenue(docs, NOV, "month");
    expect([s(rev.totals.net), s(rev.totals.gross), rev.totals.count]).toEqual(["0", "0", 2]);
    expect(vatTotals(ReportCompute.vatSummary(docs, [], PAYER, NOV))).toEqual([
      ["standard", "0", "0"],
    ]);
  });

  test("a foreign Final Invoice nets advances in its currency, then converts at its own fixing", () => {
    const v = ReportCompute.vatSummary(
      [
        document(30, {
          currency: EUR,
          fx: fx("25.5"),
          finalInvoice: true,
          // stored vatCzk of the full bucket (42 x 25.5) must not be used for the remainder
          buckets: [bucket("standard", "21", "200", "42", "1071")],
          advanceDeductions: [bucket("standard", "21", "100", "21", "525")],
        }),
      ],
      [],
      PAYER,
      NOV,
    );
    // remainder 100 / 21 EUR at 25.5
    expect(vatTotals(v)).toEqual([["standard", "2550", "535.5"]]);
  });
});

describe("Tax Regime eligibility", () => {
  const selfAssessing = expense(2, {
    currency: EUR,
    fx: fx("25"),
    buckets: [bucket("reverse_charge", "0", "100", "0", "0")],
    selfAssessed: [bucket("standard", "21", "100", "21", "525")],
  });

  test("a non-payer claims no input VAT and self-assesses nothing", () => {
    const v = ReportCompute.vatSummary(
      [],
      [expense(1), selfAssessing],
      regime("non_vat_payer"),
      NOV,
    );
    expect([v.input, v.output]).toEqual([[], []]);
  });

  test("an identified person owes self-assessed VAT but deducts nothing", () => {
    const v = ReportCompute.vatSummary(
      [],
      [expense(1), selfAssessing],
      regime("identified_person"),
      NOV,
    );
    expect([vatTotals(v), v.input]).toEqual([[["standard", "2500", "525"]], []]);
  });

  test("the regime in force at each Expense's tax point applies", () => {
    const v = ReportCompute.vatSummary(
      [],
      [
        expense(1, { taxPoint: "2026-11-08" as IsoDate }),
        expense(3, { taxPoint: "2026-11-20" as IsoDate }),
      ],
      [...regime("non_vat_payer"), ...regime("vat_payer", "2026-11-15")],
      NOV,
    );
    expect(v.input.flatMap((l) => l.documents.map((ref) => [ref._tag, ref.id]))).toEqual([
      ["Expense", expense(3).id],
    ]);
  });

  test("profit counts a non-payer's Expense at gross, a payer's at net", () => {
    const rows = (r: ReadonlyArray<{ effectiveFrom: IsoDate; regime: TaxRegime }>) =>
      s(ReportCompute.profit([], [expense(1)], r, NOV).totals.expenses);
    expect([rows(regime("non_vat_payer")), rows(PAYER)]).toEqual(["484", "400"]);
  });
});

describe("review round 1", () => {
  test("an intra-EU acquisition counts its base once, at the self-assessed rate", () => {
    const v = ReportCompute.vatSummary(
      [],
      [
        expense(5, {
          buckets: [bucket("exempt_intra_eu_goods", "0", "100", "0")],
          selfAssessed: [bucket("standard", "21", "100", "21")],
        }),
      ],
      PAYER,
      NOV,
    );
    expect([vatTotals(v), v.input.map((l) => [l.treatment, s(l.base), s(l.vat)])]).toEqual([
      [["standard", "100", "21"]],
      [["standard", "100", "21"]],
    ]);
  });

  test("a renamed contact keeps one label whatever the source order (latest issue date wins)", () => {
    const docs = [
      document(1, { issuedOn: "2026-11-02" as IsoDate, contact: { id: null, name: "x" } }),
      document(2, {
        issuedOn: "2026-11-02" as IsoDate,
        contact: { id: document(9).contact.id, name: "Before" },
      }),
      document(3, {
        issuedOn: "2026-11-20" as IsoDate,
        contact: { id: document(9).contact.id, name: "After" },
      }),
    ];
    const labels = (rows: typeof docs) =>
      ReportCompute.revenue(rows, NOV, "contact").rows.map((r) => r.label);
    expect(labels(docs)).toEqual(labels([...docs].reverse()));
    expect(labels(docs)).toContain("After");
    expect(labels(docs)).not.toContain("Before");
  });
});

describe("dates", () => {
  test("months up to 9999-12 without stepping past the calendar", () => {
    expect(ReportCompute.monthsBetween("9999-11-15" as IsoDate, "9999-12-31" as IsoDate)).toEqual([
      "9999-11",
      "9999-12",
    ]);
  });

  test("the dashboard window cannot start before year 0000", () => {
    expect(ReportCompute.twelveMonthsEnding("0000-05-01" as IsoDate)).toBeNull();
    expect(String(ReportCompute.twelveMonthsEnding("0000-12-31" as IsoDate)?.from)).toBe(
      "0000-01-01",
    );
  });
});

describe("amounts", () => {
  test("gross includes whole-unit payment rounding", () => {
    const doc = document(40, { buckets: [bucket("standard", "21", "100.6", "21.13")] });
    const rounded = {
      ...doc,
      totals: {
        ...doc.totals,
        roundingAdjustment: { amount: d("0.27"), currency: CZK },
        gross: { amount: d("122"), currency: CZK },
      },
    };
    const row = ReportCompute.revenue([rounded], NOV, "currency").rows[0];
    expect(row && [s(row.net), s(row.vat), s(row.gross), row.original && s(row.original)]).toEqual([
      "100.6",
      "21.13",
      "122",
      "122",
    ]);
  });

  test("original-currency CSV amounts keep the currency's and the stored precision", () => {
    const BHD = "BHD" as CurrencyCode;
    const csv = encodeCsv(
      paymentsTable([
        payment(1, "in", "2026-11-02", "0.001", BHD, fx("60")),
        payment(2, "in", "2026-11-02", "1.5"),
        payment(3, "in", "2026-11-02", "10.12345", EUR, fx("25")),
      ]),
      "cs",
    );
    expect(
      csv
        .split("\r\n")
        .slice(1, 4)
        .map((r) => r.split(";")[5]),
    ).toEqual(["0,001", "1,50", "10,12345"]);
  });
});

// Service-level regressions --------------------------------------------------------------------

const USER_B = "01900000-0000-7000-8000-00000000c002" as UserId;
const impl = Effect.gen(function* () {
  return (yield* Reports) as unknown as ReportsImpl;
});

/** Reports on an ExportsRepo whose first insert loses a race to a job that already finished. */
const racyLayer = (constraint: string, losses = 1) =>
  ReportsLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(
          ExportsRepo,
          Effect.gen(function* () {
            const real = yield* ExportsRepo;
            let lost = 0;
            return {
              ...real,
              insert: (row: Parameters<typeof real.insert>[0]) => {
                if (lost >= losses) return real.insert(row);
                lost += 1;
                return Effect.fail(new UniqueViolation({ collection: "exports", constraint }));
              },
            };
          }),
        ).pipe(Layer.provide(ExportsRepoMemory)),
        ReportsSourceMemory,
        FakeReportPdfRenderer.layer,
        FakeExportWorkflow.layer,
        FxFixingCacheMemory,
      ),
    ),
  );

describe("export start", () => {
  test("the DataExport job may not start an export (R5)", async () => {
    const exit = await runTest(
      system({ _tag: "DataExport", exportId: "01900000-0000-7000-8000-000000000e01" as never }),
      Effect.flatMap(impl, (r) => r.startExport()).pipe(Effect.provide(racyLayer("unused"))),
    );
    expect(exit).toEqual(Exit.fail(new Forbidden({ action: "report.export" })));
  });

  test("the audit actor is the calling Member, not the caller the layer was built under", async () => {
    const body = Effect.gen(function* () {
      const r = yield* impl;
      const job = yield* Effect.provideService(
        r.startExport(),
        CurrentCaller,
        member("owner", { workspaceId: WORKSPACE_B, userId: USER_B }),
      );
      const store = yield* CoreStore;
      return yield* store.audit.history(WORKSPACE_B, { entity: "Export", id: job.id });
    });
    const exit = await runTest(
      member("owner"),
      body.pipe(Effect.provide(racyLayer(ONE_RUNNING_EXPORT))),
    );
    expect(Exit.isSuccess(exit) && exit.value.map((e) => e.actor)).toEqual([
      { _tag: "Member", userId: USER_B, channel: "web", client: null },
    ]);
  });

  test("losing the start race to a finished job retries and starts a fresh one", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.flatMap(impl, (r) => r.startExport()).pipe(
        Effect.provide(racyLayer(ONE_RUNNING_EXPORT)),
      ),
    );
    expect(Exit.isSuccess(exit) && [exit.value.status, exit.value.id === undefined]).toEqual([
      "running",
      false,
    ]);
  });

  test("contention that outlives every retry is Unavailable{database}, not a defect", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.flatMap(impl, (r) => r.startExport()).pipe(
        Effect.provide(racyLayer(ONE_RUNNING_EXPORT, 10)),
      ),
    );
    expect(exit).toEqual(Exit.fail(new Unavailable({ dependency: "database" })));
  });

  test("any other unique violation is a defect, not a silent success", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.flatMap(impl, (r) => r.startExport()).pipe(Effect.provide(racyLayer("exports_pkey"))),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit)).toContain("exports_pkey");
    expect(WORKSPACE_A).toBeDefined();
  });

  test("a dashboard window before year 0000 is Invalid", async () => {
    const exit = await runTest(
      member("owner"),
      Effect.flatMap(impl, (r) =>
        r.dashboard({ from: "0000-01-01" as IsoDate, to: "0000-05-01" as IsoDate }),
      ).pipe(Effect.provide(racyLayer(ONE_RUNNING_EXPORT))),
    );
    expect(exit).toEqual(
      Exit.fail(
        new Invalid({
          issues: [
            { path: ["period", "to"], code: "request.malformed", params: { reason: "too_early" } },
          ],
        }),
      ),
    );
  });
});
