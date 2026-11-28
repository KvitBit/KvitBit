/** `team` group handlers (http-mcp-contracts 3.5.3): members, invitations, roles and ownership transfer. */

import { API_PREFIX, Api, CurrentPrincipal, RequestCaller } from "@kvitbit/api-contract";
import { Workspaces } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "../../runtime/analytics";
import { requestOptions, requestWasReplayed, setLocation } from "../conventions";
import { requireFreshSession } from "./workspace/freshSession";
import { changeMembershipAndRevokeCredentials } from "./workspace/revokeCredentials";

export const TeamGroupLive = HttpApiBuilder.group(
  Api,
  "team",
  Effect.fnUntraced(function* (handlers) {
    const workspaces = yield* Workspaces;
    const sql = yield* SqlClient.SqlClient;
    const analytics = yield* Analytics;
    return handlers
      .handle("listMembers", () => Effect.flatMap(RequestCaller, workspaces.members))
      .handle("setRole", ({ params, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          workspaces.setRole(caller, params.userId, payload.role),
        ),
      )
      .handle("removeMember", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          changeMembershipAndRevokeCredentials(
            sql,
            workspaces.setRole(caller, params.userId, null),
            params.workspaceId,
            params.userId,
          ),
        ),
      )
      .handle(
        "leave",
        Effect.fnUntraced(function* ({ params }) {
          const caller = yield* RequestCaller;
          const principal = yield* CurrentPrincipal;
          yield* changeMembershipAndRevokeCredentials(
            sql,
            workspaces.leave(caller),
            params.workspaceId,
            principal.userId,
          );
        }),
      )
      .handle("listInvitations", () => Effect.flatMap(RequestCaller, workspaces.invitations))
      .handle("invite", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.tap(
            workspaces.invite(caller, payload.email, payload.role, requestOptions(headers)),
            (view) =>
              setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/invitations/${view.id}`),
          ).pipe(
            Effect.tap(
              Effect.fn("Analytics.captureInvite")(function* (view) {
                if (caller._tag === "Member" && !(yield* requestWasReplayed)) {
                  yield* analytics.capture({
                    event: "team_invitation_sent",
                    userId: caller.userId,
                    workspaceId: params.workspaceId,
                    role: view.role,
                  });
                }
              }),
            ),
          ),
        ),
      )
      .handle("revokeInvitation", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          workspaces.revokeInvitation(caller, params.invitationId),
        ),
      )
      .handle("resendInvitation", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          workspaces.resendInvitation(caller, params.invitationId),
        ),
      )
      .handle("transferOwnership", ({ payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.andThen(requireFreshSession, workspaces.transferOwnership(caller, payload.to)),
        ),
      );
  }),
);
