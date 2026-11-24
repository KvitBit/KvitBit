/**
 * `RecurringRepo`: the `templates`, `schedules` and `schedule_runs` tables of
 * packages/db/src/schema/recurring.ts with the repository conventions of src/store/tables.ts.
 *
 * - A Template's revision covers its Recurring Schedule: `Templates.schedule` and `resume`
 *   bump it. The issuance steps (advance, pause) change only the schedule row, whose own
 *   revision is the compare-and-set token of "advance" (core-ports 7.2).
 * - At most one attached schedule per Template; detaching sets `detachedAt` so run history and
 *   issued documents keep their schedule (unique index `schedules_one_attached_per_template`).
 * - One run row per (schedule, occurrence) (`schedule_runs_schedule_occurrence_unique`); a run
 *   with outcome `issued` is the exactly-once record of that occurrence.
 */
import type {
  BankAccountId,
  Conflict,
  IsoDate,
  NotFound,
  ScheduleId,
  TemplateId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  DeliveryId,
  DocumentId,
  IsoDate as IsoDateSchema,
  IssueCode,
  ScheduleId as ScheduleIdSchema,
  TemplateId as TemplateIdSchema,
  TemplateInput,
  WorkspaceId as WorkspaceIdSchema,
} from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { StoreUnavailable } from "../../store/CoreStore";
import { UniqueViolation } from "../../store/CoreStore";
import type { Scalar } from "../../store/tables";
import { defineCollection, MemoryTables } from "../../store/tables";

// Rows --------------------------------------------------------------------------------------

