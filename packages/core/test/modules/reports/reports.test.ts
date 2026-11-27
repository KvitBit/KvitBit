import { describe, expect, test } from "bun:test";
import type { Caller, CoreError, ReportKind, ReportView } from "@kvitbit/domain/contract";
import {
  Conflict,
  CurrencyCode,
  CurrentCaller,
  ExpenseId,
  ExportId,
  Forbidden,
  Invalid,
  IsoDate,
  NotFound,
  Reports,
  RequestKey,
  Unavailable,
} from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { BlobStorage } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import {
  EXPORT_RETENTION_MILLIS,
  ExportJobs,
  exportBlobKey,
  FakeExportWorkflow,
  FakeReportPdfRenderer,
  ReportsSourceFake,
  ReportsTestLayer,
} from "../../../src/modules/reports";
import { ReceivablesView, ReportViewData, RevenueView } from "../../../src/modules/reports/views";
import { CoreStore } from "../../../src/store/CoreStore";
import type { InMemoryPortsLive } from "../../../src/testing";
import { FixtureRates } from "../../../src/testing";
import {
  account,
  member,
  runTest,
  shareVisitor,
  system,
  WORKSPACE_A,
  WORKSPACE_B,
} from "../../helpers";
import { withoutStackTrace } from "../../helpers/run";
import { bucket, d, docId, document, EUR, expense, fx, payment, s } from "./fixtures";

type Services =
  | Layer.Success<typeof ReportsTestLayer>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | CurrentCaller;

/** Runs `body` as `caller` on fresh in-memory ports plus the Reports test layer. */
const run = <A, E>(
  caller: Caller,
  body: Effect.Effect<A, E, Services>,
  fixings: ReadonlyArray<CnbFixing> = [],
) => runTest(caller, Effect.provide(body, ReportsTestLayer), { fixings });

const reportView = (value: ReportView) =>
  Schema.decodeUnknownOption(ReportViewData)(value).pipe(Option.getOrThrow);
const receivablesView = (value: ReportView) =>
  Schema.decodeUnknownOption(ReceivablesView)(value).pipe(Option.getOrThrow);
const revenueView = (value: ReportView) =>
  Schema.decodeUnknownOption(RevenueView)(value).pipe(Option.getOrThrow);
const errorOf = (exit: Exit.Exit<unknown, CoreError>) =>
  Exit.isFailure(exit) && exit.cause.pipe(Cause.findErrorOption, Option.getOrUndefined);
const NOV = { from: IsoDate.make("2026-11-01"), to: IsoDate.make("2026-11-30") };
const as = (caller: Caller) => Effect.provideService(CurrentCaller, caller);

const seedBoth = Effect.gen(function* () {
  const fake = yield* ReportsSourceFake;
  yield* fake.seed({
    documents: [
      document(1),
      document(2, {
        workspaceId: WORKSPACE_B,
        buckets: [bucket("standard", "21", "5000", "1050")],
      }),
    ],
    expenses: [expense(1), expense(2, { workspaceId: WORKSPACE_B })],
    payments: [
      payment(1, "in", "2026-11-10", "1210"),
      payment(2, "in", "2026-11-10", "99", undefined, null, WORKSPACE_B),
    ],
    incompleteExpenses: [
      { workspaceId: WORKSPACE_A, id: ExpenseId.make("01900000-0000-7000-8000-000000000001") },
    ],
    taxRegimes: [
      { workspaceId: WORKSPACE_A, effectiveFrom: IsoDate.make("2024-01-01"), regime: "vat_payer" },
    ],
  });
});

const bodyText = (bytes: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(bytes), (chunks) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      Uint8Array.from(EffectArray.flatMap(chunks, (c) => [...c])),
    ),
  );

