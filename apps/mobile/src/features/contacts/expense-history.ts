import type { ContactId, WorkspaceId } from "@kvitbit/domain/contract";
import { inWorkspace, type KvitbitApiClient, pageQuery, UiError } from "@kvitbit/ui-port/api";
import { Effect } from "effect";
import { feedRequest, scanFeedPages } from "../dashboard/paged-feed";
import {
  decodeExpenseDetail,
  decodeExpenseSummary,
  type ExpenseDetailData,
} from "../expenses/model";

export type ContactExpense = Pick<
  ExpenseDetailData,
  "id" | "supplierDocumentNumber" | "issuedOn" | "total" | "currency" | "status"
>;

export const loadSupplierExpenses = (
  api: KvitbitApiClient,
  workspaceId: WorkspaceId,
  contactId: ContactId,
) =>
  Effect.gen(function* () {
    const expenses: ContactExpense[] = [];
    const seen = new Set<string>();

    yield* scanFeedPages(
      (cursor) =>
        api.expenses.list({ params: inWorkspace(workspaceId), query: pageQuery({}, cursor) }),
      (items) =>
        Effect.gen(function* () {
          const ids = [];
          for (const item of items) {
            const { id } = decodeExpenseSummary(item);
            if (id === "") return yield* Effect.fail(UiError.unexpected());
            if (!seen.has(id)) {
              seen.add(id);
              ids.push(id);
            }
          }

          const details = yield* Effect.forEach(
            ids,
            (expenseId) =>
              feedRequest(api.expenses.get({ params: { workspaceId, expenseId } })).pipe(
                Effect.flatMap((view) => {
                  const detail = decodeExpenseDetail(view);
                  return detail.id === expenseId
                    ? Effect.succeed(detail)
                    : Effect.fail(UiError.unexpected());
                }),
                // An expense can be removed between listing it and opening it.
                Effect.catchTag("NotFound", (error) =>
                  error.entity === "Expense" && error.id === expenseId
                    ? Effect.succeed(null)
                    : Effect.fail(error),
                ),
              ),
            { concurrency: 4 },
          );
          for (const detail of details) {
            if (detail?.supplier?.contactId === contactId) {
              const { id, supplierDocumentNumber, issuedOn, total, currency, status } = detail;
              expenses.push({ id, supplierDocumentNumber, issuedOn, total, currency, status });
            }
          }
          return true;
        }),
    );

    return expenses;
  });
