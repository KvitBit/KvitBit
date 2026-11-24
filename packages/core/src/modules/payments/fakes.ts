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
import type {
  Conflict,
  CurrencyCode,
  DeliveryId,
  DocumentId,
  ExpenseId,
  Invalid,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrencyCode as CurrencyCodeSchema, MoneyMath, NotFound } from "@kvitbit/domain/contract";
import { BigDecimal, Context, Effect, Layer, Ref, Schema } from "effect";
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
  workspaceId: Schema.String,
  revision: Schema.Number,
  status: Schema.Literals(["complete", "incomplete"]),
  currency: Schema.NullOr(CurrencyCodeSchema),
  gross: Schema.NullOr(Schema.BigDecimal),
  paid: Schema.BigDecimal,
  payments: Schema.Number,
});
type FakeExpense = typeof FakeExpense.Type & { readonly workspaceId: WorkspaceId };

const FakeExpensesTable = defineCollection<FakeExpense>({
  name: "fake_payment_expenses",
  entity: "Expense",
  schema: FakeExpense as unknown as Schema.Codec<FakeExpense, unknown>,
});

const FakeDelivery = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  revision: Schema.Number,
  documentId: Schema.String,
});
type FakeDelivery = typeof FakeDelivery.Type & { readonly workspaceId: WorkspaceId };

const FakeDeliveriesTable = defineCollection<FakeDelivery>({
  name: "fake_payment_deliveries",
  entity: "Document",
  schema: FakeDelivery as unknown as Schema.Codec<FakeDelivery, unknown>,
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
    /** Makes every later `DocumentSender.send` fail with `error` (null: succeed again). */
    readonly failSends: (error: Conflict | Invalid | NotFound | null) => Effect.Effect<void>;
    /** Documents sent through the fake `DocumentSender`, in order. */
    readonly sent: (workspaceId: WorkspaceId) => Effect.Effect<ReadonlyArray<DocumentId>>;
  }
>()("kvitbit/core/testing/PaymentFixtures") {}

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
    const missing = (id: string) => new NotFound({ entity: "Expense", id });

    const payable = (row: FakeExpense) => ({
      id: row.id as ExpenseId,
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
        lock: (workspaceId, id) =>
          expenses.lock(workspaceId, id).pipe(
            Effect.catchTag("NotFound", () => Effect.fail(missing(id))),
            Effect.map(payable),
          ),
        settle: (workspaceId, id, paid) =>
          Effect.gen(function* () {
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
          autoSendPaymentTaxDocument: (workspaceId) =>
            Effect.map(Ref.get(autoSend), (m) => m.get(workspaceId) ?? false),
        }),
      ),
      Context.add(
        DocumentSender,
        DocumentSender.of({
          send: (id) =>
            Effect.gen(function* () {
              const { workspaceId } = yield* authorizeInWorkspace("document.send");
              const failure = yield* Ref.get(sendFailure);
              if (failure !== null) return yield* Effect.fail(failure);
              const deliveryId = yield* Effect.provideContext(newId<DeliveryId>(), idGen);
              yield* deliveries
                .insert({ id: deliveryId, workspaceId, revision: 1, documentId: id })
                .pipe(Effect.orDie);
              return { deliveryId, status: "queued" as const };
            }),
          previewSend: () => Effect.die(new Error("previewSend: not faked for Payments")),
        }),
      ),
      Context.add(
        PaymentFixtures,
        PaymentFixtures.of({
          putExpense: (seed) =>
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
          expense: (workspaceId, id) =>
            Effect.map(orDie(expenses.get(workspaceId, id)), (row) => ({
              revision: row.revision,
              paid: row.paid,
              payments: row.payments,
              settlement: expenseSettlement(row),
            })),
          setAutoSend: (workspaceId, on) =>
            Ref.update(autoSend, (m) => new Map(m).set(workspaceId, on)),
          failSends: (error) => Ref.set(sendFailure, error),
          sent: (workspaceId) =>
            Effect.map(orDie(deliveries.list(workspaceId)), (rows) =>
              rows.map((r) => r.documentId as DocumentId),
            ),
        }),
      ),
    );
  }),
);