describe("authorization", () => {
  const runReport = Effect.flatMap(Reports, (r) => r.run({ report: "revenue", period: NOV }));

  test.each(["owner", "admin", "member", "accountant"] as const)(
    "%s may run reports",
    async (role) => {
      (await run(member(role), runReport)).pipe(Exit.isSuccess, expect).toBe(true);
    },
  );

  test("a scoped token needs reports:read", async () => {
    expect(
      (await run(member("owner", { scopes: ["documents:write"] }), runReport)).pipe(
        withoutStackTrace,
      ),
    ).toEqual(Exit.fail(Forbidden.make({ action: "report.run" })));
    (await run(member("owner", { scopes: ["reports:read"] }), runReport))
      .pipe(Exit.isSuccess, expect)
      .toBe(true);
  });

  test("exports need report.export; non-members are refused everywhere", async () => {
    const all = Effect.flatMap(Reports, (r) =>
      Effect.all(
        [
          Effect.exit(r.export({ report: "revenue", period: NOV }, "csv")),
          Effect.exit(r.startExport()),
          Effect.exit(r.dashboard(NOV)),
          Effect.exit(r.fxRate({ currency: EUR, on: IsoDate.make("2026-11-02") })),
          Effect.exit(r.getExport(ExportId.make("01900000-0000-7000-8000-000000000999"))),
        ],
        { concurrency: 1 },
      ),
    );
    const outcomes = await Promise.all([run(account(), all), run(shareVisitor(), all)]);
    for (const exit of outcomes) {
      expect(Exit.isSuccess(exit) && EffectArray.map(exit.value, errorOf)).toEqual([
        expect.objectContaining({ action: "report.export" }),
        expect.objectContaining({ action: "report.export" }),
        expect.objectContaining({ action: "report.run" }),
        expect.objectContaining({ action: "report.run" }),
        expect.objectContaining({ action: "report.export" }),
      ]);
    }
    const scoped = await run(
      member("member", { scopes: ["documents:read"] }),
      Effect.flatMap(Reports, (r) => r.startExport()),
    );
    expect(scoped.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "report.export" })),
    );
  });

  test("the DataExport System job may read but is scoped to its Workspace", async () => {
    const exit = await run(
      system({
        _tag: "DataExport",
        exportId: ExportId.make("01900000-0000-7000-8000-000000000e01"),
      }),
      Effect.andThen(
        seedBoth,
        Effect.flatMap(Reports, (r) => r.run({ report: "revenue", period: NOV })),
      ),
    );
    expect(Exit.isSuccess(exit) && s(revenueView(exit.value).totals.net)).toBe("1000");
  });
});

describe("Workspace isolation", () => {
  test("each Workspace sees only its own rows", async () => {
    const body = Effect.andThen(
      seedBoth,
      Effect.flatMap(Reports, (r) =>
        Effect.all(
          {
            a: r.run({ report: "revenue", period: NOV }),
            b: as(member("owner", { workspaceId: WORKSPACE_B }))(
              r.run({ report: "revenue", period: NOV }),
            ),
            dash: r.dashboard(NOV),
          },
          { concurrency: 1 },
        ),
      ),
    );
    const exit = await run(member("accountant"), body);
    if (!Exit.isSuccess(exit)) throw new Error(String(exit));
    expect([
      s(revenueView(exit.value.a).totals.net),
      s(revenueView(exit.value.b).totals.net),
    ]).toEqual(["1000", "5000"]);
    expect({
      revenue: s(exit.value.dash.revenue),
      expenses: s(exit.value.dash.expenses),
      incomplete: exit.value.dash.incompleteExpenses,
      novIn: EffectArray.map(exit.value.dash.cashflow, (p) => s(p.in)).at(-1),
      months: exit.value.dash.cashflow.length,
    }).toEqual({ revenue: "1000", expenses: "400", incomplete: 1, novIn: "1210", months: 12 });
  });

  test("another Workspace's export job is NotFound", async () => {
    const body = Effect.flatMap(Reports, (r) =>
      Effect.gen(function* () {
        const job = yield* r.startExport();
        return yield* r
          .getExport(job.id)
          .pipe(Effect.exit, as(member("owner", { workspaceId: WORKSPACE_B })));
      }),
    );
    const exit = await run(member("owner"), body);
    expect(Exit.isSuccess(exit) && exit.value.pipe(withoutStackTrace)).toEqual(
      Exit.fail(NotFound.make({ entity: "Export", id: "01900000-0000-7000-8000-000000000001" })),
    );
  });
});

