/** `contacts` group handlers (http-mcp-contracts 3.5.4): one Contacts method per endpoint. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { Contacts } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { compact, requestOptions, setLocation, withRevision } from "../conventions";

export const ContactsGroupLive = HttpApiBuilder.group(Api, "contacts", (handlers) =>
  Effect.gen(function* () {
    const contacts = yield* Contacts;
    return handlers
      .handle("search", ({ query }) => contacts.search(compact(query)))
      .handle("get", ({ params }) => contacts.get(params.contactId))
      .handle("create", ({ params, headers, payload }) =>
        Effect.tap(contacts.save(payload, requestOptions(headers)), (view) =>
          typeof view.id === "string"
            ? setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/contacts/${view.id}`)
            : Effect.void,
        ),
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
