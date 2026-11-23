/**
 * `ExpensesRepo`: the `expenses` and `attachments` tables with the repository conventions of
 * src/store/tables.ts. Rows are returned raw, removed Expenses included; the service treats a
 * removed Expense as NotFound.
 */
import type {
  AttachmentId,
  Conflict,
  ExpenseId,
  ExpenseStatus,
  IsoDate,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type { Option } from "effect";
import { Context, Effect, Layer, type Schema } from "effect";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import { AttachmentRow, ExpenseRow } from "./model";

/** Unique index: one attachment per content hash on an Expense (attach is idempotent by hash). */
export const ATTACHMENT_SHA_UNIQUE = "attachments_expense_sha256_unique";

export const ExpensesTable = defineCollection<ExpenseRow>({
  name: "expenses",
  entity: "Expense",
  schema: ExpenseRow as unknown as Schema.Codec<ExpenseRow, unknown>,
});

export const AttachmentsTable = defineCollection<AttachmentRow>({
  name: "attachments",
  entity: "Attachment",
  schema: AttachmentRow as unknown as Schema.Codec<AttachmentRow, unknown>,
  unique: [
    { name: ATTACHMENT_SHA_UNIQUE, scope: "workspace", key: (a) => [a.expenseId, a.sha256] },
  ],
});

export interface ExpensePageRequest {
  /** Only this status; absent: every status. */
  readonly status?: ExpenseStatus;
  /** Keyset: ids strictly below this one (newest first). */
  readonly beforeId?: ExpenseId;
  readonly limit: number;
}

export class ExpensesRepo extends Context.Service<
  ExpensesRepo,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      id: ExpenseId,
    ) => Effect.Effect<ExpenseRow, NotFound | StoreUnavailable>;
    /** Row-lock without a revision; the caller runs `checkRevision` after its NotFound rules. */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: ExpenseId,
    ) => Effect.Effect<ExpenseRow, NotFound | StoreUnavailable>;
    readonly insert: (
      row: ExpenseRow,
    ) => Effect.Effect<ExpenseRow, UniqueViolation | StoreUnavailable>;
    readonly update: (
      next: ExpenseRow,
      expectedRevision: number,
    ) => Effect.Effect<ExpenseRow, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    /** Live (not removed) Expenses, newest first (id desc). */
    readonly page: (
      workspaceId: WorkspaceId,
      request: ExpensePageRequest,
    ) => Effect.Effect<ReadonlyArray<ExpenseRow>, StoreUnavailable>;
    /** Live complete Expenses whose `field` falls in [from, to]. */
    readonly completeIn: (
      workspaceId: WorkspaceId,
      range: {
        readonly field: "issuedOn" | "taxPoint";
        readonly from: IsoDate;
        readonly to: IsoDate;
      },
    ) => Effect.Effect<ReadonlyArray<ExpenseRow>, StoreUnavailable>;
    readonly countIncomplete: (workspaceId: WorkspaceId) => Effect.Effect<number, StoreUnavailable>;

    readonly getAttachment: (
      workspaceId: WorkspaceId,
      id: AttachmentId,
    ) => Effect.Effect<AttachmentRow, NotFound | StoreUnavailable>;
    readonly findAttachment: (
      workspaceId: WorkspaceId,
      id: AttachmentId,
    ) => Effect.Effect<Option.Option<AttachmentRow>, StoreUnavailable>;
    readonly findAttachmentBySha: (
      workspaceId: WorkspaceId,
      expenseId: ExpenseId,
      sha256: string,
    ) => Effect.Effect<Option.Option<AttachmentRow>, StoreUnavailable>;
    readonly insertAttachment: (
      row: AttachmentRow,
    ) => Effect.Effect<AttachmentRow, UniqueViolation | StoreUnavailable>;
    readonly removeAttachment: (
      workspaceId: WorkspaceId,
      id: AttachmentId,
      expectedRevision: number,
    ) => Effect.Effect<void, NotFound | Conflict | StoreUnavailable>;
    /** Attachments of the given Expenses, oldest first. */
    readonly attachmentsOf: (
      workspaceId: WorkspaceId,
      expenseIds: ReadonlyArray<ExpenseId>,
    ) => Effect.Effect<ReadonlyArray<AttachmentRow>, StoreUnavailable>;
  }
>()("kvitbit/core/ExpensesRepo") {}

/** In-memory `ExpensesRepo` on `MemoryTables` (tests). */
export const ExpensesRepoMemory: Layer.Layer<ExpensesRepo, never, MemoryTables> = Layer.effect(
  ExpensesRepo,
  Effect.map(MemoryTables, (tables) => {
    const expenses = tables.collection(ExpensesTable);
    const attachments = tables.collection(AttachmentsTable);
    const live = (rows: ReadonlyArray<ExpenseRow>) => rows.filter((r) => r.removedAt === null);
    return {
      get: (ws, id) => expenses.get(ws, id),
      lock: (ws, id) => expenses.lock(ws, id),
      insert: expenses.insert,
      update: expenses.update,
      page: (ws, request) =>
        expenses
          .list(ws, {
            where: {
              removedAt: null,
              ...(request.status === undefined ? {} : { status: request.status }),
            },
            ...(request.beforeId === undefined ? {} : { range: { id: { lt: request.beforeId } } }),
            orderBy: ["id"],
            direction: "desc",
            limit: request.limit,
          })
          .pipe(Effect.map(live)),
      completeIn: (ws, range) =>
        expenses.list(ws, { where: { status: "complete", removedAt: null } }).pipe(
          Effect.map((rows) =>
            rows.filter((r) => {
              const date = range.field === "issuedOn" ? r.issuedOn : (r.figures?.taxPoint ?? null);
              return date !== null && date >= range.from && date <= range.to;
            }),
          ),
        ),
      countIncomplete: (ws) =>
        expenses
          .list(ws, { where: { status: "incomplete", removedAt: null } })
          .pipe(Effect.map((rows) => rows.length)),
      getAttachment: (ws, id) => attachments.get(ws, id),
      findAttachment: (ws, id) => attachments.find(ws, id),
      findAttachmentBySha: (ws, expenseId, sha256) =>
        attachments.findUnique(ATTACHMENT_SHA_UNIQUE, [expenseId, sha256], ws),
      insertAttachment: attachments.insert,
      removeAttachment: (ws, id, rev) => attachments.remove(ws, id, rev),
      attachmentsOf: (ws, expenseIds) =>
        expenseIds.length === 0
          ? Effect.succeed([])
          : attachments.list(ws, {
              whereIn: { expenseId: [...expenseIds] },
              orderBy: ["createdAt"],
            }),
    };
  }),
);
