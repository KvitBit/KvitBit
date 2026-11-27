import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";

/**
 * Full data export jobs (core-ports 4.9, 7.2 DataExport, flow 9.7): the `exports` table, the
 * `ExportWorkflow` starter port, and `ExportJobs`, the core-internal service the DataExport
 * workflow and Housekeeping call (no authorize: the workflow runs as System, rule R5).
 */

import type {
  Conflict,
  ExportId,
  ExportJobView,
  Locale,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  ExportId as ExportIdSchema,
  IsoDate,
  NotFound as NotFoundError,
  WorkspaceId as WorkspaceIdSchema,
} from "@kvitbit/domain/contract";
import type { BlobUnavailable } from "@kvitbit/domain/ports";
import { BlobKey, BlobStorage } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { CoreStore } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import type { CsvTable } from "./csv";
import { CSV_CONTENT_TYPE, csvStream } from "./csv";
import { ReportsSource } from "./source";
import { documentsTable, expensesTable, paymentsTable } from "./tables";

/** A ready export is kept 7 days after `readyAt`. */
export const EXPORT_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000;

export const ExportRow = Schema.Struct({
  id: ExportIdSchema,
  workspaceId: WorkspaceIdSchema,
  revision: Schema.Finite,
  status: Schema.Literals(["running", "ready", "failed"]),
  createdAt: Schema.String,
  readyAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Int),
});
export type ExportRow = typeof ExportRow.Type;

/** Unique index: one running export per Workspace. */
export const ONE_RUNNING_EXPORT = "exports_one_running_per_workspace";

export const ExportsTable = defineCollection<ExportRow>({
  name: "exports",
  entity: "Export",
  schema: ExportRow,
  unique: [
    {
      name: ONE_RUNNING_EXPORT,
      scope: "workspace",
      key: (row) => (row.status === "running" ? [] : null),
    },
  ],
});

export const toExportJobView = (row: ExportRow): ExportJobView => ({
  id: row.id,
  status: row.status,
  createdAt: row.createdAt,
  readyAt: row.readyAt,
  expiresAt: row.expiresAt,
  sizeBytes: row.sizeBytes,
});

/** Deterministic, overwrite-safe ZIP key (7.2). */
export const exportBlobKey: {
  (id: ExportId): (workspaceId: WorkspaceId) => BlobKey;
  (workspaceId: WorkspaceId, id: ExportId): BlobKey;
} = Fn.dual(
  2,
  (workspaceId: WorkspaceId, id: ExportId): BlobKey =>
    BlobKey.make(`exports/${workspaceId}/${id}.zip`),
);

export class ExportsRepo extends Context.Service<
  ExportsRepo,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      id: ExportId,
    ) => Effect.Effect<ExportRow, NotFound | StoreUnavailable>;
    /** Row-lock without a revision (state-idempotent finish/fail, rule C6). */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: ExportId,
    ) => Effect.Effect<ExportRow, NotFound | StoreUnavailable>;
    readonly findRunning: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<Option.Option<ExportRow>, StoreUnavailable>;
    readonly insert: (
      row: ExportRow,
    ) => Effect.Effect<ExportRow, UniqueViolation | StoreUnavailable>;
    readonly update: (
      next: ExportRow,
      expectedRevision: number,
    ) => Effect.Effect<ExportRow, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    /** Every Workspace's rows past `expiresAt`, and failed rows created before `failedBefore` (Housekeeping). */
    readonly listExpired: (
      nowIso: string,
      failedBefore: string,
    ) => Effect.Effect<ReadonlyArray<ExportRow>, StoreUnavailable>;
    readonly remove: (
      workspaceId: WorkspaceId,
      id: ExportId,
      expectedRevision: number,
    ) => Effect.Effect<void, NotFound | Conflict | StoreUnavailable>;
  }
>()("@kvitbit/core/modules/reports/exports/ExportsRepo") {}

