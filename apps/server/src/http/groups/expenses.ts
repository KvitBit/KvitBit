/**
 * `expenses` group handlers (http-mcp-contracts 3.4 & 3.5.4): CRUD, streamed multipart
 * attachment upload, download, and detach.
 */
import { API_PREFIX, Api, ATTACHMENT_MAX_BYTES, RequestCaller } from "@kvitbit/api-contract";
import { Expenses } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Predicate from "effect/Predicate";
import {
  compact,
  downloadResponse,
  requestOptions,
  setLocation,
  withRevision,
} from "../conventions";
import { streamSingleFile } from "./records/multipart";

export const ExpensesGroupLive = HttpApiBuilder.group(
  Api,
  "expenses",
  Effect.fnUntraced(function* (handlers) {
    const expenses = yield* Expenses;
    return handlers
      .handle("list", ({ query }) =>
        Effect.flatMap(RequestCaller, (caller) => expenses.list(caller, compact(query))),
      )
      .handle("record", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.tap(expenses.record(caller, payload, requestOptions(headers)), (view) => {
            if (!Predicate.isString(view["id"])) return Effect.void;
            return setLocation(
              `${API_PREFIX}/workspaces/${params.workspaceId}/expenses/${view["id"]}`,
            );
          }),
        ),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) => expenses.get(caller, params.expenseId)),
      )
      .handle("edit", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            expenses.edit(caller, params.expenseId, payload, expectedRevision),
          ),
        ),
      )
      .handle("remove", ({ params, headers }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            expenses.remove(caller, params.expenseId, expectedRevision),
          ),
        ),
      )
      .handle("attach", ({ params, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.tap(
            streamSingleFile(payload, ATTACHMENT_MAX_BYTES, (file) =>
              expenses.attach(caller, params.expenseId, file),
            ),
            (view) => {
              if (!(Predicate.hasProperty(view, "id") && Predicate.isString(view.id)))
                return Effect.void;
              return setLocation(
                `${API_PREFIX}/workspaces/${params.workspaceId}/expenses/${params.expenseId}/attachments/${view.id}`,
              );
            },
          ),
        ),
      )
      .handle("attachment", ({ params, query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(
            expenses.attachment(caller, params.expenseId, params.attachmentId),
            downloadResponse({ disposition: query.disposition }),
          ),
        ),
      )
      .handle("detach", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          expenses.detach(caller, params.expenseId, params.attachmentId),
        ),
      );
  }),
);
