/**
 * `ExpensePayables`: the seam Payments (core-documents) uses for Payments on an Expense (board
 * #387/#395). Both operations run inside the caller's transaction and never authorize or audit;
 * Payments does both (audit on the Expense subject). Payments' own rules on top: `record` on an
 * incomplete Expense is `Invalid{expense.incomplete}`; a currency other than `Payable.currency`
 * is `Invalid{payment.currency_mismatch}` (rule P1).
 */
import type {
  CurrencyCode,
  ExpenseId,
  Money,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { MoneyMath, NotFound as NotFoundError } from "@kvitbit/domain/contract";
import { BigDecimal, Clock, Context, Effect, Layer } from "effect";
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
>()("kvitbit/core/ExpensePayables") {}

const money = (amount: BigDecimal.BigDecimal | null, currency: CurrencyCode | null) =>
  amount === null || currency === null
    ? null
    : MoneyMath.make(BigDecimal.normalize(amount), currency);

export const toPayable = (row: ExpenseRow): Payable => ({
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
      Effect.flatMap(repo.lock(workspaceId, id), (row) =>
        row.removedAt === null
          ? Effect.succeed(row)
          : Effect.fail(new NotFoundError({ entity: "Expense", id })),
      );
    return {
      lock: (workspaceId, id) => Effect.map(lockLive(workspaceId, id), toPayable),
      settle: (workspaceId, id, paid) =>
        Effect.gen(function* () {
          const row = yield* lockLive(workspaceId, id);
          const now = new Date(yield* Clock.currentTimeMillis).toISOString();
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