/** In-memory `ExportsRepo` on `MemoryTables` (tests). */
export const ExportsRepoMemory: Layer.Layer<ExportsRepo, never, MemoryTables> = Layer.effect(
  ExportsRepo,
  Effect.map(MemoryTables, (tables) => {
    const table = tables.collection(ExportsTable);
    return {
      get: (workspaceId, id) => table.get(workspaceId, id),
      lock: (workspaceId, id) => table.lock(workspaceId, id),
      findRunning: (workspaceId) => table.findUnique(ONE_RUNNING_EXPORT, [], workspaceId),
      insert: table.insert,
      update: table.update,
      listExpired: (nowIso, failedBefore) =>
        Effect.map(table.listGlobal(), (rows) =>
          EffectArray.filter(
            rows,
            (r) =>
              (r.status === "ready" && r.expiresAt !== null && r.expiresAt <= nowIso) ||
              (r.status === "failed" && r.createdAt < failedBefore),
          ),
        ),
      remove: table.remove,
    };
  }),
);

// Workflow starter ----------------------------------------------------------------------------

/**
 * Starts the DataExport workflow (idempotency key = exportId). The composition root provides it
 * from `DataExport.execute`; `Reports.startExport` calls it after commit.
 */
export class ExportWorkflow extends Context.Service<
  ExportWorkflow,
  {
    readonly start: (job: {
      readonly workspaceId: WorkspaceId;
      readonly exportId: ExportId;
    }) => Effect.Effect<void>;
  }
>()("@kvitbit/core/modules/reports/exports/ExportWorkflow") {}

export class FakeExportWorkflow extends Context.Service<
  FakeExportWorkflow,
  {
    readonly started: Ref.Ref<
      ReadonlyArray<{ readonly workspaceId: WorkspaceId; readonly exportId: ExportId }>
    >;
  }
>()("@kvitbit/core/modules/reports/exports/FakeExportWorkflow") {
  static readonly layer: Layer.Layer<ExportWorkflow | FakeExportWorkflow> = Layer.effect(
    ExportWorkflow,
    Effect.map(FakeExportWorkflow, (fake) => ({
      start: (job: { readonly workspaceId: WorkspaceId; readonly exportId: ExportId }) =>
        Ref.update(fake.started, (all) => [...all, job]),
    })),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        FakeExportWorkflow,
        Effect.map(
          Ref.make<
            ReadonlyArray<{ readonly workspaceId: WorkspaceId; readonly exportId: ExportId }>
          >([]),
          (started) => ({ started }),
        ),
      ),
    ),
  );
}

// ExportJobs (DataExport workflow + Housekeeping) ---------------------------------------------

export interface ExportFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Stream.Stream<Uint8Array>;
}

const ALL_TIME = { from: IsoDate.make("0000-01-01"), to: IsoDate.make("9999-12-31") };

/**
 * Archive paths of `reportingTables`. They are reporting views (issued and cancelled documents,
 * live payments, complete Expenses), NOT the tables: the canonical full-table CSVs of 7.2
 * (`documents.csv` with drafts, `expenses.csv` with incomplete Expenses, every other table) are
 * the DataExport workflow's, built from each table's owner.
 */
export const REPORTING_FILES = {
  documents: "reports/issued-documents.csv",
  payments: "reports/payments.csv",
  expenses: "reports/complete-expenses.csv",
} as const;

export interface ExportJobsShape {
  /**
   * Part of activity "build": CSVs of the reporting rows ReportsSource can read (documents,
   * payments, Expenses), sorted by id, streamed row by row. Reads only. NOT the full table dump
   * of 7.2: the workflow adds every other table's CSV, document PDFs (through the PDF cache) and
   * Expense attachments from their owners.
   */
  readonly reportingTables: (
    workspaceId: WorkspaceId,
    locale: Locale,
  ) => Effect.Effect<ReadonlyArray<ExportFile>, StoreUnavailable>;
  /** Activity "finish": running -> ready (readyAt now, expiresAt +7 days). Other states unchanged. */
  readonly finish: (
    workspaceId: WorkspaceId,
    id: ExportId,
    sizeBytes: number,
  ) => Effect.Effect<ExportJobView, NotFound | StoreUnavailable>;
  /** running -> failed. Other states unchanged. */
  readonly fail: (
    workspaceId: WorkspaceId,
    id: ExportId,
  ) => Effect.Effect<ExportJobView, NotFound | StoreUnavailable>;
  /** Housekeeping: deletes ready exports past expiresAt (row and ZIP) and failed ones older than 7 days. Returns how many. */
  readonly purgeExpired: Effect.Effect<number, StoreUnavailable | BlobUnavailable>;
}

