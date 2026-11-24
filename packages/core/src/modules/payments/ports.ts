/**
 * Narrow ports Payments consumes from other modules, bound at integration (one Layer line each).
 * All run inside the caller's CoreStore transaction and never authorize or audit.
 *
 * - `ExpensePayables`: structurally identical to ce-expenses' tag of the same key
 *   (packages/core/src/modules/expenses/payables.ts, board #395/#409, accepted #579).
 * - `PaymentSettings`: the Workspace setting `autoSendPaymentTaxDocument` (P2; board #581 to
 *   core-identity, bound from its Workspace snapshot).
 */
import type {
  CurrencyCode,
  CurrentCaller,
  ExpenseId,
  Money,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type { Effect } from "effect";
import { Context } from "effect";
import type { StoreUnavailable } from "../../store/CoreStore";

/** Settlement of an Expense: paid vs gross; an incomplete Expense is "unpaid". */
export type ExpenseSettlement = "unpaid" | "partially_paid" | "paid" | "overpaid";

/** An Expense as Payments sees it. */
export interface ExpensePayable {
  readonly id: ExpenseId;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
  readonly status: "complete" | "incomplete";
  readonly currency: CurrencyCode | null;
  readonly gross: Money | null;
  readonly paid: Money | null;
  readonly payments: number;
  readonly settlement: ExpenseSettlement;
}

export class ExpensePayables extends Context.Service<
  ExpensePayables,
  {
    /** Row-locks the Expense (no revision). Other Workspace or removed -> NotFound{Expense}. */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: ExpenseId,
    ) => Effect.Effect<ExpensePayable, NotFound | StoreUnavailable>;
    /**
     * Stores the paid state after a Payment insert or soft delete (paid = sum of the Expense's
     * live Payments, payments = their count), bumps the Expense revision and returns the
     * derived settlement. After `lock`, in the same transaction.
     */
    readonly settle: (
      workspaceId: WorkspaceId,
      id: ExpenseId,
      paid: { readonly amount: Money; readonly payments: number },
    ) => Effect.Effect<ExpenseSettlement, NotFound | StoreUnavailable>;
  }
>()("kvitbit/core/ExpensePayables") {}

export class PaymentSettings extends Context.Service<
  PaymentSettings,
  {
    /** P2: whether a new Payment Tax Document is sent in the recording transaction. */
    readonly autoSendPaymentTaxDocument: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<boolean, NotFound | StoreUnavailable, CurrentCaller>;
  }
>()("kvitbit/core/payments/PaymentSettings") {}
