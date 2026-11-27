import type {
  Conflict as ConflictError,
  CurrencyCode,
  DashboardView,
  ExportId,
  ExportJobView,
  FileDownload,
  Forbidden,
  FxRateView,
  Locale,
  NotFound,
  ReportQuery,
  RequestOptions,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  type CurrentCaller,
  ExportId as ExportIdSchema,
  ExportJobView as ExportJobViewSchema,
  Forbidden as ForbiddenError,
  Invalid,
  IsoDate,
  Reports,
  ReportView,
} from "@kvitbit/domain/contract";
import { BlobStorage } from "@kvitbit/domain/ports";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
/**
 * `ReportsLive`: the domain `Reports` service (core-ports 4.9). Reports are read-only and not
 * audited, except `startExport` (one audit entry on subject `Export`). Every method authorizes
 * first (R1a), reads through `ReportsSource` inside one `CoreStore` transaction (a consistent
 * snapshot), and maps port failures to `Unavailable`.
 *
 * The domain tag states the errors these methods raise. One gap remains (board #340/#341):
 * `ReportView` is an opaque placeholder, so `ReportsImpl.run` returns the concrete
 * `ReportViewData` and `ReportsLive` casts that one method's success type at the layer boundary.
 */
import * as EffectString from "effect/String";
import { daysBetween, pragueDate } from "../../engines/calendar";
import { Fx } from "../../engines/fx";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { FxFixings } from "../../shared/fx";
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator, newId } from "../../shared/ids";
import { CoreStore, StoreUnavailable } from "../../store/CoreStore";
import * as Compute from "./compute";
import { CSV_CONTENT_TYPE, csvStream } from "./csv";
import {
  type ExportRow,
  ExportsRepo,
  ExportWorkflow,
  exportBlobKey,
  notFoundExport,
  ONE_RUNNING_EXPORT,
  toExportJobView,
} from "./exports";
import { ReportPdfRenderer } from "./renderer";
import { ReportsSource } from "./source";
import { reportTable } from "./tables";
import type { ReportViewData } from "./views";

/** Longest accepted period (about ten years), so a request cannot ask for unbounded work. */
export const MAX_PERIOD_DAYS = 3660;

const GROUPINGS = {
  revenue: ["month", "contact", "currency"],
  expenses: ["month", "contact", "currency", "category"],
  profit: ["month"],
  cashflow: ["month"],
  vat_summary: ["month"],
  receivables: [],
} satisfies { readonly [K in ReportQuery["report"]]: ReadonlyArray<string> };

const malformed = (path: ReadonlyArray<string>, reason: string) =>
  Invalid.make({ issues: [{ path: [...path], code: "request.malformed", params: { reason } }] });

const isIsoDate = Schema.is(IsoDate);

export const validatePeriod = (period: {
  readonly from: string;
  readonly to: string;
}): Effect.Effect<Compute.Period, Invalid> => {
  if (!isIsoDate(period.from)) return Effect.fail(malformed(["period", "from"], "date_invalid"));
  if (!isIsoDate(period.to)) return Effect.fail(malformed(["period", "to"], "date_invalid"));
  if (period.from > period.to) return Effect.fail(malformed(["period"], "from_after_to"));
  if (daysBetween(period.from, period.to) > MAX_PERIOD_DAYS) {
    return Effect.fail(malformed(["period"], "too_long"));
  }
  return Effect.succeed({ from: period.from, to: period.to });
};

const validateQuery = Effect.fn("validateQuery")(function* (q: ReportQuery) {
  const period = yield* validatePeriod(q.period);
  const allowed: ReadonlyArray<string> | undefined = GROUPINGS[q.report];
  if (allowed === undefined) return yield* malformed(["report"], "unknown_report");
  if (q.groupBy !== undefined && !allowed.includes(q.groupBy)) {
    return yield* malformed(["groupBy"], "not_supported");
  }
  return { report: q.report, period, groupBy: q.groupBy };
});

