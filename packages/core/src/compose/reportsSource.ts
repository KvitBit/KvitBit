/**
 * `ReportsSourceLive`: the real `ReportsSource` (modules/reports/source.ts) over the module
 * repositories (board #397/#477/#530/#557 documents, #580 payments, #404 expenses).
 *
 * - documents / openReceivables: `DocumentsRepo.reportable` / `.receivable`, each row through
 *   documents' `reportFigures` (full supply + advance deductions) and `outstandingOf` (credit
 *   aware, against the row's `corrected_by` Credit Notes). A Final Invoice is an Invoice with an
 *   `advance_of` link; a Credit Note's `correctsKind` is the kind of its `corrects` target.
 *   Advance deductions are the lines whose `deducts` target is a Payment Tax Document.
 * - payments: `PaymentsRepo.paidBetween` + payments' `reportPayment(row, fx)` with the TARGET's
 *   stored fixing (the document's `fx`, the Expense's `figures.fx`). A payment on a Proforma
 *   with a Final Invoice is already stored against the Final Invoice.
 * - expenses / incompleteExpenses: expenses' `ExpenseRecords` seam.
 * - taxRegimes: the Workspace row's regime history; an unknown Workspace has none (`[]`, like
 *   every other Workspace-scoped read here; Reports only asks after authorizing the Workspace).
 *
 * Read-only, inside the caller's transaction. A row a stored reference points to but the
 * repository cannot find (a payment's target, a Credit Note's `corrects` / `corrected_by`, a
 * deduction line's `deducts`; issued documents are never deleted) is a defect, not a failure.
 */

import type { DocumentId, DocumentKind, ExpenseId, WorkspaceId } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { outstandingOf } from "../modules/documents/credit";
import type { DocumentRecord } from "../modules/documents/record";
import { DocumentsRepo, reportTaxPoint } from "../modules/documents/repo";
import { reportFigures } from "../modules/documents/reports";
import type { ExpenseRecord } from "../modules/expenses/records";
import { ExpenseRecords } from "../modules/expenses/records";
import { ExpensesRepo } from "../modules/expenses/repo";
import { reportPayment } from "../modules/payments/record";
import { PaymentsRepo } from "../modules/payments/repo";
import type {
  ReportDocument,
  ReportExpense,
  ReportPayment,
  ReportsSourceShape,
  StoredFx,
} from "../modules/reports/source";
import { ReportsSource } from "../modules/reports/source";
import { WorkspacesRepo } from "../modules/workspaces/repo";

type Reportable = DocumentRecord & { readonly status: "issued" | "cancelled" };

const isReportable = (row: DocumentRecord): row is Reportable => row.status !== "draft";

const storedFx = (
  fx: { readonly rate: BigDecimal.BigDecimal; readonly quantity: number } | null,
) => (fx === null ? null : ({ rate: fx.rate, quantity: fx.quantity } satisfies StoredFx));

const linked = (rows: ReadonlyArray<DocumentRecord>, relation: "corrected_by" | "corrects") =>
  EffectArray.flatMap(rows, (row) =>
    EffectArray.map(
      EffectArray.filter(row.links, (l) => l.relation === relation),
      (l) => l.id,
    ),
  );

/** The documents the rows' deduction lines deduct (PTDs, or a Proforma for uncovered cash). */
const deducted = (rows: ReadonlyArray<DocumentRecord>) =>
  EffectArray.flatMap(rows, (row) =>
    EffectArray.flatMap(row.lines, (l) => (l.deducts === null ? [] : [l.deducts])),
  );

const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

/** A document a stored reference points to (issued documents are never deleted). */
const relatedDocument = (
  related: ReadonlyMap<DocumentId, DocumentRecord>,
  row: DocumentRecord,
  id: DocumentId,
  reference: string,
): Effect.Effect<DocumentRecord> => {
  const found = related.get(id);
  return found === undefined
    ? Effect.die(new Error(`document ${row.id}: ${reference} target ${id} not found`))
    : Effect.succeed(found);
};

const toReportDocument = (
  row: Reportable,
  related: ReadonlyMap<DocumentId, DocumentRecord>,
): Effect.Effect<ReportDocument> =>
  Effect.gen(function* () {
    const creditNotes = yield* Effect.forEach(
      EffectArray.filter(row.links, (l) => l.relation === "corrected_by"),
      (l) => relatedDocument(related, row, l.id, "corrected_by"),
      { concurrency: 1 },
    );
    const corrects = Option.getOrUndefined(
      EffectArray.findFirst(row.links, (l) => l.relation === "corrects"),
    );
    const correctsKind: DocumentKind | null =
      row.kind === "credit_note" && corrects !== undefined
        ? (yield* relatedDocument(related, row, corrects.id, "corrects")).kind
        : null;
    const ptds = new Set<DocumentId>();
    for (const target of unique(deducted([row]))) {
      const doc = yield* relatedDocument(related, row, target, "deducts");
      if (doc.kind === "payment_tax_document") ptds.add(target);
    }
    const { totals, advanceDeductions } = reportFigures(row, (target) => ptds.has(target));
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind,
      finalInvoice:
        row.kind === "invoice" && EffectArray.some(row.links, (l) => l.relation === "advance_of"),
      correctsKind,
      status: row.status,
      number: row.number,
      contact: { id: row.contactId, name: row.contact.name },
      currency: row.currency,
      issuedOn: row.issuedOn,
      taxPoint: reportTaxPoint(row),
      dueOn: row.dueOn,
      totals,
      fx: storedFx(row.fx),
      advanceDeductions,
      settlement: row.settlement,
      outstanding: outstandingOf(row, creditNotes),
    };
  });

