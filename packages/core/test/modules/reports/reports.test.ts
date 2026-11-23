import { describe, expect, test } from "bun:test";
import type {
  Caller,
  CurrencyCode,
  ExportId,
  IsoDate,
  ReportKind,
  RequestKey,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  CurrentCaller,
  Forbidden,
  Invalid,
  NotFound,
  Reports,
  Unavailable,
} from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { BlobStorage } from "@kvitbit/domain/ports";
import type { Layer } from "effect";
import { Effect, Exit, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { ReportsImpl, ReportViewData } from "../../../src/modules/reports";
import {
  EXPORT_RETENTION_MILLIS,
  ExportJobs,
  exportBlobKey,
  FakeExportWorkflow,
  FakeReportPdfRenderer,
  ReportsSourceFake,
  ReportsTestLayer,
} from "../../../src/modules/reports";
import { CoreStore } from "../../../src/store/CoreStore";
import type { InMemoryPortsLive } from "../../../src/testing";
import {
  account,
  member,
  runTest,
  shareVisitor,
  system,
  WORKSPACE_A,
  WORKSPACE_B,
} from "../../helpers";
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

/** The service with its honest error types and concrete views (the layer's one cast undone). */
const reports = Effect.gen(function* () {
  return (yield* Reports) as unknown as ReportsImpl;
});
const NOV = { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate };
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
    incompleteExpenses: [{ workspaceId: WORKSPACE_A, id: "x" as never }],
  });
});

const bodyText = (bytes: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(bytes), (chunks) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      Uint8Array.from(chunks.flatMap((c) => [...c])),
    ),
  );

describe("authorization", () => {
  const runReport = Effect.flatMap(reports, (r) => r.run({ report: "revenue", period: NOV }));

  test.each(["owner", "admin", "member", "accountant"] as const)(
    "%s may run reports",
    async (role) => {
      expect(Exit.isSuccess(await run(member(role), runReport))).toBe(true);
    },
  );

  test("a scoped token needs reports:read", async () => {
    expect(await run(member("owner", { scopes: ["documents:write"] }), runReport)).toEqual(
      Exit.fail(new Forbidden({ action: "report.run" })),
    );
    expect(
      Exit.isSuccess(await run(member("owner", { scopes: ["reports:read"] }), runReport)),
    ).toBe(true);
  });

  test("exports need report.export; non-members are refused everywhere", async () => {
    const all = Effect.flatMap(reports, (r) =>
      Effect.all(
        [
          Effect.exit(r.export({ report: "revenue", period: NOV }, "csv")),
          Effect.exit(r.startExport()),
          Effect.exit(r.dashboard(NOV)),
          Effect.exit(r.fxRate({ currency: EUR, on: "2026-11-02" as IsoDate })),
          Effect.exit(r.getExport("01900000-0000-7000-8000-000000000999" as ExportId)),
        ],
        { concurrency: 1 },
      ),
    );
    for (const caller of [account(), shareVisitor()]) {
      const exit = await run(caller, all);
      expect(
        Exit.isSuccess(exit) &&
          (exit.value as ReadonlyArray<Exit.Exit<unknown, unknown>>).map(
            (e) => Exit.isFailure(e) && JSON.stringify(e),
          ),
      ).toEqual([
        expect.stringContaining("report.export"),
        expect.stringContaining("report.export"),
        expect.stringContaining("report.run"),
        expect.stringContaining("report.run"),
        expect.stringContaining("report.export"),
      ]);
    }
    const scoped = await run(
      member("member", { scopes: ["documents:read"] }),
      Effect.flatMap(reports, (r) => r.startExport()),
    );
    expect(scoped).toEqual(Exit.fail(new Forbidden({ action: "report.export" })));
  });

  test("the DataExport System job may read but is scoped to its Workspace", async () => {
    const exit = await run(
      system({ _tag: "DataExport", exportId: "01900000-0000-7000-8000-000000000e01" as ExportId }),
      Effect.andThen(
        seedBoth,
        Effect.flatMap(reports, (r) => r.run({ report: "revenue", period: NOV })),
      ),
    );
    expect(
      Exit.isSuccess(exit) &&
        s((exit.value as unknown as ReportViewData & { totals: { net: never } }).totals.net),
    ).toBe("1000");
  });
});