describe("run", () => {
  test.each([
    [
      {
        report: "revenue",
        period: { from: IsoDate.make("2026-11-30"), to: IsoDate.make("2026-11-01") },
      },
      ["period"],
      "from_after_to",
    ],
    [
      {
        report: "revenue",
        period: {
          from: IsoDate.make("2026-02-30", { disableChecks: true }),
          to: IsoDate.make("2026-11-01"),
        },
      },
      ["period", "from"],
      "date_invalid",
    ],
    [
      {
        report: "revenue",
        period: { from: IsoDate.make("2000-01-01"), to: IsoDate.make("2026-11-01") },
      },
      ["period"],
      "too_long",
    ],
    [{ report: "cashflow", period: NOV, groupBy: "contact" }, ["groupBy"], "not_supported"],
    [{ report: "receivables", period: NOV, groupBy: "month" }, ["groupBy"], "not_supported"],
  ] as const)("rejects %j", async (query, path, reason) => {
    const exit = await run(
      member("owner"),
      Effect.flatMap(Reports, (r) => r.run(query)),
    );
    expect(exit.pipe(withoutStackTrace)).toEqual(
      Exit.fail(
        Invalid.make({
          issues: [{ path: [...path], code: "request.malformed", params: { reason } }],
        }),
      ),
    );
  });

  test.each(["revenue", "vat_summary", "receivables", "expenses", "profit", "cashflow"] as const)(
    "%s returns its tagged view",
    async (report: ReportKind) => {
      const exit = await run(
        member("accountant"),
        Effect.andThen(
          seedBoth,
          Effect.flatMap(Reports, (r) => r.run({ report, period: NOV })),
        ),
      );
      expect(Exit.isSuccess(exit) && reportView(exit.value).report).toBe(report);
    },
  );

  test("receivables age against today's Prague date", async () => {
    const body = Effect.gen(function* () {
      const fake = yield* ReportsSourceFake;
      yield* fake.seed({
        documents: [document(1, { dueOn: IsoDate.make("2026-10-23"), outstanding: d("100") })],
      });
      const r = yield* Reports;
      const report = yield* r.run({ report: "receivables", period: NOV });
      return receivablesView(report);
    });
    const exit = await run(member("owner"), body);
    expect(Exit.isSuccess(exit) && [String(exit.value.asOf), exit.value.buckets[2]?.count]).toEqual(
      ["2026-11-23", 1],
    );
  });

  test("a store outage is Unavailable{database}", async () => {
    const body = Effect.gen(function* () {
      const fake = yield* ReportsSourceFake;
      yield* Ref.set(fake.unavailable, true);
      return yield* (yield* Reports).run({ report: "cashflow", period: NOV });
    });
    expect((await run(member("owner"), body)).pipe(withoutStackTrace)).toEqual(
      Exit.fail(Unavailable.make({ dependency: "database" })),
    );
  });
});

describe("export", () => {
  test("csv: locale-formatted, named after report and period, streamed", async () => {
    const body = Effect.gen(function* () {
      yield* seedBoth;
      const r = yield* Reports;
      const cs = yield* r.export({ report: "cashflow", period: NOV }, "csv");
      const en = yield* as(member("owner", { locale: "en" }))(
        r.export({ report: "cashflow", period: NOV }, "csv"),
      );
      return { cs, csText: yield* bodyText(cs.bytes), enText: yield* bodyText(en.bytes) };
    });
    const exit = await run(member("accountant"), body);
    if (!Exit.isSuccess(exit)) throw new Error(String(exit));
    expect([exit.value.cs.filename, exit.value.cs.contentType]).toEqual([
      "cashflow_2026-11-01_2026-11-30.csv",
      "text/csv; charset=utf-8",
    ]);
    expect(exit.value.csText).toBe(
      "﻿month;in_czk;out_czk;net_czk\r\n2026-11;1210,00;0,00;1210,00\r\n",
    );
    expect(exit.value.enText).toBe(
      "﻿month,in_czk,out_czk,net_czk\r\n2026-11,1210.00,0.00,1210.00\r\n",
    );
  });

  test("pdf goes through the renderer port with the view and the caller's locale", async () => {
    const body = Effect.gen(function* () {
      const file = yield* (yield* Reports).export({ report: "vat_summary", period: NOV }, "pdf");
      const calls = yield* Ref.get((yield* FakeReportPdfRenderer).calls);
      return { file, text: yield* bodyText(file.bytes), calls };
    });
    const exit = await run(member("accountant", { locale: "en" }), body);
    if (!Exit.isSuccess(exit)) throw new Error(String(exit));
    expect([exit.value.file.filename, exit.value.file.contentType, exit.value.text]).toEqual([
      "vat_summary_2026-11-01_2026-11-30.pdf",
      "application/pdf",
      `%PDF-FAKE vat_summary en ${WORKSPACE_A}`,
    ]);
    expect(EffectArray.map(exit.value.calls, (c) => [c.view.report, c.locale])).toEqual([
      ["vat_summary", "en"],
    ]);
  });
});