export class ExportJobs extends Context.Service<ExportJobs, ExportJobsShape>()(
  "@kvitbit/core/modules/reports/exports/ExportJobs",
) {}

/** Under the row lock a revision conflict or a running-index clash is a bug, never a user error. */
const orDieConflict = <A, R>(
  effect: Effect.Effect<A, NotFound | Conflict | UniqueViolation | StoreUnavailable, R>,
) => Effect.catchTag(effect, ["Conflict", "UniqueViolation"], (e) => Effect.die(e));

export const ExportJobsLive: Layer.Layer<
  ExportJobs,
  never,
  CoreStore | ExportsRepo | ReportsSource | BlobStorage
> = Layer.effect(
  ExportJobs,
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const repo = yield* ExportsRepo;
    const source = yield* ReportsSource;
    const blobs = yield* BlobStorage;

    const transition = (
      workspaceId: WorkspaceId,
      id: ExportId,
      next: (row: ExportRow, now: number) => ExportRow,
    ) =>
      store.transaction(
        Effect.gen(function* () {
          const row = yield* repo.lock(workspaceId, id);
          if (row.status !== "running") return toExportJobView(row);
          const now = yield* Clock.currentTimeMillis;
          const value = yield* orDieConflict(repo.update(next(row, now), row.revision));
          return toExportJobView(value);
        }),
      );

    const csv = (name: string, table: CsvTable, locale: Locale): ExportFile => ({
      name,
      contentType: CSV_CONTENT_TYPE,
      bytes: csvStream(table, locale),
    });

    return {
      reportingTables: Effect.fn("ExportJobs.reportingTables")((workspaceId, locale) =>
        store.transaction(
          Effect.gen(function* () {
            const documents = yield* source.documents(workspaceId, {
              ...ALL_TIME,
              field: "issuedOn",
            });
            const payments = yield* source.payments(workspaceId, ALL_TIME);
            const expenses = yield* source.expenses(workspaceId, {
              ...ALL_TIME,
              field: "issuedOn",
            });
            return [
              csv(REPORTING_FILES.documents, documentsTable(documents), locale),
              csv(REPORTING_FILES.payments, paymentsTable(payments), locale),
              csv(REPORTING_FILES.expenses, expensesTable(expenses), locale),
            ];
          }),
        ),
      ),
      finish: Effect.fn("ExportJobs.finish")((workspaceId, id, sizeBytes) =>
        transition(workspaceId, id, (row, now) => ({
          ...row,
          status: "ready",
          readyAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + EXPORT_RETENTION_MILLIS)),
          sizeBytes,
        })),
      ),
      fail: Effect.fn("ExportJobs.fail")((workspaceId, id) =>
        transition(workspaceId, id, (row) => ({ ...row, status: "failed" })),
      ),
      purgeExpired: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const expired = yield* repo.listExpired(
          DateTime.formatIso(DateTime.makeUnsafe(now)),
          DateTime.formatIso(DateTime.makeUnsafe(now - EXPORT_RETENTION_MILLIS)),
        );
        for (const row of expired) {
          // Blob first: a crash in between leaves the row, and the next run retries both.
          yield* blobs.delete(exportBlobKey(row.workspaceId, row.id));
          yield* store.transaction(
            Effect.catchTag(
              repo.remove(row.workspaceId, row.id, row.revision),
              ["NotFound", "Conflict"],
              () => Effect.void,
            ),
          );
        }
        return expired.length;
      }),
    };
  }),
);

export const notFoundExport = (id: ExportId) => NotFoundError.make({ entity: "Export", id });
