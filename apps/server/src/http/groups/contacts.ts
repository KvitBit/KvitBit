/** `contacts` group handlers (http-mcp-contracts 3.5.4): one Contacts method per endpoint. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { Contacts, CurrentCaller, type WorkspaceId } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Analytics } from "../../runtime/analytics";
import {
  compact,
  requestOptions,
  requestWasReplayed,
  setLocation,
  withRevision,
} from "../conventions";

export const ContactsGroupLive = HttpApiBuilder.group(Api, "contacts", (handlers) =>
  Effect.gen(function* () {
    const contacts = yield* Contacts;
    const analytics = yield* Analytics;
    const captureContactSaved = (workspaceId: WorkspaceId, mode: "created" | "updated") =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller;
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
      .handle("search", ({ query }) => contacts.search(compact(query)))
      .handle("get", ({ params }) => contacts.get(params.contactId))
      .handle("create", ({ params, headers, payload }) =>
        contacts.save(payload, requestOptions(headers)).pipe(
          Effect.tap((view) =>
            typeof view.id === "string"
              ? setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/contacts/${view.id}`)
              : Effect.void,
          ),
          Effect.tap(() => captureContactSaved(params.workspaceId, "created")),
        ),
      )
      .handle("update", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          contacts.save({ ...payload, id: params.contactId, expectedRevision }),
        ).pipe(Effect.tap(() => captureContactSaved(params.workspaceId, "updated"))),
      )
      .handle("fromIco", ({ payload }) =>
        contacts.fromIco(payload.ico, payload.role === undefined ? {} : { role: payload.role }),
      )
      .handle("archive", ({ params }) => contacts.archive(params.contactId));
  }),
);
