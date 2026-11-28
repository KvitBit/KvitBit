/**
 * `ExpensePayables`: the seam Payments (core-documents) uses for Payments on an Expense (board
 * #387/#395). Both operations run inside the caller's transaction and never authorize or audit;
 * Payments does both (audit on the Expense subject). Payments' own rules on top: `record` on an
 * incomplete Expense is `Invalid{expense.incomplete}`; a currency other than `Payable.currency`
 * is `Invalid{payment.currency_mismatch}` (rule P1).
 *
 * `paid` / `payments` on the Expense row are a projection of the Payments ledger, not authority:
 * Payments computes them from its own live (not removed) Payment rows, after `lock` and after its
 * insert or soft delete, in the same transaction, so the projection is atomic with the ledger and
 * can be rebuilt from it. Settlement is derived from the projection and the current total at read
 * time (P1), so editing the total re-settles without a Payment change.
 */
import type {
  CurrencyCode,
  ExpenseId,
  Money,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { MoneyMath, NotFound as NotFoundError } from "@kvitbit/domain/contract";
import * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { StoreUnavailable } from "../../store/CoreStore";
import type { ExpenseRow, ExpenseSettlement } from "./model";
import { settlementOf } from "./model";
import { ExpensesRepo } from "./repo";

export interface Payable {
  readonly id: ExpenseId;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
  readonly status: "complete" | "incomplete";
  readonly currency: CurrencyCode | null;
  readonly gross: Money | null;
  /** null before the first Payment. */
  readonly paid: Money | null;
  readonly payments: number;
  readonly settlement: ExpenseSettlement;
}

export interface PaidState {
  /** Sum of the Expense's live Payments, in the Expense's currency. */
  readonly amount: Money;
  /** Number of live Payments; `Expenses.remove` refuses while it is above 0. */
  readonly payments: number;
}

export class ExpensePayables extends Context.Service<
  ExpensePayables,
  {
    /** Row-locks the Expense (rule C6). Another Workspace's or a removed Expense is NotFound. */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: ExpenseId,
    ) => Effect.Effect<Payable, NotFound | StoreUnavailable>;
    /**
     * Stores the paid state after a Payment was inserted or removed (call after `lock`, same
     * transaction). Bumps the Expense revision; returns the derived settlement.
     */
    readonly settle: (
      workspaceId: WorkspaceId,
      id: ExpenseId,
      paid: PaidState,
    ) => Effect.Effect<ExpenseSettlement, NotFound | StoreUnavailable>;
  }
>()("@kvitbit/core/modules/expenses/payables/ExpensePayables") {}

const money = (amount: BigDecimal.BigDecimal | null, currency: CurrencyCode | null) =>
  amount === null || currency === null
    ? null
    : MoneyMath.make(BigDecimal.normalize(amount), currency);

const toPayable = (row: ExpenseRow): Payable => ({
  id: row.id,
  workspaceId: row.workspaceId,
  revision: row.revision,
  status: row.status,
  currency: row.currency,
  gross: money(row.total, row.currency),
  paid: row.payments === 0 ? null : money(row.paid, row.currency),
  payments: row.payments,
  settlement: settlementOf(row),
});

/** `ExpensePayables` on `ExpensesRepo`. */
export const ExpensePayablesLive: Layer.Layer<ExpensePayables, never, ExpensesRepo> = Layer.effect(
  ExpensePayables,
  Effect.map(ExpensesRepo, (repo) => {
    const lockLive = (workspaceId: WorkspaceId, id: ExpenseId) =>
      Effect.filterOrFail(
        repo.lock(workspaceId, id),
        (row) => row.removedAt === null,
        () => NotFoundError.make({ entity: "Expense", id }),
      );
    return {
      lock: (workspaceId, id) => Effect.map(lockLive(workspaceId, id), toPayable),
      settle: Effect.fn("settle")(function* (workspaceId, id, paid) {
        const row = yield* lockLive(workspaceId, id);
        const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const next = yield* repo
          .update(
            {
              ...row,
              paid: BigDecimal.normalize(paid.amount.amount),
              payments: paid.payments,
              updatedAt: now,
            },
            row.revision,
          )
          // The row is locked in this transaction, so neither a revision race nor a unique
          // index (expenses has none) can fail this update.
          .pipe(
            Effect.catchTags({
              Conflict: (e) => Effect.die(e),
              UniqueViolation: (e) => Effect.die(e),
            }),
          );
        return settlementOf(next);
      }),
    };
  }),
);
