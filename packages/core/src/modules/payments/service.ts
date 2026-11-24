/**
 * `PaymentsLive`: the domain `Payments` tag (core-ports 4.5). Method shape: authorize (R1a) ->
 * withIdempotency (C3, `record`) or transaction -> lock the target (S4: the Proforma first) ->
 * rules -> payment row -> the target's paid state + audit (one entry on the target) -> P2.
 */
import type {
  AuditEntry,
  CoreError,
  CurrencyCode,
  DocumentId,
  DocumentView,
  ExpenseId,
  Money,
  PaymentId,
  PaymentMethod,
  PaymentTarget,
  RecordPaymentInput,
  RequestOptions,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Conflict, CurrentCaller, Invalid, MoneyMath, Payments } from "@kvitbit/domain/contract";
import { BigDecimal, Context, Effect, Layer } from "effect";
import { can } from "../../policy/can";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator, newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { DocumentPayments, DocumentSender, now } from "../documents";
import { PaymentDocuments } from "./documentReads";
import { ExpensePayables, PaymentSettings } from "./ports";
import type { PaymentRecord } from "./record";
import { RecordPaymentInputSchema, RecordResultCodec, toView } from "./record";
import { PaymentsRepo } from "./repo";

/** Everything `PaymentsLive` requires. */
export type PaymentsDeps =
  | CoreStore
  | IdGenerator
  | PaymentsRepo
  | DocumentPayments
  | PaymentDocuments
  | DocumentSender
  | ExpensePayables
  | PaymentSettings;

type Settled = "partially_paid" | "paid" | "overpaid";
const SETTLED: ReadonlyArray<string> = ["partially_paid", "paid", "overpaid"];

const malformed = (path: string, reason: string) =>
  new Invalid({ issues: [{ path: [path], code: "request.malformed", params: { reason } }] });

const currencyMismatch = (expected: CurrencyCode) =>
  new Invalid({
    issues: [
      { path: ["amount", "currency"], code: "payment.currency_mismatch", params: { expected } },
    ],
  });

const ZERO = BigDecimal.fromBigInt(0n);

/** Paid total and count of live rows (every row is in the target's currency, P1). */
const paidOf = (rows: ReadonlyArray<PaymentRecord>) => ({
  amount: BigDecimal.normalize(rows.reduce((sum, r) => BigDecimal.sum(sum, r.amount), ZERO)),
  payments: rows.length,
});

/**
 * The payment's particulars in its audit entry. `payment.record` writes them before the PTD
 * exists (settle precedes issuance), so the tax document is only named on removal.
 */
const particulars = (row: PaymentRecord) => ({
  id: row.id,
  amount: BigDecimal.format(BigDecimal.normalize(row.amount)),
  currency: row.currency,
  paidOn: row.paidOn,
  method: row.method,
  note: row.note,
});

const asSettled = (settlement: string): Effect.Effect<Settled> =>
  SETTLED.includes(settlement)
    ? Effect.succeed(settlement as Settled)
    : Effect.die(new Error(`Payments.record: settlement ${settlement} after a positive payment`));

/** The `payments.amount` column: numeric(18,2). */
const MAX_AMOUNT = BigDecimal.fromStringUnsafe("9999999999999999.99");
const COLUMN_SCALE = 2;

/**
 * The amount to book: the given one or what is outstanding. It must be positive, in the
 * target's currency (P1), within the currency's minor unit and the column's range; nothing
 * outstanding and no amount is `Invalid{amount, required}`.
 */
const amountFor = (
  given: Money | undefined,
  currency: CurrencyCode,
  outstanding: BigDecimal.BigDecimal,
) =>
  Effect.gen(function* () {
    if (given === undefined && !BigDecimal.isPositive(outstanding)) {
      return yield* malformed("amount", "required");
    }
    const amount = BigDecimal.normalize(given?.amount ?? outstanding);
    if (
      !BigDecimal.isPositive(amount) ||
      amount.scale > Math.min(MoneyMath.minorUnitScale(currency), COLUMN_SCALE) ||
      BigDecimal.isGreaterThan(amount, MAX_AMOUNT)
    ) {
      return yield* malformed("amount", "out_of_range");
    }
    if (given !== undefined && given.currency !== currency) {
      return yield* currencyMismatch(currency);
    }
    return amount;
  });