describe("fxRate", () => {
  const fixings: ReadonlyArray<CnbFixing> = [
    {
      fixingDate: IsoDate.make("2026-11-20"),
      sequence: 225,
      rates: [
        { code: EUR, quantity: 1, rate: d("25.115") },
        { code: CurrencyCode.make("JPY"), quantity: 100, rate: d("15.2") },
      ],
    },
  ];

  test("the fixing valid on a date (weekend carries back)", async () => {
    const exit = await run(
      member("member"),
      Effect.flatMap(Reports, (r) =>
        r.fxRate({ currency: CurrencyCode.make("JPY"), on: IsoDate.make("2026-11-22") }),
      ),
      fixings,
    );
    expect(
      Exit.isSuccess(exit) && {
        ...exit.value,
        currency: String(exit.value.currency),
        fixingDate: String(exit.value.fixingDate),
        rate: s(exit.value.rate),
      },
    ).toEqual({
      currency: "JPY",
      rate: "15.2",
      quantity: 100,
      fixingDate: "2026-11-20",
      source: "cnb",
    });
  });

  test("a currency the fixing lacks is Invalid{fx.rate_missing}; no fixing is Unavailable", async () => {
    const missing = await run(
      member("member"),
      Effect.flatMap(Reports, (r) =>
        r.fxRate({ currency: CurrencyCode.make("USD"), on: IsoDate.make("2026-11-22") }),
      ),
      fixings,
    );
    expect(missing.pipe(withoutStackTrace)).toEqual(
      Exit.fail(
        Invalid.make({
          issues: [{ path: ["fx"], code: "fx.rate_missing", params: { currency: "USD" } }],
        }),
      ),
    );
    const down = await run(
      member("member"),
      Effect.flatMap(Reports, (r) => r.fxRate({ currency: EUR, on: IsoDate.make("2026-01-01") })),
      fixings,
    );
    expect(down.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Unavailable.make({ dependency: "exchange_rates" })),
    );
  });
});

