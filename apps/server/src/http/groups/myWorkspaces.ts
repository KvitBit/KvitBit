/** `myWorkspaces` group handlers (http-mcp-contracts 3.5.2): list and create workspaces for the signed-in account. */
import { API_PREFIX, Api, RequestCaller } from "@kvitbit/api-contract";
import { Workspaces } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Analytics } from "../../runtime/analytics";
import { requestOptions, requestWasReplayed, setLocation } from "../conventions";

export const MyWorkspacesGroupLive = HttpApiBuilder.group(
  Api,
  "myWorkspaces",
  Effect.fnUntraced(function* (handlers) {
    const workspaces = yield* Workspaces;
    const analytics = yield* Analytics;
    return handlers
      .handle("listMine", () => Effect.flatMap(RequestCaller, workspaces.listMine))
      .handle(
        "create",
        Effect.fnUntraced(function* ({ headers, payload }) {
          const caller = yield* RequestCaller;
          const member = yield* workspaces.create(caller, payload, requestOptions(headers));
          const view = yield* workspaces.current(member);
          yield* setLocation(`${API_PREFIX}/workspaces/${member.workspaceId}`);
          if (!(yield* requestWasReplayed)) {
            yield* analytics.capture({
              event: "workspace_created",
              userId: member.userId,
              workspaceId: member.workspaceId,
            });
          }
          return view;
        }),
      );
  }),
);
