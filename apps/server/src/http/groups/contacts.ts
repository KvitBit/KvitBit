/** `contacts` group handlers (http-mcp-contracts 3.5.4): one Contacts method per endpoint. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { Contacts } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Predicate from "effect/Predicate";
import { compact, requestOptions, setLocation, withRevision } from "../conventions";

export const ContactsGroupLive = HttpApiBuilder.group(
  Api,
  "contacts",
  Effect.fnUntraced(function* (handlers) {
    const contacts = yield* Contacts;
    return handlers
      .handle("search", ({ query }) => contacts.search(compact(query)))
      .handle("get", ({ params }) => contacts.get(params.contactId))
      .handle("create", ({ params, headers, payload }) =>
        Effect.tap(contacts.save(payload, requestOptions(headers)), (view) => {
          if (!Predicate.isString(view.id)) return Effect.void;
          return setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/contacts/${view.id}`);
        }),
      )
      .handle("update", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          contacts.save({ ...payload, id: params.contactId, expectedRevision }),
        ),
      )
      .handle("fromIco", ({ payload }) =>
        contacts.fromIco(payload.ico, payload.role === undefined ? {} : { role: payload.role }),
      )
      .handle("archive", ({ params }) => contacts.archive(params.contactId));
  }),
);
