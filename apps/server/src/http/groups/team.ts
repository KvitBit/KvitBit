/** `team` group handlers (http-mcp-contracts 3.5.3): members, invitations, roles and ownership transfer. */
import { API_PREFIX, Api, CurrentPrincipal } from "@kvitbit/api-contract";
import { Workspaces } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { requestOptions, setLocation } from "../conventions";
import { requireFreshSession } from "./workspace/freshSession";
import { changeMembershipAndRevokeCredentials } from "./workspace/revokeCredentials";

export const TeamGroupLive = HttpApiBuilder.group(Api, "team", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    const sql = yield* SqlClient.SqlClient;
    return handlers
      .handle("listMembers", () => workspaces.members)
      .handle("setRole", ({ params, payload }) => workspaces.setRole(params.userId, payload.role))
      .handle("removeMember", ({ params }) =>
        changeMembershipAndRevokeCredentials(
          sql,
          workspaces.setRole(params.userId, null),
          params.workspaceId,
          params.userId,
        ),
      )
      .handle("leave", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          yield* changeMembershipAndRevokeCredentials(
            sql,
            workspaces.leave,
            params.workspaceId,
            principal.userId,
          );
        }),
      )
      .handle("listInvitations", () => workspaces.invitations)
      .handle("invite", ({ params, headers, payload }) =>
        Effect.tap(
          workspaces.invite(payload.email, payload.role, requestOptions(headers)),
          (view) =>
            setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/invitations/${view.id}`),
        ),
      )
      .handle("revokeInvitation", ({ params }) => workspaces.revokeInvitation(params.invitationId))
      .handle("resendInvitation", ({ params }) => workspaces.resendInvitation(params.invitationId))
      .handle("transferOwnership", ({ payload }) =>
        Effect.andThen(requireFreshSession, workspaces.transferOwnership(payload.to)),
      );
  }),
);
