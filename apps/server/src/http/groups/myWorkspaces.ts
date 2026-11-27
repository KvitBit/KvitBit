/** `myWorkspaces` group handlers (http-mcp-contracts 3.5.2): list and create workspaces for the signed-in account. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { CurrentCaller, Workspaces } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requestOptions, setLocation } from "../conventions";

export const MyWorkspacesGroupLive = HttpApiBuilder.group(
  Api,
  "myWorkspaces",
  Effect.fnUntraced(function* (handlers) {
    const workspaces = yield* Workspaces;
    return handlers
      .handle("listMine", () => workspaces.listMine)
      .handle(
        "create",
        Effect.fnUntraced(function* ({ headers, payload }) {
          const member = yield* workspaces.create(payload, requestOptions(headers));
          const view = yield* Effect.provideService(workspaces.current, CurrentCaller, member);
          yield* setLocation(`${API_PREFIX}/workspaces/${member.workspaceId}`);
          return view;
        }),
      );
  }),
);