describe("Workspace isolation", () => {
  test("each Workspace sees only its own rows", async () => {
    const body = Effect.andThen(
      seedBoth,
      Effect.flatMap(reports, (r) =>
        Effect.all({
          a: r.run({ report: "revenue", period: NOV }),
          b: as(member("owner", { workspaceId: WORKSPACE_B }))(
            r.run({ report: "revenue", period: NOV }),
          ),
          dash: r.dashboard(NOV),
        }),
      ),
    );
    const exit = await run(member("accountant"), body);
    if (!Exit.isSuccess(exit)) throw new Error(String(exit));
    const net = (v: unknown) => s((v as { totals: { net: never } }).totals.net);
    expect([net(exit.value.a), net(exit.value.b)]).toEqual(["1000", "5000"]);
    expect({
      revenue: s(exit.value.dash.revenue),
      expenses: s(exit.value.dash.expenses),
      incomplete: exit.value.dash.incompleteExpenses,
      novIn: exit.value.dash.cashflow.map((p) => s(p.in)).at(-1),
      months: exit.value.dash.cashflow.length,
    }).toEqual({ revenue: "1000", expenses: "400", incomplete: 1, novIn: "1210", months: 12 });
  });

  test("another Workspace's export job is NotFound", async () => {
    const body = Effect.flatMap(reports, (r) =>
      Effect.gen(function* () {
        const job = yield* r.startExport();
        return yield* as(member("owner", { workspaceId: WORKSPACE_B }))(
          Effect.exit(r.getExport(job.id)),
        );
      }),
    );
    const exit = await run(member("owner"), body);
    expect(Exit.isSuccess(exit) && exit.value).toEqual(
      Exit.fail(new NotFound({ entity: "Export", id: "01900000-0000-7000-8000-000000000001" })),
    );
  });
});

