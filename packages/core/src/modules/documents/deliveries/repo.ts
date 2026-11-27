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
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
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
        readonly armedBy: number;
      },
    ) => Effect.Effect<Option.Option<DeliveryRecord>, StoreUnavailable>;
    /** Status per id (DeliveryStatusLookup, board #399); other-Workspace/unknown ids absent. */
    readonly statuses: (
      workspaceId: WorkspaceId,
      ids: ReadonlyArray<DeliveryId>,
    ) => Effect.Effect<ReadonlyMap<DeliveryId, DeliveryStatus>, StoreUnavailable>;
    /**
     * Cross-tenant (OutboxReconcile, J1a): deliveries still `queued` or `sending` whose
     * `updatedAt` is before `before` (ISO instant), oldest first.
     */
    readonly findStaleQueuedOrSending: (
      before: string,
    ) => Effect.Effect<ReadonlyArray<DeliveryRecord>, StoreUnavailable>;
  }
>()("@kvitbit/core/modules/documents/deliveries/repo/DeliveriesRepo") {}

/** In-memory `DeliveriesRepo` on `MemoryTables` (tests). */
export const DeliveriesRepoMemory: Layer.Layer<DeliveriesRepo, never, MemoryTables> = Layer.effect(
  DeliveriesRepo,
  Effect.map(MemoryTables, (tables) => {
    const table = tables.collection(DeliveriesTable);
    return DeliveriesRepo.of({
      get: Effect.fn("DeliveriesRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
      lock: Effect.fn("DeliveriesRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
      insert: table.insert,
      update: table.update,
      byDocument: Effect.fn("DeliveriesRepo.byDocument")((workspaceId, documentId) =>
        table.list(workspaceId, { where: { documentId }, orderBy: ["sequence"] }),
      ),
      reminderStep: Effect.fn("DeliveriesRepo.reminderStep")((workspaceId, step) =>
        table.findUnique(
          REMINDER_STEP,
          [step.documentId, step.dueOn, step.offsetDays, step.armedBy],
          workspaceId,
        ),
      ),
      statuses: Effect.fn("DeliveriesRepo.statuses")(function* (workspaceId, ids) {
        if (ids.length === 0) return new Map<DeliveryId, DeliveryStatus>();
        const rows = yield* table.list(workspaceId, { whereIn: { id: ids } });
        return new Map(EffectArray.map(rows, (row) => [row.id, row.status] as const));
      }),
      findStaleQueuedOrSending: Effect.fn("DeliveriesRepo.findStaleQueuedOrSending")((before) =>
        table.listGlobal({
          whereIn: { status: ["queued", "sending"] },
          range: { updatedAt: { lt: before } },
          orderBy: ["updatedAt"],
        }),
      ),
    });
  }),
);
