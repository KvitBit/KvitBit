/** `contacts` group handlers (http-mcp-contracts 3.5.4): one Contacts method per endpoint. */

import { API_PREFIX, Api, RequestCaller } from "@kvitbit/api-contract";
import { Contacts, type WorkspaceId } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Predicate from "effect/Predicate";
import { Analytics } from "../../runtime/analytics";
import {
  compact,
  requestOptions,
  requestWasReplayed,
  setLocation,
  withRevision,
} from "../conventions";

export const ContactsGroupLive = HttpApiBuilder.group(
  Api,
  "contacts",
  Effect.fnUntraced(function* (handlers) {
    const contacts = yield* Contacts;
    const analytics = yield* Analytics;
    const captureContactSaved = Effect.fn("captureContactSaved")(function* (
      workspaceId: WorkspaceId,
      mode: "created" | "updated",
    ) {
      const caller = yield* RequestCaller;
      if (caller._tag === "Member" && !(yield* requestWasReplayed)) {
        yield* analytics.capture({
          event: "contact_saved",
          userId: caller.userId,
          workspaceId,
          mode,
        });
      }
    });
    return handlers
      .handle("search", ({ query }) =>
        Effect.flatMap(RequestCaller, (caller) => contacts.search(caller, compact(query))),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) => contacts.get(caller, params.contactId)),
      )
      .handle("create", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.tap(contacts.save(caller, payload, requestOptions(headers)), (view) => {
            if (!Predicate.isString(view["id"])) return Effect.void;
            return setLocation(
              `${API_PREFIX}/workspaces/${params.workspaceId}/contacts/${view["id"]}`,
            );
          }).pipe(Effect.tap(() => captureContactSaved(params.workspaceId, "created"))),
        ),
      )
      .handle("update", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            contacts.save(caller, { ...payload, id: params.contactId, expectedRevision }),
          ).pipe(Effect.tap(() => captureContactSaved(params.workspaceId, "updated"))),
        ),
      )
      .handle("fromIco", ({ payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          contacts.fromIco(
            caller,
            payload.ico,
            payload.role === undefined ? {} : { role: payload.role },
          ),
        ),
      )
      .handle("archive", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) => contacts.archive(caller, params.contactId)),
      );
  }),
);