export const TemplateRow = Schema.Struct({
  id: TemplateIdSchema,
  workspaceId: WorkspaceIdSchema,
  revision: Schema.Number,
  name: Schema.String,
  /** The saved `TemplateInput`, name included. */
  input: TemplateInput,
  archivedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type TemplateRow = typeof TemplateRow.Type;

export const CadenceUnit = Schema.Literals(["weeks", "months", "years"]);
export type CadenceUnit = typeof CadenceUnit.Type;

export const ScheduleRow = Schema.Struct({
  id: ScheduleIdSchema,
  workspaceId: WorkspaceIdSchema,
  revision: Schema.Number,
  templateId: TemplateIdSchema,
  cadenceUnit: CadenceUnit,
  cadenceInterval: Schema.Number,
  startOn: IsoDateSchema,
  endOn: Schema.NullOr(IsoDateSchema),
  issueAs: Schema.Literals(["invoice", "proforma"]),
  autoSend: Schema.Boolean,
  /** The occurrence the next RecurringIssuance issues; null once `endOn` has passed. */
  nextOccurrence: Schema.NullOr(IsoDateSchema),
  /** Set while paused (a failed occurrence or the catch-up cap); cleared by `resume`. */
  pausedAt: Schema.NullOr(Schema.String),
  /** Why it paused; null when no IssueCode names the failure (NotFound, Forbidden). */
  pausedReason: Schema.NullOr(IssueCode),
  /**
   * The error that paused it when no IssueCode names it, e.g. `NotFound:Contact`,
   * `Forbidden:document.issue`, `Conflict:duplicate`. Not yet a column of packages/db `schedules`.
   */
  pausedError: Schema.NullOr(Schema.String),
  /**
   * Set by `resume`: occurrences on or before this date are issued however late they are, so
   * resuming after the catch-up cap issues the missed ones (core-ports 4.8). Not yet a column
   * of packages/db `schedules`.
   */
  catchUpThrough: Schema.NullOr(IsoDateSchema),
  detachedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ScheduleRow = typeof ScheduleRow.Type;

export const RunOutcome = Schema.Literals(["issued", "failed", "skipped_missed"]);
export type RunOutcome = typeof RunOutcome.Type;

/**
 * The send half of an issued run. `pending`: autoSend was on when the occurrence issued and the
 * delivery is not queued yet (a crash between issue and send leaves this). `failed`: send was
 * refused and the schedule paused. Derived in SQL from `delivery_id` and `failure`.
 */
export const RunSend = Schema.Literals(["none", "pending", "queued", "failed"]);
export type RunSend = typeof RunSend.Type;

export const RunRow = Schema.Struct({
  id: Schema.String,
  workspaceId: WorkspaceIdSchema,
  revision: Schema.Number,
  scheduleId: ScheduleIdSchema,
  occurrence: IsoDateSchema,
  outcome: RunOutcome,
  /** When the run last finished a step. */
  at: Schema.String,
  documentId: Schema.NullOr(DocumentId),
  /** Joined from `documents` in SQL. */
  documentNumber: Schema.NullOr(Schema.String),
  deliveryId: Schema.NullOr(DeliveryId),
  send: RunSend,
  failure: Schema.NullOr(IssueCode),
});
export type RunRow = typeof RunRow.Type;

// Tables ------------------------------------------------------------------------------------

export const ONE_ATTACHED_PER_TEMPLATE = "schedules_one_attached_per_template";
export const RUN_PER_OCCURRENCE = "schedule_runs_schedule_occurrence_unique";

const codec = <A>(schema: Schema.Codec<A, unknown>) => schema;

export const TemplatesTable = defineCollection<TemplateRow>({
  name: "templates",
  entity: "Template",
  schema: codec(TemplateRow as unknown as Schema.Codec<TemplateRow, unknown>),
});

export const SchedulesTable = defineCollection<ScheduleRow>({
  name: "schedules",
  entity: "Schedule",
  schema: codec(ScheduleRow as unknown as Schema.Codec<ScheduleRow, unknown>),
  unique: [
    {
      name: ONE_ATTACHED_PER_TEMPLATE,
      scope: "workspace",
      key: (row) => (row.detachedAt === null ? [row.templateId] : null),
    },
  ],
});

export const ScheduleRunsTable = defineCollection<RunRow>({
  name: "schedule_runs",
  entity: "Schedule",
  schema: codec(RunRow as unknown as Schema.Codec<RunRow, unknown>),
  unique: [
    {
      name: RUN_PER_OCCURRENCE,
      scope: "workspace",
      key: (row) => [row.scheduleId, row.occurrence],
    },
  ],
});

// Port --------------------------------------------------------------------------------------

/** A page of runs, newest occurrence first; `after` is the (occurrence, id) of the last row. */
export interface RunsQuery {
  readonly scheduleIds: ReadonlyArray<ScheduleId>;
  readonly after?: readonly [IsoDate, string];
  readonly limit: number;
}

export class RecurringRepo extends Context.Service<
  RecurringRepo,
  {
    readonly getTemplate: (
      workspaceId: WorkspaceId,
      id: TemplateId,
    ) => Effect.Effect<TemplateRow, NotFound | StoreUnavailable>;
    /** Row-lock with the caller's revision (C2). */
    readonly lockTemplate: (
      workspaceId: WorkspaceId,
      id: TemplateId,
      expectedRevision: number,
    ) => Effect.Effect<TemplateRow, NotFound | Conflict | StoreUnavailable>;
    /** Row-lock without a revision, for methods idempotent by state (C6). */
    readonly lockTemplateState: (
      workspaceId: WorkspaceId,
      id: TemplateId,
    ) => Effect.Effect<TemplateRow, NotFound | StoreUnavailable>;
    /** Templates not archived, by name then id. */
    readonly listTemplates: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<ReadonlyArray<TemplateRow>, StoreUnavailable>;
    readonly insertTemplate: (
      row: TemplateRow,
    ) => Effect.Effect<TemplateRow, UniqueViolation | StoreUnavailable>;
    readonly updateTemplate: (
      next: TemplateRow,
      expectedRevision: number,
    ) => Effect.Effect<TemplateRow, NotFound | Conflict | UniqueViolation | StoreUnavailable>;

    /** The schedule attached to the Template (not detached), if any. */
    readonly attachedSchedule: (
      workspaceId: WorkspaceId,
      templateId: TemplateId,
    ) => Effect.Effect<Option.Option<ScheduleRow>, StoreUnavailable>;
    /** Every schedule the Template ever had, detached ones included. */
    readonly schedulesOfTemplate: (
      workspaceId: WorkspaceId,
      templateId: TemplateId,
    ) => Effect.Effect<ReadonlyArray<ScheduleRow>, StoreUnavailable>;
    readonly lockSchedule: (
      workspaceId: WorkspaceId,
      id: ScheduleId,
    ) => Effect.Effect<ScheduleRow, NotFound | StoreUnavailable>;
    readonly insertSchedule: (
      row: ScheduleRow,
    ) => Effect.Effect<ScheduleRow, UniqueViolation | StoreUnavailable>;
    readonly updateSchedule: (
      next: ScheduleRow,
      expectedRevision: number,
    ) => Effect.Effect<ScheduleRow, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    /**
     * Cross-tenant (RecurringSweep): attached, unpaused schedules whose next occurrence is on or
     * before `today`.
     */
    readonly dueSchedules: (
      today: IsoDate,
    ) => Effect.Effect<ReadonlyArray<ScheduleRow>, StoreUnavailable>;

    readonly findRun: (
      workspaceId: WorkspaceId,
      scheduleId: ScheduleId,
      occurrence: IsoDate,
    ) => Effect.Effect<Option.Option<RunRow>, StoreUnavailable>;
    /** The latest occurrence of the schedule that issued a document, if any. */
    readonly lastIssuedRun: (
      workspaceId: WorkspaceId,
      scheduleId: ScheduleId,
    ) => Effect.Effect<Option.Option<RunRow>, StoreUnavailable>;
    /**
     * Cross-tenant (outbox reconcile, J1a): issued runs whose send is still `pending` and whose
     * last step finished before `before` (ISO instant), oldest first.
     */
    readonly pendingSendRuns: (
      before: string,
    ) => Effect.Effect<ReadonlyArray<RunRow>, StoreUnavailable>;
    readonly insertRun: (row: RunRow) => Effect.Effect<RunRow, UniqueViolation | StoreUnavailable>;
    readonly updateRun: (
      next: RunRow,
      expectedRevision: number,
    ) => Effect.Effect<RunRow, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    readonly listRuns: (
      workspaceId: WorkspaceId,
      query: RunsQuery,
    ) => Effect.Effect<ReadonlyArray<RunRow>, StoreUnavailable>;

    // Bank account references (compose/bankAccounts.ts) --------------------------------------
    /** Templates not archived whose saved input names the bank account, by name then id. */
    readonly templatesUsingBankAccount: (
      workspaceId: WorkspaceId,
      bankAccountId: BankAccountId,
    ) => Effect.Effect<ReadonlyArray<TemplateRow>, StoreUnavailable>;
  }
>()("kvitbit/core/RecurringRepo") {}

/** In-memory `RecurringRepo` on `MemoryTables` (tests). */
export const RecurringRepoMemory: Layer.Layer<RecurringRepo, never, MemoryTables> = Layer.effect(
  RecurringRepo,
  Effect.map(MemoryTables, (tables) => {
    const templates = tables.collection(TemplatesTable);
    const schedules = tables.collection(SchedulesTable);
    const runs = tables.collection(ScheduleRunsTable);
    return RecurringRepo.of({
      getTemplate: (ws, id) => templates.get(ws, id),
      lockTemplate: (ws, id, expectedRevision) => templates.getForUpdate(ws, id, expectedRevision),
      lockTemplateState: (ws, id) => templates.lock(ws, id),
      listTemplates: (ws) => templates.list(ws, { where: { archivedAt: null }, orderBy: ["name"] }),
      insertTemplate: templates.insert,
      updateTemplate: templates.update,
      attachedSchedule: (ws, templateId) =>
        schedules.findUnique(ONE_ATTACHED_PER_TEMPLATE, [templateId], ws),
      schedulesOfTemplate: (ws, templateId) =>
        schedules.list(ws, { where: { templateId }, orderBy: ["createdAt"] }),
      lockSchedule: (ws, id) => schedules.lock(ws, id),
      insertSchedule: schedules.insert,
      updateSchedule: schedules.update,
      dueSchedules: (today) =>
        schedules.listGlobal({
          where: { detachedAt: null, pausedAt: null },
          range: { nextOccurrence: { lte: today } },
          orderBy: ["nextOccurrence"],
        }),
      findRun: (ws, scheduleId, occurrence) =>
        runs.findUnique(RUN_PER_OCCURRENCE, [scheduleId, occurrence], ws),
      lastIssuedRun: (ws, scheduleId) =>
        Effect.map(
          runs.list(ws, {
            where: { scheduleId, outcome: "issued" },
            orderBy: ["occurrence"],
            direction: "desc",
            limit: 1,
          }),
          (rows) => Option.fromNullishOr(rows[0]),
        ),
      pendingSendRuns: (before) =>
        runs.listGlobal({
          where: { outcome: "issued", send: "pending" },
          range: { at: { lt: before } },
          orderBy: ["at"],
        }),
      insertRun: runs.insert,
      updateRun: runs.update,
      listRuns: (ws, query) =>
        runs.list(ws, {
          whereIn: { scheduleId: query.scheduleIds },
          orderBy: ["occurrence"],
          direction: "desc",
          ...(query.after !== undefined ? { after: query.after as ReadonlyArray<Scalar> } : {}),
          limit: query.limit,
        }),

      // Bank account references --------------------------------------------------------------
      templatesUsingBankAccount: (ws, bankAccountId) =>
        Effect.map(templates.list(ws, { where: { archivedAt: null }, orderBy: ["name"] }), (rows) =>
          rows.filter((row) => row.input.bankAccount === bankAccountId),
        ),
    });
  }),
);

/**
 * Every unique index of this module is guarded by a row lock taken first (the Template for
 * `schedules`, the schedule for `schedule_runs`), so a violation is a bug: a defect.
 */
export const dieOnUnique = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, UniqueViolation>, R> =>
  Effect.catchIf(
    effect,
    (error): error is E & UniqueViolation => error instanceof UniqueViolation,
    (error) => Effect.die(error),
  ) as Effect.Effect<A, Exclude<E, UniqueViolation>, R>;