const newRow = (
  workspaceId: WorkspaceId,
  target: { readonly documentId: DocumentId | null; readonly expenseId: ExpenseId | null },
  amount: BigDecimal.BigDecimal,
  currency: CurrencyCode,
  input: RecordPaymentInput,
  defaultMethod: PaymentMethod,
) =>
  Effect.gen(function* () {
    const { today, at } = yield* now;
    const row: PaymentRecord = {
      id: yield* newId<PaymentId>(),
      workspaceId,
      revision: 1,
      ...target,
      amount,
      currency,
      paidOn: input.paidOn ?? today,
      method: input.method ?? defaultMethod,
      note: input.note ?? null,
      taxDocumentId: null,
      removedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    return yield* (yield* PaymentsRepo)
      .insert(row)
      .pipe(Effect.catchTag("UniqueViolation", Effect.die));
  });

/** P2: the PTD for an advance on a Proforma, linked to the payment, sent when configured. */
const taxDocumentFor = (workspaceId: WorkspaceId, proforma: DocumentId, row: PaymentRecord) =>
  Effect.gen(function* () {
    const seam = yield* DocumentPayments;
    const repo = yield* PaymentsRepo;
    const ptd = yield* seam.issuePaymentTaxDocument(workspaceId, proforma, {
      amount: row.amount,
      paidOn: row.paidOn,
    });
    if (ptd === null) return { row, issued: [] as ReadonlyArray<DocumentView> };
    const ptdId = (ptd as unknown as { readonly id: DocumentId }).id as DocumentId;
    const linked = yield* repo
      .update({ ...row, taxDocumentId: ptdId }, row.revision)
      .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
    return { row: linked, issued: [yield* autoSend(workspaceId, ptdId, ptd)] };
  });

/** A send refusal about the recipients only (`SendOptions.to`, defaulted from the Contact). */
const isRecipientIssue = (issue: Invalid["issues"][number]) => issue.path[0] === "to";

/** A skipped auto-send, recorded on the PTD so the gap is visible in its history. */
const skipped = (workspaceId: WorkspaceId, ptd: DocumentId, reason: string) =>
  appendAudit({
    workspaceId,
    subject: { entity: "Document", id: ptd },
    action: "payment.autoSendSkipped",
    revision: null,
    reason,
  });

/**
 * P2 auto-send (7.2) when `autoSendPaymentTaxDocument` is on, as the caller, in a savepoint of
 * the recording transaction. The payment and its PTD commit either way: a caller who may not
 * send (a token without documents:write) or a delivery precondition the sender refuses
 * (Conflict{illegal_transition}, an Invalid only about `to`: e.g. no recipient) skips the send with an audit entry
 * on the PTD, the savepoint dropping any partial delivery; NotFound, other Conflicts and
 * infrastructure failures roll the payment back. Returns the PTD view as of the send.
 */
const autoSend = (workspaceId: WorkspaceId, ptdId: DocumentId, ptd: DocumentView) =>
  Effect.gen(function* () {
    if (!(yield* (yield* PaymentSettings).autoSendPaymentTaxDocument(workspaceId))) return ptd;
    if (!can(yield* CurrentCaller, "document.send")) {
      yield* skipped(workspaceId, ptdId, "caller_cannot_send");
      return ptd;
    }
    const store = yield* CoreStore;
    const sender = yield* DocumentSender;
    const sent = yield* store.transaction(sender.send(ptdId)).pipe(
      Effect.as(true),
      // Recoverable delivery refusals only: the PTD's state (illegal_transition) or an Invalid
      // whose every issue is about the recipients (`to`, defaulted from the Contact). A missing
      // PTD, a revision race or any other validation issue is an invariant failure.
      Effect.catchTags({
        Conflict: (e) =>
          e.reason === "illegal_transition"
            ? Effect.as(skipped(workspaceId, ptdId, `Conflict:${e.detail ?? e.reason}`), false)
            : Effect.fail(e),
        Invalid: (e) =>
          e.issues.length > 0 && e.issues.every(isRecipientIssue)
            ? Effect.as(
                skipped(
                  workspaceId,
                  ptdId,
                  `Invalid:${e.issues.map((i) => `${i.path.join(".")}:${i.code}`).join(",")}`,
                ),
                false,
              )
            : Effect.fail(e),
      }),
    );
    if (!sent) return ptd;
    return yield* (yield* PaymentDocuments).view(workspaceId, ptdId);
  });

const recordOnDocument = (workspaceId: WorkspaceId, id: DocumentId, input: RecordPaymentInput) =>
  Effect.gen(function* () {
    const seam = yield* DocumentPayments;
    const repo = yield* PaymentsRepo;
    // S4/P2a: the Proforma row first; a Proforma with a Final Invoice settles on it (D8).
    const targets = yield* seam.lock(workspaceId, id);
    const on = targets.settleOn;
    // State before amounts: only issued Invoices and Proformas that are not fully credited take
    // payments; a document lock does not matter (P4).
    if (
      on.status !== "issued" ||
      on.settlement === "credited" ||
      (on.kind !== "invoice" && on.kind !== "proforma")
    ) {
      return yield* new Conflict({ reason: "illegal_transition" });
    }
    const outstanding = BigDecimal.subtract(on.owed.amount, on.paid.amount);
    const amount = yield* amountFor(input.amount, on.currency, outstanding);
    // The method defaults to the one the document prints (C4).
    const printed = yield* (yield* PaymentDocuments).paymentMethod(workspaceId, on.id);
    const inserted = yield* newRow(
      workspaceId,
      { documentId: on.id, expenseId: null },
      amount,
      on.currency,
      input,
      printed,
    );
    const details: AuditEntry["changes"] = [
      { path: "payment", before: null, after: particulars(inserted) },
      ...(on.id === id ? [] : [{ path: "payment.recordedOn", before: null, after: id }]),
    ];
    const settled = yield* seam.settle(
      workspaceId,
      on.id,
      paidOf(yield* repo.liveFor(workspaceId, { document: on.id })),
      { action: "payment.record", details },
    );
    const { row, issued } =
      on.kind === "proforma"
        ? yield* taxDocumentFor(workspaceId, on.id, inserted)
        : { row: inserted, issued: [] as ReadonlyArray<DocumentView> };
    return { payment: toView(row), settlement: yield* asSettled(settled.settlement), issued };
  });

/** Audit on the Expense subject: Expenses' paid state is not audited by ExpensePayables. */
const auditExpense = (
  workspaceId: WorkspaceId,
  id: ExpenseId,
  before: {
    readonly revision: number;
    readonly paid: BigDecimal.BigDecimal;
    readonly payments: number;
    readonly settlement: string;
  },
  after: {
    readonly paid: BigDecimal.BigDecimal;
    readonly payments: number;
    readonly settlement: string;
  },
  action: "payment.record" | "payment.remove",
  payment: AuditEntry["changes"][number],
  reason: string | null,
) =>
  appendAudit({
    workspaceId,
    subject: { entity: "Expense", id },
    action,
    revision: before.revision + 1,
    changes: [
      {
        path: "paidAmount",
        before: BigDecimal.format(BigDecimal.normalize(before.paid)),
        after: BigDecimal.format(BigDecimal.normalize(after.paid)),
      },
      { path: "payments", before: before.payments, after: after.payments },
      { path: "settlement", before: before.settlement, after: after.settlement },
      payment,
    ],
    reason,
  });

const recordOnExpense = (workspaceId: WorkspaceId, id: ExpenseId, input: RecordPaymentInput) =>
  Effect.gen(function* () {
    const expenses = yield* ExpensePayables;
    const repo = yield* PaymentsRepo;
    const expense = yield* expenses.lock(workspaceId, id);
    if (expense.status === "incomplete" || expense.currency === null || expense.gross === null) {
      return yield* new Invalid({ issues: [{ path: ["target"], code: "expense.incomplete" }] });
    }
    const paidBefore = expense.paid?.amount ?? ZERO;
    const amount = yield* amountFor(
      input.amount,
      expense.currency,
      BigDecimal.subtract(expense.gross.amount, paidBefore),
    );
    const inserted = yield* newRow(
      workspaceId,
      { documentId: null, expenseId: id },
      amount,
      expense.currency,
      input,
      "bank_transfer",
    );
    const paid = paidOf(yield* repo.liveFor(workspaceId, { expense: id }));
    const settlement = yield* expenses.settle(workspaceId, id, {
      amount: MoneyMath.make(paid.amount, expense.currency),
      payments: paid.payments,
    });
    yield* auditExpense(
      workspaceId,
      id,
      { ...expense, paid: paidBefore },
      { ...paid, paid: paid.amount, settlement },
      "payment.record",
      { path: "payment", before: null, after: particulars(inserted) },
      null,
    );
    return {
      payment: toView(inserted),
      settlement: yield* asSettled(settlement),
      issued: [] as ReadonlyArray<DocumentView>,
    };
  });

export const record = (input: RecordPaymentInput, opts?: RequestOptions) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("payment.write");
    const documents = yield* PaymentDocuments;
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Payments.record",
        payload: { schema: RecordPaymentInputSchema, value: input },
        result: RecordResultCodec,
      },
      Effect.gen(function* () {
        const target = input.target;
        return "document" in target
          ? yield* recordOnDocument(workspaceId, target.document, input)
          : yield* recordOnExpense(workspaceId, target.expense, input);
      }),
      // Stored and replayed without share/deliveries; the caller's view gets them before commit.
      (result) =>
        Effect.map(
          Effect.forEach(result.issued, (view) => documents.withActivity(workspaceId, view)),
          (issued) => ({ ...result, issued }),
        ),
    );
  }).pipe(orUnavailable);

