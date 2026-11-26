/**
 * `expenses` group handlers (http-mcp-contracts 3.4 & 3.5.4): CRUD, streamed multipart
 * attachment upload, download, and detach.
 */
import { API_PREFIX, Api, ATTACHMENT_MAX_BYTES } from "@kvitbit/api-contract";
import { Expenses } from "@kvitbit/domain/contract";
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { compact, fileDownload, requestOptions, setLocation, withRevision } from "../conventions";
import { streamSingleFile } from "./records/multipart";

export const ExpensesGroupLive = HttpApiBuilder.group(Api, "expenses", (handlers) =>
  Effect.gen(function* () {
    const expenses = yield* Expenses;
    return handlers
      .handle("list", ({ query }) => expenses.list(compact(query)))
      .handle("record", ({ params, headers, payload }) =>
        Effect.tap(expenses.record(payload, requestOptions(headers)), (view) =>
          typeof view.id === "string"
            ? setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/expenses/${view.id}`)
            : Effect.void,
        ),
      )
      .handle("get", ({ params }) => expenses.get(params.expenseId))
      .handle("edit", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          expenses.edit(params.expenseId, payload, expectedRevision),
        ),
      )
      .handle("remove", ({ params, headers }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          expenses.remove(params.expenseId, expectedRevision),
        ),
      )
      .handle("attach", ({ params, payload }) =>
        Effect.tap(
          streamSingleFile(payload, ATTACHMENT_MAX_BYTES, (file) =>
            expenses.attach(params.expenseId, file),
          ),
          (view) =>
            Predicate.hasProperty(view, "id") && typeof view.id === "string"
              ? setLocation(
                  `${API_PREFIX}/workspaces/${params.workspaceId}/expenses/${params.expenseId}/attachments/${view.id}`,
                )
              : Effect.void,
        ),
      )
      .handle("attachment", ({ params, query }) =>
        Effect.map(expenses.attachment(params.expenseId, params.attachmentId), (file) =>
          fileDownload(file, { disposition: query.disposition }),
        ),
      )
      .handle("detach", ({ params }) => expenses.detach(params.expenseId, params.attachmentId));
  }),
);