/** The method surface with honest error types (see the module comment). */
export interface ReportsImpl {
  readonly run: (
    q: ReportQuery,
  ) => Effect.Effect<ReportViewData, Invalid | Forbidden | Unavailable, CurrentCaller>;
  readonly export: (
    q: ReportQuery,
    format: "csv" | "pdf",
  ) => Effect.Effect<FileDownload, Invalid | Forbidden | Unavailable, CurrentCaller>;
  readonly dashboard: (period: {
    readonly from: IsoDate;
    readonly to: IsoDate;
  }) => Effect.Effect<DashboardView, Invalid | Forbidden | Unavailable, CurrentCaller>;
  readonly fxRate: (q: {
    readonly currency: CurrencyCode;
    readonly on: IsoDate;
  }) => Effect.Effect<FxRateView, Invalid | Unavailable | Forbidden, CurrentCaller>;
  readonly startExport: (
    opts?: RequestOptions,
  ) => Effect.Effect<ExportJobView, Forbidden | ConflictError | Unavailable, CurrentCaller>;
  readonly getExport: (
    id: ExportId,
  ) => Effect.Effect<ExportJobView, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly exportFile: (
    id: ExportId,
  ) => Effect.Effect<
    FileDownload,
    NotFound | ConflictError | Unavailable | Forbidden,
    CurrentCaller
  >;
}

const localeOf = (caller: { readonly _tag: string; readonly locale?: Locale }): Locale =>
  caller._tag === "Member" && caller.locale !== undefined ? caller.locale : "cs";

const StartExportPayload = Schema.Struct({});