describe("run", () => {
  test.each([
    [
      { report: "revenue", period: { from: "2026-11-30", to: "2026-11-01" } },
      ["period"],
      "from_after_to",
    ],
    [
      { report: "revenue", period: { from: "2026-02-30", to: "2026-11-01" } },
      ["period", "from"],
      "date_invalid",
    ],
    [
      { report: "revenue", period: { from: "2000-01-01", to: "2026-11-01" } },
      ["period"],
      "too_long",
    ],
    [{ report: "cashflow", period: NOV, groupBy: "contact" }, ["groupBy"], "not_supported"],
    [{ report: "receivables", period: NOV, groupBy: "month" }, ["groupBy"], "not_supported"],
  ] as const)("rejects %j", async (query, path, reason) => {
    const exit = await run(
      member("owner"),
      Effect.flatMap(reports, (r) => r.run(query as never)),
    );
    expect(exit).toEqual(
      Exit.fail(
        new Invalid({
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
          Effect.flatMap(reports, (r) => r.run({ report, period: NOV })),
        ),
      );
      expect(Exit.isSuccess(exit) && (exit.value as unknown as ReportViewData).report).toBe(report);
    },
  );

  test("receivables age against today's Prague date", async () => {
    const body = Effect.gen(function* () {
      const fake = yield* ReportsSourceFake;
      yield* fake.seed({
        documents: [document(1, { dueOn: "2026-10-23" as IsoDate, outstanding: d("100") })],
      });
      const r = yield* reports;
      return (yield* r.run({ report: "receivables", period: NOV })) as unknown as Extract<
        ReportViewData,
        { report: "receivables" }
      >;
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
      return yield* (yield* reports).run({ report: "cashflow", period: NOV });
    });
    expect(await run(member("owner"), body)).toEqual(
      Exit.fail(new Unavailable({ dependency: "database" })),
    );
  });
});

describe("export", () => {
  test("csv: locale-formatted, named after report and period, streamed", async () => {
    const body = Effect.gen(function* () {
      yield* seedBoth;
      const r = yield* reports;
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
      const file = yield* (yield* reports).export({ report: "vat_summary", period: NOV }, "pdf");
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
    expect(exit.value.calls.map((c) => [c.view.report, c.locale])).toEqual([["vat_summary", "en"]]);
  });
});

describe("fxRate", () => {
  const fixings: ReadonlyArray<CnbFixing> = [
    {
      fixingDate: "2026-11-20" as IsoDate,
      sequence: 225,
      rates: [
        { code: EUR, quantity: 1, rate: d("25.115") },
        { code: "JPY" as CurrencyCode, quantity: 100, rate: d("15.2") },
      ],
    },
  ];

  test("the fixing valid on a date (weekend carries back)", async () => {
    const exit = await run(
      member("member"),
      Effect.flatMap(reports, (r) =>
        r.fxRate({ currency: "JPY" as CurrencyCode, on: "2026-11-22" as IsoDate }),
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
      Effect.flatMap(reports, (r) =>
        r.fxRate({ currency: "USD" as CurrencyCode, on: "2026-11-22" as IsoDate }),
      ),
      fixings,
    );
    expect(missing).toEqual(
      Exit.fail(
        new Invalid({
          issues: [{ path: ["fx"], code: "fx.rate_missing", params: { currency: "USD" } }],
        }),
      ),
    );
    const down = await run(
      member("member"),
      Effect.flatMap(reports, (r) => r.fxRate({ currency: EUR, on: "2026-01-01" as IsoDate })),
      fixings,
    );
    expect(down).toEqual(Exit.fail(new Unavailable({ dependency: "exchange_rates" })));
  });
});

describe("export jobs", () => {
  const key = "export-key-0001" as RequestKey;

  test("startExport: one running job per Workspace, audited once, workflow started after commit", async () => {
    const body = Effect.gen(function* () {
      const r = yield* reports;
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
    expect(audit.map((e) => [e.action, e.subject, e.actor._tag])).toEqual([
      ["report.export", { entity: "Export", id: first.id }, "Member"],
    ]);
  });

  test("request key replay returns the stored job; a different method/payload never collides", async () => {
    const body = Effect.gen(function* () {
      const r = yield* reports;
      const a = yield* r.startExport({ requestKey: key });
      const jobs = yield* ExportJobs;
      yield* jobs.finish(WORKSPACE_A, a.id, 10);
      const replay = yield* r.startExport({ requestKey: key });
      const fresh = yield* r.startExport({ requestKey: "export-key-0002" as RequestKey });
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
      const r = yield* reports;
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
    expect(v.whileRunning).toEqual(
      Exit.fail(new Conflict({ reason: "illegal_transition", detail: "export.not_ready" })),
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
    expect(Exit.isFailure(v.expired) && JSON.stringify(v.expired)).toContain("NotFound");
    expect(v.purged).toBe(1);
    expect(Exit.isFailure(v.blobGone)).toBe(true);
  });

  test("a failed job stays Conflict{export.not_ready}; a missing ZIP is NotFound", async () => {
    const body = Effect.gen(function* () {
      const r = yield* reports;
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
    expect(exit.value.onFailed).toEqual(
      Exit.fail(new Conflict({ reason: "illegal_transition", detail: "export.not_ready" })),
    );
    expect(Exit.isFailure(exit.value.noBlob) && JSON.stringify(exit.value.noBlob)).toContain(
      "NotFound",
    );
    expect(exit.value.distinct).toBe(true);
  });

  test("ExportJobs.tables: one deterministic CSV per readable table, own Workspace only", async () => {
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
      const files = yield* (yield* ExportJobs).tables(WORKSPACE_A, "cs");
      return files.map((f) => [f.name, new TextDecoder().decode(f.bytes).split("\r\n").length - 1]);
    });
    const exit = await run(member("owner"), body);
    expect(exit).toEqual(
      Exit.succeed([
        ["documents.csv", 3], // header + documents 1 and 3
        ["payments.csv", 2],
        ["expenses.csv", 2],
      ]),
    );
    expect(docId(1) < docId(3)).toBe(true);
  });
});
