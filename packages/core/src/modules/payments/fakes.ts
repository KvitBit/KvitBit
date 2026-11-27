/**
 * In-memory fakes for Payments' ports, seeded via `PaymentFixtures`. The Expense and delivery
 * fakes live on `MemoryTables`, so they share the CoreStore transaction and roll back with it.
 *
 * - `ExpensePayables`: an Expense row {status, currency, gross, paid, payments}; settlement as
 *   ce-expenses derives it (paid vs gross, incomplete -> unpaid).
 * - `PaymentSettings`: `autoSendPaymentTaxDocument` per Workspace (default off).
 * - `DocumentSender` (documents' delivery seam): authorizes `document.send` like the real one and
 *   records each send as a queued delivery row; `previewSend` dies.
 */

import type { Conflict, CurrencyCode, Invalid } from "@kvitbit/domain/contract";
import {
  CurrencyCode as CurrencyCodeSchema,
  CurrentCaller,
  DeliveryId as DeliveryIdSchema,
  DocumentId,
  ExpenseId,
  MoneyMath,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { authorizeInWorkspace } from "../../policy/Policy";
import type { IdGenerator } from "../../shared/ids";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import { DocumentSender } from "../documents";
import type { ExpenseSettlement } from "./ports";
import { ExpensePayables, PaymentSettings } from "./ports";

const FakeExpense = Schema.Struct({
  id: Schema.String,
  workspaceId: WorkspaceId,
  revision: Schema.Finite,
  status: Schema.Literals(["complete", "incomplete"]),
  currency: Schema.NullOr(CurrencyCodeSchema),
  gross: Schema.NullOr(Schema.BigDecimal),
  paid: Schema.BigDecimal,
  payments: Schema.Finite,
});
type FakeExpense = typeof FakeExpense.Type;

const FakeExpensesTable = defineCollection<FakeExpense>({
  name: "fake_payment_expenses",
  entity: "Expense",
  schema: FakeExpense,
});

const FakeDelivery = Schema.Struct({
  id: Schema.String,
  workspaceId: WorkspaceId,
  revision: Schema.Finite,
  documentId: Schema.String,
});
type FakeDelivery = typeof FakeDelivery.Type;

const FakeDeliveriesTable = defineCollection<FakeDelivery>({
  name: "fake_payment_deliveries",
  entity: "Document",
  schema: FakeDelivery,
});

export interface SeedExpense {
  readonly workspaceId: WorkspaceId;
  readonly id: ExpenseId;
  readonly status?: "complete" | "incomplete";
  readonly currency: CurrencyCode | null;
  readonly gross: BigDecimal.BigDecimal | null;
}

const expenseSettlement = (row: FakeExpense): ExpenseSettlement => {
  if (row.status === "incomplete" || row.gross === null || row.payments === 0) return "unpaid";
  if (BigDecimal.isLessThan(row.paid, row.gross)) return "partially_paid";
  return BigDecimal.equals(row.paid, row.gross) ? "paid" : "overpaid";
};

export class PaymentFixtures extends Context.Service<
  PaymentFixtures,
  {
    readonly putExpense: (seed: SeedExpense) => Effect.Effect<void>;
    readonly expense: (
      workspaceId: WorkspaceId,
      id: ExpenseId,
    ) => Effect.Effect<{
      readonly revision: number;
      readonly paid: BigDecimal.BigDecimal;
      readonly payments: number;
      readonly settlement: ExpenseSettlement;
    }>;
    readonly setAutoSend: (workspaceId: WorkspaceId, on: boolean) => Effect.Effect<void>;
    /**
     * Makes every later `DocumentSender.send` write its delivery row and then fail with `error`
     * (null: succeed again).
     */
    readonly failSends: (error: Conflict | Invalid | NotFound | null) => Effect.Effect<void>;
    /** Documents sent through the fake `DocumentSender`, in order. */
    readonly sent: (workspaceId: WorkspaceId) => Effect.Effect<ReadonlyArray<DocumentId>>;
  }
>()("@kvitbit/core/modules/payments/fakes/PaymentFixtures") {}

export const PaymentFakesLive: Layer.Layer<
  ExpensePayables | PaymentSettings | DocumentSender | PaymentFixtures,
  never,
  MemoryTables | CoreStore | IdGenerator
> = Layer.effectContext(
  Effect.gen(function* () {
    const tables = yield* MemoryTables;
    const store = yield* CoreStore;
    const idGen = yield* Effect.context<IdGenerator>();
    const expenses = tables.collection(FakeExpensesTable);
    const deliveries = tables.collection(FakeDeliveriesTable);
    const autoSend = yield* Ref.make(new Map<WorkspaceId, boolean>());
    const sendFailure = yield* Ref.make<Conflict | Invalid | NotFound | null>(null);
    const missing = (id: string) => NotFound.make({ entity: "Expense", id });

    const payable = (row: FakeExpense) => ({
      id: ExpenseId.make(row.id),
      workspaceId: row.workspaceId,
      revision: row.revision,
      status: row.status,
      currency: row.currency,
      gross:
        row.gross === null || row.currency === null
          ? null
          : MoneyMath.make(row.gross, row.currency),
      paid: row.currency === null ? null : MoneyMath.make(row.paid, row.currency),
      payments: row.payments,
      settlement: expenseSettlement(row),
    });

    const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

    return Context.make(
      ExpensePayables,
      ExpensePayables.of({
        lock: Effect.fn("ExpensePayables.lock")((workspaceId, id) =>
          expenses.lock(workspaceId, id).pipe(
            Effect.catchTag("NotFound", () => Effect.fail(missing(id))),
            Effect.map(payable),
          ),
        ),
        settle: Effect.fn("ExpensePayables.settle")(function* (workspaceId, id, paid) {
          const row = yield* expenses.lock(workspaceId, id);
          const next = yield* expenses
            .update({ ...row, paid: paid.amount.amount, payments: paid.payments }, row.revision)
            .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
          return expenseSettlement(next);
        }),
      }),
    ).pipe(
      Context.add(
        PaymentSettings,
        PaymentSettings.of({
          autoSendPaymentTaxDocument: Effect.fn("PaymentSettings.autoSendPaymentTaxDocument")(
            (workspaceId) => Effect.map(Ref.get(autoSend), (m) => m.get(workspaceId) ?? false),
          ),
        }),
      ),
      Context.add(
        DocumentSender,
        DocumentSender.of({
          send: Effect.fn("DocumentSender.send")(function* (caller, id) {
            const { workspaceId } = yield* authorizeInWorkspace("document.send").pipe(
              Effect.provideService(CurrentCaller, caller),
            );
            const deliveryId = yield* Effect.provideContext(newId(DeliveryIdSchema.make), idGen);
            yield* deliveries
              .insert({ id: deliveryId, workspaceId, revision: 1, documentId: id })
              .pipe(Effect.orDie);
            // A refusal after the delivery row is written: the caller's savepoint must drop it.
            const failure = yield* Ref.get(sendFailure);
            if (failure !== null) return yield* failure;
            return { deliveryId, status: "queued" as const };
          }),
          previewSend: Effect.fn("DocumentSender.previewSend")(() =>
            Effect.die(new Error("previewSend: not faked for Payments")),
          ),
        }),
      ),
      Context.add(
        PaymentFixtures,
        PaymentFixtures.of({
          putExpense: Effect.fn("PaymentFixtures.putExpense")((seed) =>
            orDie(
              store.transaction(
                expenses.insert({
                  id: seed.id,
                  workspaceId: seed.workspaceId,
                  revision: 1,
                  status: seed.status ?? "complete",
                  currency: seed.currency,
                  gross: seed.gross,
                  paid: BigDecimal.fromBigInt(0n),
                  payments: 0,
                }),
              ),
            ).pipe(Effect.asVoid),
          ),
          expense: Effect.fn("PaymentFixtures.expense")((workspaceId, id) =>
            Effect.map(orDie(expenses.get(workspaceId, id)), (row) => ({
              revision: row.revision,
              paid: row.paid,
              payments: row.payments,
              settlement: expenseSettlement(row),
            })),
          ),
          setAutoSend: Effect.fn("PaymentFixtures.setAutoSend")((workspaceId, on) =>
            Ref.update(autoSend, (m) => new Map(m).set(workspaceId, on)),
          ),
          failSends: Effect.fn("PaymentFixtures.failSends")((error) => Ref.set(sendFailure, error)),
          sent: Effect.fn("PaymentFixtures.sent")((workspaceId) =>
            Effect.map(orDie(deliveries.list(workspaceId)), (rows) =>
              EffectArray.map(rows, (r) => DocumentId.make(r.documentId)),
            ),
          ),
        }),
      ),
    );
  }),
);