export const makeReports = Effect.gen(function* () {
  const store = yield* CoreStore;
  const source = yield* ReportsSource;
  const repo = yield* ExportsRepo;
  const workflow = yield* ExportWorkflow;
  const blobs = yield* BlobStorage;
  const fx = yield* FxFixings;
  const renderer = yield* ReportPdfRenderer;
  const ids = yield* IdGenerator;

  const today = Effect.map(Clock.currentTimeMillis, pragueDate);

  const build = (
    workspaceId: WorkspaceId,
    q: Effect.Success<ReturnType<typeof validateQuery>>,
  ): Effect.Effect<ReportViewData, Unavailable> =>
    orUnavailable(
      store.transaction(
        Effect.gen(function* () {
          const { period } = q;
          switch (q.report) {
            case "revenue": {
              const docs = yield* source.documents(workspaceId, { ...period, field: "issuedOn" });
              return Compute.revenue(
                docs,
                period,
                q.groupBy === "contact" || q.groupBy === "currency" ? q.groupBy : "month",
              );
            }
            case "expenses": {
              const rows = yield* source.expenses(workspaceId, { ...period, field: "issuedOn" });
              const incomplete = yield* source.incompleteExpenses(workspaceId);
              return Compute.expenses(rows, period, q.groupBy ?? "month", incomplete);
            }
            case "profit": {
              const docs = yield* source.documents(workspaceId, { ...period, field: "issuedOn" });
              const rows = yield* source.expenses(workspaceId, { ...period, field: "issuedOn" });
              const regimes = yield* source.taxRegimes(workspaceId);
              return Compute.profit(docs, rows, regimes, period);
            }
            case "cashflow": {
              const value_1 = yield* source.payments(workspaceId, period);
              return Compute.cashflow(value_1, period);
            }
            case "receivables": {
              const value_1 = yield* source.openReceivables(workspaceId);
              const today_1 = yield* today;
              return Compute.receivables(value_1, period, today_1);
            }
            case "vat_summary": {
              const docs = yield* source.documents(workspaceId, { ...period, field: "taxPoint" });
              const rows = yield* source.expenses(workspaceId, { ...period, field: "taxPoint" });
              const regimes = yield* source.taxRegimes(workspaceId);
              return Compute.vatSummary(docs, rows, regimes, period);
            }
          }
        }),
      ),
    );

  /** A live export row of this Workspace; expired ones are gone (NotFound), as after Housekeeping. */
  const liveExport = Effect.fn("liveExport")(function* (workspaceId: WorkspaceId, id: ExportId) {
    const row = yield* store.transaction(repo.get(workspaceId, id));
    const currentTimeMillis_1 = yield* Clock.currentTimeMillis;
    const now = DateTime.formatIso(DateTime.makeUnsafe(currentTimeMillis_1));
    if (row.expiresAt !== null && row.expiresAt <= now) return yield* notFoundExport(id);
    return row;
  });

  const impl: ReportsImpl = {
    run: Effect.fn("run")(function* (q) {
      const { workspaceId } = yield* authorizeInWorkspace("report.run");
      const value_1 = yield* validateQuery(q);
      return yield* build(workspaceId, value_1);
    }),

    export: Effect.fn("export")(function* (q, format) {
      const { caller, workspaceId } = yield* authorizeInWorkspace("report.export");
      const query = yield* validateQuery(q);
      const view = yield* build(workspaceId, query);
      const base = `${query.report}_${query.period.from}_${query.period.to}`;
      const locale = localeOf(caller);
      if (format === "csv") {
        return {
          filename: `${base}.csv`,
          contentType: CSV_CONTENT_TYPE,
          bytes: csvStream(reportTable(view), locale),
        };
      }
      const bytes = yield* renderer.render({ workspaceId, locale, view });
      return {
        filename: `${base}.pdf`,
        contentType: "application/pdf",
        bytes: Stream.succeed(bytes),
      };
    }),

    dashboard: Effect.fn("dashboard")(function* (period) {
      const { workspaceId } = yield* authorizeInWorkspace("report.run");
      const valid = yield* validatePeriod(period);
      const day = yield* today;
      const window = Compute.twelveMonthsEnding(valid.to);
      if (window === null) return yield* malformed(["period", "to"], "too_early");
      return yield* orUnavailable(
        store.transaction(
          Effect.gen(function* () {
            return Compute.dashboard({
              period: valid,
              today: day,
              issued: yield* source.documents(workspaceId, { ...valid, field: "issuedOn" }),
              open: yield* source.openReceivables(workspaceId),
              expenses: yield* source.expenses(workspaceId, { ...valid, field: "issuedOn" }),
              regimes: yield* source.taxRegimes(workspaceId),
              incompleteExpenses: yield* source.incompleteExpenses(workspaceId),
              payments: yield* source.payments(workspaceId, { from: window.from, to: valid.to }),
              months: window.months,
            });
          }),
        ),
      );
    }),

    fxRate: Effect.fn("fxRate")(function* (q) {
      yield* authorizeInWorkspace("report.run");
      if (!isIsoDate(q.on)) return yield* malformed(["on"], "date_invalid");
      const fixing = yield* orUnavailable(fx.fixing(q.on));
      const rate = yield* Effect.fromResult(Fx.fromFixing(fixing, q.currency));
      return {
        currency: q.currency,
        rate: rate.rate,
        quantity: rate.quantity,
        fixingDate: fixing.fixingDate,
        source: "cnb" as const,
      };
    }),

    startExport: Effect.fn("startExport")(function* (opts) {
      const { caller, workspaceId } = yield* authorizeInWorkspace("report.export");
      // R5: report.export is a read action, but starting a job writes; the DataExport job
      // itself only reads, so it can never start (or restart) an export.
      if (caller._tag === "System" && caller.job._tag === "DataExport") {
        return yield* ForbiddenError.make({ action: "report.export" });
      }
      const attempt = (
        round: number,
      ): Effect.Effect<ExportJobView, StoreUnavailable, CoreStore | IdGenerator | CurrentCaller> =>
        Effect.gen(function* () {
          const running = yield* repo.findRunning(workspaceId);
          if (Option.isSome(running)) return toExportJobView(running.value);
          const id = yield* newId(ExportIdSchema.make);
          const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
          const row: ExportRow = {
            id,
            workspaceId,
            revision: 1,
            status: "running",
            createdAt,
            readyAt: null,
            expiresAt: null,
            sizeBytes: null,
          };
          // A savepoint, so a concurrent start's clash on the one-running index leaves the
          // outer transaction usable and the caller gets the job that won. Any other unique
          // violation is a bug.
          const inserted = yield* store.transaction(repo.insert(row)).pipe(
            Effect.asSome,
            Effect.catchTag("UniqueViolation", (e) =>
              e.constraint === ONE_RUNNING_EXPORT
                ? Effect.succeed(Option.none<ExportRow>())
                : Effect.die(e),
            ),
          );
          if (Option.isNone(inserted)) {
            const winner = yield* repo.findRunning(workspaceId);
            if (Option.isSome(winner)) return toExportJobView(winner.value);
            // The winner already finished: start afresh (bounded; each round needs a new race).
            if (round >= 3) {
              // Contention that outlives every retry: a retryable database failure
              // (Unavailable{database}), never a defect.
              return yield* StoreUnavailable.make({ cause: "export start contention" });
            }
            return yield* attempt(round + 1);
          }
          yield* appendAudit({
            workspaceId,
            subject: { entity: "Export", id },
            action: "report.export",
            revision: inserted.value.revision,
          });
          yield* store.afterCommit(workflow.start({ workspaceId, exportId: id }));
          return toExportJobView(inserted.value);
        });
      const body = attempt(1);
      return yield* orUnavailable(
        withIdempotency(
          {
            scope: { _tag: "Workspace", workspaceId },
            key: opts?.requestKey,
            method: "Reports.startExport",
            payload: { schema: StartExportPayload, value: {} },
            result: ExportJobViewSchema,
          },
          body,
        ),
      ).pipe(Effect.provideService(CoreStore, store), Effect.provideService(IdGenerator, ids));
    }),

    getExport: Effect.fn("getExport")(function* (id) {
      const { workspaceId } = yield* authorizeInWorkspace("report.export");
      const value_1 = yield* orUnavailable(liveExport(workspaceId, id));
      return toExportJobView(value_1);
    }),

    exportFile: Effect.fn("exportFile")(function* (id) {
      const { workspaceId } = yield* authorizeInWorkspace("report.export");
      const row = yield* orUnavailable(liveExport(workspaceId, id));
      if (row.status !== "ready") {
        return yield* Conflict.make({ reason: "illegal_transition", detail: "export.not_ready" });
      }
      const bytes = yield* orUnavailable(
        blobs
          .get(exportBlobKey(workspaceId, id))
          .pipe(Effect.catchTag("BlobMissing", () => Effect.fail(notFoundExport(id)))),
      );
      return {
        filename: `kvitbit-export-${EffectString.slice(0, 10)(row.createdAt)}.zip`,
        contentType: "application/zip",
        bytes,
      };
    }),
  };
  return impl;
});

/**
 * The one cast at the layer boundary (board #340/#341): `run` yields the concrete
 * `ReportViewData`, which the opaque branded `ReportView` does not accept, so only its success
 * value is cast; the error channel is checked against the tag.
 */
export const ReportsLive: Layer.Layer<
  Reports,
  never,
  | CoreStore
  | IdGenerator
  | ReportsSource
  | ExportsRepo
  | ExportWorkflow
  | BlobStorage
  | FxFixings
  | ReportPdfRenderer
> = Layer.effect(
  Reports,
  Effect.map(makeReports, (impl) =>
    Reports.of({
      ...impl,
      run: Effect.fn("Reports.run")((q) =>
        Effect.map(impl.run(q), (view) => ReportView.make(view)),
      ),
    }),
  ),
);
