/**
 * `DeliveriesRepo`: the `deliveries` table with the repository conventions of
 * src/store/tables.ts (Workspace-scoped, row lock, compare-and-set `update`, `UniqueViolation`
 * per index name, `StoreUnavailable`), plus `DeliveriesRepoMemory`.
 */
import type {
  Conflict,
  DeliveryId,
  DocumentId,
  IsoDate,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type { Option } from "effect";
import { Context, Effect, Layer } from "effect";
import type { StoreUnavailable, UniqueViolation } from "../../../store/CoreStore";
import { MemoryTables } from "../../../store/tables";
import type { DeliveryRecord, DeliveryStatus } from "./record";
import { DeliveriesTable, REMINDER_STEP } from "./record";

export class DeliveriesRepo extends Context.Service<
  DeliveriesRepo,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      id: DeliveryId,
    ) => Effect.Effect<DeliveryRecord, NotFound | StoreUnavailable>;
    /** Row lock without a revision: job steps are idempotent by status (C6). */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: DeliveryId,
    ) => Effect.Effect<DeliveryRecord, NotFound | StoreUnavailable>;
    readonly insert: (
      row: DeliveryRecord,
    ) => Effect.Effect<DeliveryRecord, UniqueViolation | StoreUnavailable>;
    /** Compare-and-set (`Conflict{revision_changed}` on a stale revision). */
    readonly update: (
      next: DeliveryRecord,
      expectedRevision: number,
    ) => Effect.Effect<DeliveryRecord, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    /** A document's deliveries in queueing order (`sequence`). */
    readonly byDocument: (
      workspaceId: WorkspaceId,
      documentId: DocumentId,
    ) => Effect.Effect<ReadonlyArray<DeliveryRecord>, StoreUnavailable>;
    /** The automatic reminder for one step, if any (unique `deliveries_reminder_step`). */
    readonly reminderStep: (
      workspaceId: WorkspaceId,
      step: {
        readonly documentId: DocumentId;
        readonly dueOn: IsoDate;
        readonly offsetDays: number;
      },
    ) => Effect.Effect<Option.Option<DeliveryRecord>, StoreUnavailable>;
    /** Status per id (DeliveryStatusLookup, board #399); other-Workspace/unknown ids absent. */
    readonly statuses: (
      workspaceId: WorkspaceId,
      ids: ReadonlyArray<DeliveryId>,
    ) => Effect.Effect<ReadonlyMap<DeliveryId, DeliveryStatus>, StoreUnavailable>;
  }
>()("kvitbit/core/DeliveriesRepo") {}

/** In-memory `DeliveriesRepo` on `MemoryTables` (tests). */
export const DeliveriesRepoMemory: Layer.Layer<DeliveriesRepo, never, MemoryTables> = Layer.effect(
  DeliveriesRepo,
  Effect.map(MemoryTables, (tables) => {
    const table = tables.collection(DeliveriesTable);
    return DeliveriesRepo.of({
      get: (workspaceId, id) => table.get(workspaceId, id),
      lock: (workspaceId, id) => table.lock(workspaceId, id),
      insert: table.insert,
      update: table.update,
      byDocument: (workspaceId, documentId) =>
        table.list(workspaceId, { where: { documentId }, orderBy: ["sequence"] }),
      reminderStep: (workspaceId, step) =>
        table.findUnique(
          REMINDER_STEP,
          [step.documentId, step.dueOn, step.offsetDays],
          workspaceId,
        ),
      statuses: (workspaceId, ids) =>
        ids.length === 0
          ? Effect.succeed(new Map())
          : Effect.map(
              table.list(workspaceId, { whereIn: { id: ids } }),
              (rows) => new Map(rows.map((row) => [row.id, row.status] as const)),
            ),
    });
  }),
);