/**
 * Soft-deletes a payment (idempotent by state, C6). Locks the target first (S4), then the row;
 * P3: blocked while a Final Invoice deducts the advance or its PTD is not fully credited.
 */
export const remove = (id: PaymentId, reason: string) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("payment.write");
    const why = reason.trim();
    if (why === "") return yield* malformed("reason", "required");
    const store = yield* CoreStore;
    const repo = yield* PaymentsRepo;
    return yield* store.transaction(
      Effect.gen(function* () {
        const peek = yield* repo.get(workspaceId, id);
        if (peek.removedAt !== null) return;
        const { at } = yield* now;
        if (peek.documentId !== null) {
          const documentId = peek.documentId;
          const seam = yield* DocumentPayments;
          yield* seam.lock(workspaceId, documentId);
          const row = yield* repo.lock(workspaceId, id);
          if (row.removedAt !== null) return;
          const block = yield* seam.removalBlocked(workspaceId, documentId, row.taxDocumentId);
          if (block !== null) {
            return yield* new Conflict({
              reason: "illegal_transition",
              detail: "payment.has_tax_document",
            });
          }
          yield* repo
            .update({ ...row, removedAt: at, updatedAt: at }, row.revision)
            .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
          yield* seam.settle(
            workspaceId,
            documentId,
            paidOf(yield* repo.liveFor(workspaceId, { document: documentId })),
            {
              action: "payment.remove",
              reason: why,
              details: [
                {
                  path: "payment",
                  before: { ...particulars(row), taxDocument: row.taxDocumentId },
                  after: null,
                },
              ],
            },
          );
          return;
        }
        const expenseId = peek.expenseId as ExpenseId;
        const expenses = yield* ExpensePayables;
        const expense = yield* expenses.lock(workspaceId, expenseId);
        const row = yield* repo.lock(workspaceId, id);
        if (row.removedAt !== null) return;
        yield* repo
          .update({ ...row, removedAt: at, updatedAt: at }, row.revision)
          .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
        const paid = paidOf(yield* repo.liveFor(workspaceId, { expense: expenseId }));
        const settlement = yield* expenses.settle(workspaceId, expenseId, {
          amount: MoneyMath.make(paid.amount, row.currency),
          payments: paid.payments,
        });
        yield* auditExpense(
          workspaceId,
          expenseId,
          { ...expense, paid: expense.paid?.amount ?? ZERO },
          { ...paid, paid: paid.amount, settlement },
          "payment.remove",
          { path: "payment", before: { ...particulars(row), taxDocument: null }, after: null },
          why,
        );
      }),
    );
  }).pipe(orUnavailable);