describe("export jobs", () => {
  const key = RequestKey.make("export-key-0001");

  test("startExport: one running job per Workspace, audited once, workflow started after commit", async () => {
    const body = Effect.gen(function* () {
      const r = yield* Reports;
      const first = yield* r.startExport();
      const second = yield* r.startExport();
      const started = yield* Ref.get((yield* FakeExportWorkflow).started);
      const store = yield* CoreStore;
      const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Export", id: first.id });
      return { first, second, started, audit };
    });
    const exit = await run(member("accountant"), body);
    if (!Exit.isSuccess(exit)) throw new Error(String(exit));
    const { first, second, started, audit } = exit.value;
    expect(first).toEqual({
      id: first.id,
      status: "running",
      createdAt: "2026-11-23T09:00:00.000Z",
      readyAt: null,
      expiresAt: null,
      sizeBytes: null,
    });
    expect(second).toEqual(first);
    expect(started).toEqual([{ workspaceId: WORKSPACE_A, exportId: first.id }]);
    expect(EffectArray.map(audit, (e) => [e.action, e.subject, e.actor._tag])).toEqual([
      ["report.export", { entity: "Export", id: first.id }, "Member"],
    ]);
  });

  test("request key replay returns the stored job; a different method/payload never collides", async () => {
    const body = Effect.gen(function* () {
      const r = yield* Reports;
      const a = yield* r.startExport({ requestKey: key });
      const jobs = yield* ExportJobs;
      yield* jobs.finish(WORKSPACE_A, a.id, 10);
      const replay = yield* r.startExport({ requestKey: key });
      const fresh = yield* r.startExport({ requestKey: RequestKey.make("export-key-0002") });
      const started = yield* Ref.get((yield* FakeExportWorkflow).started);
      return { a, replay, fresh, started: started.length };
    });
    const exit = await run(member("owner"), body);
    if (!Exit.isSuccess(exit)) throw new Error(String(exit));
    expect(exit.value.replay).toEqual(exit.value.a); // the stored result, status running
    expect(exit.value.fresh.id).not.toBe(exit.value.a.id); // the first is ready, a new one runs
    expect(exit.value.started).toBe(2);
  });

  test("lifecycle: running -> Conflict{export.not_ready}; finish -> ZIP download for 7 days; then NotFound", async () => {
    const body = Effect.gen(function* () {
      const r = yield* Reports;
      const jobs = yield* ExportJobs;
      const job = yield* r.startExport();
      const whileRunning = yield* Effect.exit(r.exportFile(job.id));
      const zip = new TextEncoder().encode("PK-zip");
      yield* (yield* BlobStorage).put(exportBlobKey(WORKSPACE_A, job.id), Stream.succeed(zip), {
        contentType: "application/zip",
        maxBytes: 100,
      });
      yield* TestClock.adjust(60_000);
      const ready = yield* jobs.finish(WORKSPACE_A, job.id, zip.byteLength);
      const again = yield* jobs.fail(WORKSPACE_A, job.id); // no effect once ready
      const file = yield* r.exportFile(job.id);
      const text = yield* bodyText(file.bytes);
      yield* TestClock.adjust(EXPORT_RETENTION_MILLIS);
      const expired = yield* Effect.exit(r.getExport(job.id));
      const purged = yield* jobs.purgeExpired;
      const blobGone = yield* Effect.exit(
        (yield* BlobStorage).get(exportBlobKey(WORKSPACE_A, job.id)),
      );
      return { whileRunning, ready, again, file, text, expired, purged, blobGone };
    });
    const exit = await run(member("owner"), body);
    if (!Exit.isSuccess(exit)) throw new Error(String(exit));
    const v = exit.value;
    expect(v.whileRunning.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "illegal_transition", detail: "export.not_ready" })),
    );
    expect([v.ready.status, v.ready.readyAt, v.ready.expiresAt, v.ready.sizeBytes]).toEqual([
      "ready",
      "2026-11-23T09:01:00.000Z",
      "2026-11-30T09:01:00.000Z",
      6,
    ]);
    expect(v.again).toEqual(v.ready);
    expect([v.file.contentType, v.file.filename, v.text]).toEqual([
      "application/zip",
      "kvitbit-export-2026-11-23.zip",
      "PK-zip",
    ]);
    const expired = errorOf(v.expired);
    expect(expired).toMatchObject({ _tag: "NotFound" });
    expect(v.purged).toBe(1);
    expect(Exit.isFailure(v.blobGone)).toBe(true);
  });

  test("a failed job stays Conflict{export.not_ready}; a missing ZIP is NotFound", async () => {
    const body = Effect.gen(function* () {
      const r = yield* Reports;
      const jobs = yield* ExportJobs;
      const failed = yield* r.startExport();
      yield* jobs.fail(WORKSPACE_A, failed.id);
      const onFailed = yield* Effect.exit(r.exportFile(failed.id));
      const next = yield* r.startExport();
      yield* jobs.finish(WORKSPACE_A, next.id, 1);
      const noBlob = yield* Effect.exit(r.exportFile(next.id));
      return { onFailed, noBlob, distinct: failed.id !== next.id };
    });
    const exit = await run(member("owner"), body);
    if (!Exit.isSuccess(exit)) throw new Error(String(exit));
    expect(exit.value.onFailed.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "illegal_transition", detail: "export.not_ready" })),
    );
    const missingZip = errorOf(exit.value.noBlob);
    expect(missingZip).toMatchObject({ _tag: "NotFound" });
    expect(exit.value.distinct).toBe(true);
  });

  test("ExportJobs.reportingTables: one deterministic CSV per readable table, own Workspace only", async () => {
    const body = Effect.gen(function* () {
      yield* seedBoth;
      const fake = yield* ReportsSourceFake;
      yield* fake.seed({
        documents: [
          document(3, {
            currency: EUR,
            fx: fx("25"),
            buckets: [bucket("standard", "21", "1", "0.21", "5.25")],
          }),
        ],
      });
      const files = yield* (yield* ExportJobs).reportingTables(WORKSPACE_A, "cs");
      const out: Array<[string, number]> = [];
      for (const file of files) {
        const content = yield* bodyText(file.bytes);
        out.push([file.name, EffectString.split(content, "\r\n").length - 1]);
      }
      return out;
    });
    const exit = await run(member("owner"), body);
    expect(exit).toEqual(
      Exit.succeed([
        ["reports/issued-documents.csv", 3], // header + documents 1 and 3
        ["reports/payments.csv", 2],
        ["reports/complete-expenses.csv", 2],
      ]),
    );
    expect(docId(1) < docId(3)).toBe(true);
  });
});

