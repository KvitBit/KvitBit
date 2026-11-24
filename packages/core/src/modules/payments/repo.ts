/**
 * `PaymentsRepo`: the `payments` table (src/store/tables.ts conventions: Workspace-scoped,
 * another Workspace's row is NotFound{Payment}; `update` is a compare-and-set) plus the named
 * reads Payments and the ReportsSource adapter need. "Live" means `removedAt` is null.
 */
import type {
  Conflict,
  DocumentId,
  ExpenseId,
  IsoDate,
  NotFound,
  PaymentId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { MemoryTables } from "../../store/tables";
import type { PaymentRecord } from "./record";
import { PaymentsTable } from "./record";

export type PaymentTargetRef = { readonly document: DocumentId } | { readonly expense: ExpenseId };

export class PaymentsRepo extends Context.Service<
  PaymentsRepo,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      id: PaymentId,
    ) => Effect.Effect<PaymentRecord, NotFound | StoreUnavailable>;
    /** Row-lock without a revision (C6: `remove` is idempotent by state). */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: PaymentId,
    ) => Effect.Effect<PaymentRecord, NotFound | StoreUnavailable>;
    readonly insert: (
      row: PaymentRecord,
    ) => Effect.Effect<PaymentRecord, UniqueViolation | StoreUnavailable>;
    readonly update: (
      next: PaymentRecord,
      expectedRevision: number,
    ) => Effect.Effect<PaymentRecord, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    /** Live payments of one target, oldest `paidOn` first (then id). */
    readonly liveFor: (
      workspaceId: WorkspaceId,
      target: PaymentTargetRef,
    ) => Effect.Effect<ReadonlyArray<PaymentRecord>, StoreUnavailable>;
    /** Live payments with `from <= paidOn <= to`, both directions (ReportsSource, board #397). */
    readonly paidBetween: (
      workspaceId: WorkspaceId,
      range: { readonly from: IsoDate; readonly to: IsoDate },
    ) => Effect.Effect<ReadonlyArray<PaymentRecord>, StoreUnavailable>;
  }
>()("kvitbit/core/PaymentsRepo") {}

const byPaidOn = (a: PaymentRecord, b: PaymentRecord) =>
  a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export const PaymentsRepoMemory: Layer.Layer<PaymentsRepo, never, MemoryTables> = Layer.effect(
  PaymentsRepo,
  Effect.map(MemoryTables, (tables) => {
    const table = tables.collection(PaymentsTable);
    return PaymentsRepo.of({
      get: (workspaceId, id) => table.get(workspaceId, id),
      lock: (workspaceId, id) => table.lock(workspaceId, id),
      insert: table.insert,
      update: table.update,
      liveFor: (workspaceId, target) =>
        Effect.map(
          table.list(workspaceId, {
            where:
              "document" in target
                ? { documentId: target.document, removedAt: null }
                : { expenseId: target.expense, removedAt: null },
          }),
          (rows) => [...rows].sort(byPaidOn),
        ),
      paidBetween: (workspaceId, range) =>
        Effect.map(
          table.list(workspaceId, {
            where: { removedAt: null },
            range: { paidOn: { gte: range.from, lte: range.to } },
          }),
          (rows) => [...rows].sort(byPaidOn),
        ),
    });
  }),
);