const toReportExpense = (workspaceId: WorkspaceId, e: ExpenseRecord): ReportExpense => ({
  id: e.id,
  workspaceId,
  supplierDocumentNumber: e.supplierDocumentNumber,
  supplier: e.supplier === null ? null : { contactId: e.supplier.contactId, name: e.supplier.name },
  category: e.category,
  tags: e.tags,
  issuedOn: e.issuedOn,
  taxPoint: e.taxPoint,
  currency: e.currency,
  totals: e.totals,
  selfAssessed: e.selfAssessed,
  fx: storedFx(e.fx),
  deductiblePercent: e.deductiblePercent,
});

/** `ReportsSource` on the documents, payments, expenses and workspaces repositories. */
export const ReportsSourceLive: Layer.Layer<
  ReportsSource,
  never,
  DocumentsRepo | PaymentsRepo | ExpensesRepo | ExpenseRecords | WorkspacesRepo
> = Layer.effect(
  ReportsSource,
  Effect.gen(function* () {
    const documentsRepo = yield* DocumentsRepo;
    const paymentsRepo = yield* PaymentsRepo;
    const expensesRepo = yield* ExpensesRepo;
    const expenseRecords = yield* ExpenseRecords;
    const workspacesRepo = yield* WorkspacesRepo;

    /** The rows' Credit Notes, corrected originals and deducted documents, by id (one read). */
    const relatedOf = (workspaceId: WorkspaceId, rows: ReadonlyArray<DocumentRecord>) =>
      Effect.map(
        documentsRepo.getMany(
          workspaceId,
          unique([...linked(rows, "corrected_by"), ...linked(rows, "corrects"), ...deducted(rows)]),
        ),
        (found) => new Map(EffectArray.map(found, (d) => [d.id, d] as const)),
      );

    const toReportDocuments = (workspaceId: WorkspaceId, rows: ReadonlyArray<DocumentRecord>) => {
      const reportable = EffectArray.filter(rows, isReportable);
      return Effect.flatMap(relatedOf(workspaceId, reportable), (related) =>
        Effect.forEach(reportable, (row) => toReportDocument(row, related), { concurrency: 1 }),
      );
    };

    const documents: ReportsSourceShape["documents"] = (workspaceId, range) =>
      Effect.flatMap(
        documentsRepo.reportable(workspaceId, {
          field: range.field,
          from: range.from,
          to: range.to,
        }),
        (rows) => toReportDocuments(workspaceId, rows),
      );

    const openReceivables: ReportsSourceShape["openReceivables"] = (workspaceId) =>
      Effect.map(
        Effect.flatMap(documentsRepo.receivable(workspaceId), (rows) =>
          toReportDocuments(workspaceId, rows),
        ),
        (docs) => EffectArray.filter(docs, (d) => BigDecimal.isPositive(d.outstanding)),
      );

    const payments: ReportsSourceShape["payments"] = Effect.fn("payments")(
      function* (workspaceId, range) {
        const rows = yield* paymentsRepo.paidBetween(workspaceId, range);
        const documentIds = unique(
          EffectArray.flatMap(rows, (p) => (p.documentId === null ? [] : [p.documentId])),
        );
        const expenseIds = unique(
          EffectArray.flatMap(rows, (p) => (p.expenseId === null ? [] : [p.expenseId])),
        );
        const value = yield* documentsRepo.getMany(workspaceId, documentIds);
        const docFx = new Map(EffectArray.map(value, (d) => [d.id, storedFx(d.fx)] as const));
        const expenseFx = new Map<ExpenseId, StoredFx | null>();
        for (const id of expenseIds) {
          const expense = yield* expensesRepo
            .get(workspaceId, id)
            .pipe(Effect.catchTag("NotFound", (e) => Effect.die(e)));
          expenseFx.set(id, storedFx(expense.figures?.fx ?? null));
        }
        return yield* Effect.forEach(
          rows,
          (row) => {
            const fx =
              row.documentId !== null
                ? docFx.get(row.documentId)
                : row.expenseId !== null
                  ? expenseFx.get(row.expenseId)
                  : undefined;
            return fx === undefined
              ? Effect.die(new Error(`payment ${row.id}: target not found`))
              : Effect.succeed<ReportPayment>({ ...reportPayment(row, fx), workspaceId });
          },
          { concurrency: 1 },
        );
      },
    );

    const expenses: ReportsSourceShape["expenses"] = (workspaceId, range) =>
      Effect.map(
        expenseRecords.complete(workspaceId, {
          field: range.field,
          from: range.from,
          to: range.to,
        }),
        (rows) => EffectArray.map(rows, (e) => toReportExpense(workspaceId, e)),
      );

    const taxRegimes: ReportsSourceShape["taxRegimes"] = (workspaceId) =>
      workspacesRepo.getWorkspace(workspaceId).pipe(
        Effect.map((row) =>
          EffectArray.map(row.taxRegimes, ({ effectiveFrom, regime }) => ({
            effectiveFrom,
            regime,
          })),
        ),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );

    return ReportsSource.of({
      documents,
      openReceivables,
      payments,
      expenses,
      incompleteExpenses: Effect.fn("ReportsSource.incompleteExpenses")((workspaceId) =>
        expenseRecords.incompleteCount(workspaceId),
      ),
      taxRegimes,
    });
  }),
);