describe("review round 1 (service level)", () => {
  test("fxRate reads through the cache: a fetched date stays readable while CNB is down", async () => {
    const fixings: ReadonlyArray<CnbFixing> = [
      {
        fixingDate: IsoDate.make("2026-11-20"),
        sequence: 225,
        rates: [{ code: EUR, quantity: 1, rate: d("25.115") }],
      },
    ];
    const body = Effect.gen(function* () {
      const r = yield* Reports;
      const first = yield* r.fxRate({ currency: EUR, on: IsoDate.make("2026-11-22") });
      yield* Ref.set((yield* FixtureRates).unavailable, true);
      const cached = yield* r.fxRate({ currency: EUR, on: IsoDate.make("2026-11-22") });
      const friday = yield* r.fxRate({ currency: EUR, on: IsoDate.make("2026-11-20") });
      const uncached = yield* Effect.exit(
        r.fxRate({ currency: EUR, on: IsoDate.make("2026-11-21") }),
      );
      return {
        first: s(first.rate),
        cached: s(cached.rate),
        friday: s(friday.rate),
        uncached: uncached.pipe(withoutStackTrace),
      };
    });
    const exit = await run(member("member"), body, fixings);
    expect(exit).toEqual(
      Exit.succeed({
        first: "25.115",
        cached: "25.115",
        friday: "25.115",
        uncached: Exit.fail(Unavailable.make({ dependency: "exchange_rates" })),
      }),
    );
  });

  test("Reports.run vat_summary selects by tax point, not issue date", async () => {
    const body = Effect.gen(function* () {
      const fake = yield* ReportsSourceFake;
      yield* fake.seed({
        documents: [
          // issued in December, tax point in November: in
          document(1, {
            issuedOn: IsoDate.make("2026-12-02"),
            taxPoint: IsoDate.make("2026-11-28"),
          }),
          // issued in November, tax point in October: out
          document(2, {
            issuedOn: IsoDate.make("2026-11-02"),
            taxPoint: IsoDate.make("2026-10-30"),
          }),
        ],
        expenses: [
          expense(1, {
            issuedOn: IsoDate.make("2026-12-01"),
            taxPoint: IsoDate.make("2026-11-29"),
          }),
        ],
        taxRegimes: [
          {
            workspaceId: WORKSPACE_A,
            effectiveFrom: IsoDate.make("2024-01-01"),
            regime: "vat_payer",
          },
        ],
      });
      const report = yield* (yield* Reports).run({ report: "vat_summary", period: NOV });
      const v = reportView(report);
      if (v.report !== "vat_summary") throw new Error(v.report);
      return {
        output: EffectArray.map(v.output, (l) => [
          l.month,
          l.treatment,
          s(l.base),
          s(l.vat),
          EffectArray.map(l.documents, (x) => x.id),
        ]),
        input: EffectArray.map(v.input, (l) => [l.month, s(l.base), s(l.vat)]),
        payable: s(v.totals.payable),
      };
    });
    const exit = await run(member("accountant"), body);
    expect(exit).toEqual(
      Exit.succeed({
        output: [["2026-11", "standard", "1000", "210", [docId(1)]]],
        input: [["2026-11", "400", "84"]],
        payable: "126",
      }),
    );
  });

  test("today's lookup before publication is not cached: a later lookup sees the new fixing", async () => {
    const fixings: ReadonlyArray<CnbFixing> = [
      {
        fixingDate: IsoDate.make("2026-11-20"),
        sequence: 225,
        rates: [{ code: EUR, quantity: 1, rate: d("25.115") }],
      },
    ];
    const body = Effect.gen(function* () {
      const r = yield* Reports;
      const before = yield* r.fxRate({ currency: EUR, on: IsoDate.make("2026-11-23") });
      yield* Ref.update((yield* FixtureRates).fixings, (all) => [
        ...all,
        {
          fixingDate: IsoDate.make("2026-11-23"),
          sequence: 226,
          rates: [{ code: EUR, quantity: 1, rate: d("25.2") }],
        },
      ]);
      const after = yield* r.fxRate({ currency: EUR, on: IsoDate.make("2026-11-23") });
      return [s(before.rate), String(before.fixingDate), s(after.rate), String(after.fixingDate)];
    });
    expect(await run(member("member"), body, fixings)).toEqual(
      Exit.succeed(["25.115", "2026-11-20", "25.2", "2026-11-23"]),
    );
  });
});
