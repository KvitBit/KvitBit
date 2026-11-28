/**
 * `PaymentsLive`: the domain `Payments` tag (core-ports 4.5). Method shape: authorize (R1a) ->
 * withIdempotency (C3, `record`) or transaction -> lock the target (S4: the Proforma first) ->
 * rules -> payment row -> the target's paid state + audit (one entry on the target) -> P2.
 */

import type {
  AuditEntry,
  Caller,
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
import {
  Conflict,
  Invalid,
  MoneyMath,
  PaymentId as PaymentIdSchema,
  Payments,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
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
const SettledSchema = Schema.Literals(["partially_paid", "paid", "overpaid"]);

const malformed = (path: string, reason: string) =>
  Invalid.make({ issues: [{ path: [path], code: "request.malformed", params: { reason } }] });

const currencyMismatch = (expected: CurrencyCode) =>
  Invalid.make({
    issues: [
      { path: ["amount", "currency"], code: "payment.currency_mismatch", params: { expected } },
    ],
  });

const ZERO = BigDecimal.fromBigInt(0n);

/** Paid total and count of live rows (every row is in the target's currency, P1). */
const paidOf = (rows: ReadonlyArray<PaymentRecord>) => ({
  amount: BigDecimal.normalize(
    EffectArray.reduce(rows, ZERO, (sum, r) => BigDecimal.sum(sum, r.amount)),
  ),
  payments: rows.length,
});

/**
 * The payment's particulars in its audit entry. `payment.record` writes them before the PTD
 * exists (settle precedes issuance), so the tax document is only named on removal.
 */
const particulars = (row: PaymentRecord) => ({
  id: row.id,
  amount: row.amount.pipe(BigDecimal.normalize, BigDecimal.format),
  currency: row.currency,
  paidOn: row.paidOn,
  method: row.method,
  note: row.note,
});

const asSettled = (settlement: string): Effect.Effect<Settled> =>
  Schema.is(SettledSchema)(settlement)
    ? Effect.succeed(settlement)
    : Effect.die(new Error(`Payments.record: settlement ${settlement} after a positive payment`));

/** The `payments.amount` column: numeric(18,2). */
const MAX_AMOUNT = BigDecimal.fromStringUnsafe("9999999999999999.99");
const COLUMN_SCALE = 2;

/**
 * The amount to book: the given one or what is outstanding. It must be positive, in the
 * target's currency (P1), within the currency's minor unit and the column's range; nothing
 * outstanding and no amount is `Invalid{amount, required}`.
 */
const amountFor = Effect.fn("amountFor")(function* (
  given: Money | undefined,
  currency: CurrencyCode,
  outstanding: BigDecimal.BigDecimal,
) {
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

const newRow = Effect.fn("newRow")(function* (
  workspaceId: WorkspaceId,
  target: { readonly documentId: DocumentId | null; readonly expenseId: ExpenseId | null },
  amount: BigDecimal.BigDecimal,
  currency: CurrencyCode,
  input: RecordPaymentInput,
  defaultMethod: PaymentMethod,
) {
  const { today, at } = yield* now;
  const row: PaymentRecord = {
    id: yield* newId(PaymentIdSchema.make),
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
const taxDocumentFor = Effect.fn("taxDocumentFor")(function* (
  caller: Caller,
  workspaceId: WorkspaceId,
  proforma: DocumentId,
  row: PaymentRecord,
) {
  const seam = yield* DocumentPayments;
  const repo = yield* PaymentsRepo;
  const ptd = yield* seam.issuePaymentTaxDocument(caller, workspaceId, proforma, {
    amount: row.amount,
    paidOn: row.paidOn,
  });
  if (ptd === null) return { row, issued: [] };
  const ptdId = ptd.id;
  const linked = yield* repo
    .update({ ...row, taxDocumentId: ptdId }, row.revision)
    .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
  return { row: linked, issued: [yield* autoSend(caller, workspaceId, ptdId, ptd)] };
});

/** A send refusal about the recipients only (`SendOptions.to`, defaulted from the Contact). */
const isRecipientIssue = (issue: Invalid["issues"][number]) => issue.path[0] === "to";

/** A skipped auto-send, recorded on the PTD so the gap is visible in its history. */
const skipped = (caller: Caller, workspaceId: WorkspaceId, ptd: DocumentId, reason: string) =>
  appendAudit(caller, {
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
const autoSend = Effect.fn("autoSend")(function* (
  caller: Caller,
  workspaceId: WorkspaceId,
  ptdId: DocumentId,
  ptd: DocumentView,
) {
  if (!(yield* (yield* PaymentSettings).autoSendPaymentTaxDocument(caller, workspaceId)))
    return ptd;
  if (!can(caller, "document.send")) {
    yield* skipped(caller, workspaceId, ptdId, "caller_cannot_send");
    return ptd;
  }
  const store = yield* CoreStore;
  const sender = yield* DocumentSender;
  const sent = yield* store.transaction(sender.send(caller, ptdId)).pipe(
    Effect.as(true),
    // Recoverable delivery refusals only: the PTD's state (illegal_transition) or an Invalid
    // whose every issue is about the recipients (`to`, defaulted from the Contact). A missing
    // PTD, a revision race or any other validation issue is an invariant failure.
    Effect.catchTags({
      Conflict: (e) =>
        e.reason === "illegal_transition"
          ? Effect.as(
              skipped(caller, workspaceId, ptdId, `Conflict:${e.detail ?? e.reason}`),
              false,
            )
          : Effect.fail(e),
      Invalid: (e) =>
        e.issues.length > 0 && EffectArray.every(e.issues, isRecipientIssue)
          ? Effect.as(
              skipped(
                caller,
                workspaceId,
                ptdId,
                `Invalid:${EffectArray.join(
                  EffectArray.map(
                    e.issues,
                    (i) => `${EffectArray.join(EffectArray.map(i.path, String), ".")}:${i.code}`,
                  ),
                  ",",
                )}`,
              ),
              false,
            )
          : Effect.fail(e),
    }),
  );
  if (!sent) return ptd;
  return yield* (yield* PaymentDocuments).view(workspaceId, ptdId);
});

const recordOnDocument = Effect.fn("recordOnDocument")(function* (
  caller: Caller,
  workspaceId: WorkspaceId,
  id: DocumentId,
  input: RecordPaymentInput,
) {
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
    return yield* Conflict.make({ reason: "illegal_transition" });
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
  const value_1 = yield* repo.liveFor(workspaceId, { document: on.id });
  const settled = yield* seam.settle(caller, workspaceId, on.id, paidOf(value_1), {
    action: "payment.record",
    details,
  });
  const { row, issued } =
    on.kind === "proforma"
      ? yield* taxDocumentFor(caller, workspaceId, on.id, inserted)
      : { row: inserted, issued: [] };
  return { payment: toView(row), settlement: yield* asSettled(settled.settlement), issued };
});

/** Audit on the Expense subject: Expenses' paid state is not audited by ExpensePayables. */
const auditExpense = (
  caller: Caller,
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
  appendAudit(caller, {
    workspaceId,
    subject: { entity: "Expense", id },
    action,
    revision: before.revision + 1,
    changes: [
      {
        path: "paidAmount",
        before: before.paid.pipe(BigDecimal.normalize, BigDecimal.format),
        after: after.paid.pipe(BigDecimal.normalize, BigDecimal.format),
      },
      { path: "payments", before: before.payments, after: after.payments },
      { path: "settlement", before: before.settlement, after: after.settlement },
      payment,
    ],
    reason,
  });

const recordOnExpense = Effect.fn("recordOnExpense")(function* (
  caller: Caller,
  workspaceId: WorkspaceId,
  id: ExpenseId,
  input: RecordPaymentInput,
) {
  const expenses = yield* ExpensePayables;
  const repo = yield* PaymentsRepo;
  const expense = yield* expenses.lock(workspaceId, id);
  if (expense.status === "incomplete" || expense.currency === null || expense.gross === null) {
    return yield* Invalid.make({ issues: [{ path: ["target"], code: "expense.incomplete" }] });
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
  const value_1 = yield* repo.liveFor(workspaceId, { expense: id });
  const paid = paidOf(value_1);
  const settlement = yield* expenses.settle(workspaceId, id, {
    amount: MoneyMath.make(paid.amount, expense.currency),
    payments: paid.payments,
  });
  yield* auditExpense(
    caller,
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
    issued: [],
  };
});

export const record = Effect.fn("record")(
  function* (caller: Caller, input: RecordPaymentInput, opts?: RequestOptions) {
    const { caller: workspaceCaller, workspaceId } = yield* authorizeInWorkspace(
      caller,
      "payment.write",
    );
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
          ? yield* recordOnDocument(workspaceCaller, workspaceId, target.document, input)
          : yield* recordOnExpense(workspaceCaller, workspaceId, target.expense, input);
      }),
    );
  },
  (_) => orUnavailable(_),
);

/**
 * Soft-deletes a payment (idempotent by state, C6). Locks the target first (S4), then the row;
 * P3: blocked while a Final Invoice deducts the advance or its PTD is not fully credited.
 */
export const remove = Effect.fn("remove")(
  function* (caller: Caller, id: PaymentId, reason: string) {
    const { caller: workspaceCaller, workspaceId } = yield* authorizeInWorkspace(
      caller,
      "payment.write",
    );
    const why = EffectString.trim(reason);
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
            return yield* Conflict.make({
              reason: "illegal_transition",
              detail: "payment.has_tax_document",
            });
          }
          yield* repo
            .update({ ...row, removedAt: at, updatedAt: at }, row.revision)
            .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
          const value_1 = yield* repo.liveFor(workspaceId, { document: documentId });
          yield* seam.settle(workspaceCaller, workspaceId, documentId, paidOf(value_1), {
            action: "payment.remove",
            reason: why,
            details: [
              {
                path: "payment",
                before: { ...particulars(row), taxDocument: row.taxDocumentId },
                after: null,
              },
            ],
          });
          return;
        }
        const expenseId = Option.getOrThrow(Option.fromNullOr(peek.expenseId));
        const expenses = yield* ExpensePayables;
        const expense = yield* expenses.lock(workspaceId, expenseId);
        const row = yield* repo.lock(workspaceId, id);
        if (row.removedAt !== null) return;
        yield* repo
          .update({ ...row, removedAt: at, updatedAt: at }, row.revision)
          .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
        const value_1 = yield* repo.liveFor(workspaceId, { expense: expenseId });
        const paid = paidOf(value_1);
        const settlement = yield* expenses.settle(workspaceId, expenseId, {
          amount: MoneyMath.make(paid.amount, row.currency),
          payments: paid.payments,
        });
        yield* auditExpense(
          caller,
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
  },
  (_) => orUnavailable(_),
);

/** Live payments of a target, oldest first. Another Workspace's target is NotFound. */
export const listFor = Effect.fn("listFor")(
  function* (caller: Caller, target: PaymentTarget) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "payment.read");
    const store = yield* CoreStore;
    const repo = yield* PaymentsRepo;
    return yield* store.transaction(
      Effect.gen(function* () {
        if ("document" in target) {
          yield* (yield* PaymentDocuments).exists(workspaceId, target.document);
          const value_2 = yield* repo.liveFor(workspaceId, target);
          return EffectArray.map(value_2, toView);
        }
        // ExpensePayables exposes no plain read; its row lock is the existence check.
        yield* (yield* ExpensePayables).lock(workspaceId, target.expense);
        const value_2 = yield* repo.liveFor(workspaceId, target);
        return EffectArray.map(value_2, toView);
      }),
    );
  },
  (_) => orUnavailable(_),
);

const make = Effect.gen(function* () {
  // Only the build dependencies: the build-time context may hold a RequestOutcome
  // or transaction frame, and providing them per call would override the caller's own.
  const buildContext = yield* Effect.context<PaymentsDeps>();
  const context = Context.pick(
    CoreStore,
    IdGenerator,
    PaymentsRepo,
    DocumentPayments,
    PaymentDocuments,
    DocumentSender,
    ExpensePayables,
    PaymentSettings,
  )(buildContext);
  // The call site's context wins: its caller, RequestOutcome and CoreStore transaction frame.
  const run = <A, E>(effect: Effect.Effect<A, E, PaymentsDeps>) =>
    Effect.flatMap(Effect.context<never>(), (callSite) =>
      Effect.provideContext(effect, Context.merge(context, callSite)),
    );
  return Payments.of({
    record: Effect.fn("Payments.record")((caller, input, opts) => run(record(caller, input, opts))),
    remove: Effect.fn("Payments.remove")((caller, id, reason) => run(remove(caller, id, reason))),
    listFor: Effect.fn("Payments.listFor")((caller, target) => run(listFor(caller, target))),
  });
});

export const PaymentsLive: Layer.Layer<Payments, never, PaymentsDeps> = Layer.effect(
  Payments,
  make,
);
