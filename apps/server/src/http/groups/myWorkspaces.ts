/** `myWorkspaces` group handlers (http-mcp-contracts 3.5.2): list and create workspaces for the signed-in account. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { CurrentCaller, Workspaces } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Analytics } from "../../runtime/analytics";
import { requestOptions, requestWasReplayed, setLocation } from "../conventions";

export const MyWorkspacesGroupLive = HttpApiBuilder.group(Api, "myWorkspaces", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    const analytics = yield* Analytics;
    return handlers
      .handle("listMine", () => workspaces.listMine)
      .handle("create", ({ headers, payload }) =>
        Effect.gen(function* () {
          const member = yield* workspaces.create(payload, requestOptions(headers));
          const view = yield* Effect.provideService(workspaces.current, CurrentCaller, member);
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