/** Live payments of a target, oldest first. Another Workspace's target is NotFound. */
export const listFor = (target: PaymentTarget) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("payment.read");
    const store = yield* CoreStore;
    const repo = yield* PaymentsRepo;
    return yield* store.transaction(
      Effect.gen(function* () {
        if ("document" in target) {
          yield* (yield* PaymentDocuments).exists(workspaceId, target.document);
          return (yield* repo.liveFor(workspaceId, target)).map(toView);
        }
        // ExpensePayables exposes no plain read; its row lock is the existence check.
        yield* (yield* ExpensePayables).lock(workspaceId, target.expense);
        return (yield* repo.liveFor(workspaceId, target)).map(toView);
      }),
    );
  }).pipe(orUnavailable);

type PaymentsShape = Payments["Service"];
/** The domain shape with every method's error channel widened to `CoreError`. */
type WidePayments = {
  readonly [K in keyof PaymentsShape]: (
    ...args: Parameters<PaymentsShape[K]>
  ) => Effect.Effect<Effect.Success<ReturnType<PaymentsShape[K]>>, CoreError, CurrentCaller>;
};

const make = Effect.gen(function* () {
  // Only the build dependencies: the build-time context may hold a CurrentCaller, RequestOutcome
  // or transaction frame, and providing them per call would override the caller's own.
  const context = Context.pick(
    CoreStore,
    IdGenerator,
    PaymentsRepo,
    DocumentPayments,
    PaymentDocuments,
    DocumentSender,
    ExpensePayables,
    PaymentSettings,
  )(yield* Effect.context<PaymentsDeps>());
  // The call site's context wins: its caller, RequestOutcome and CoreStore transaction frame.
  const run = <A, E>(effect: Effect.Effect<A, E, PaymentsDeps | CurrentCaller>) =>
    Effect.flatMap(Effect.context<CurrentCaller>(), (callSite) =>
      Effect.provideContext(effect, Context.merge(context, callSite)),
    );
  /**
   * The one cast at the layer boundary (board #341 approach). Domain signature gaps: `remove`
   * lacks Invalid (a blank reason) and Unavailable; `listFor` lacks Unavailable.
   */
  const impl: WidePayments = {
    record: (input, opts) => run(record(input, opts)),
    remove: (id, reason) => run(remove(id, reason)),
    listFor: (target) => run(listFor(target)),
  };
  return Payments.of(impl as unknown as Payments["Service"]);
});

export const PaymentsLive: Layer.Layer<Payments, never, PaymentsDeps> = Layer.effect(
  Payments,
  make,
);
