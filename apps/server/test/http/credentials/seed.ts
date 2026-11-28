/**
 * SQL and core seeding helpers for `apiKeys`, `connectedApps`, and `me` HTTP tests.
 * `TestCore` keeps Workspaces in memory while the edge credential/preference groups query the
 * migrated PGlite database (`SqlClient`), so tests mirror users and workspaces into Postgres
 * to exercise every real foreign key, check constraint, and index.
 */
import type { AccessMode } from "@kvitbit/api-contract";
import { WorkspacesModule } from "@kvitbit/core";
import { CaptureInvitationDelivery } from "@kvitbit/core/testing";
import {
  Caller,
  InvitationToken,
  type MemberCaller,
  type Role,
  Workspaces,
} from "@kvitbit/domain/contract";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import type { Harness, TestUser } from "../harness";

/** Inserts a Better Auth user row into `auth."user"` (idempotent). */
export const seedUser = Effect.fn("seedUser")(function* (user: TestUser) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    insert into auth."user" (id, name, email, email_verified)
    values (${user.id}, ${user.name}, ${user.email}, true)
    on conflict (id) do nothing
  `;
});

/** Inserts a Workspace row into `workspaces` so FK constraints on `auth.*` tables succeed. */
const insertWorkspaceRow = Effect.fn("insertWorkspaceRow")(function* (
  workspaceId: string,
  slug: string,
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    insert into workspaces (id, slug, name)
    values (${workspaceId}, ${slug}, ${name})
    on conflict (id) do nothing
  `;
});

export const seedWorkspaceRow = Effect.fn("seedWorkspaceRow")(
  (_h: Harness, workspaceId: string, slug: string, name = "Alfa s.r.o.") =>
    insertWorkspaceRow(workspaceId, slug, name),
  (effect, h) => h.run(effect),
);

/** Creates a Workspace in core AND mirrors the owner user + workspace row into PGlite. */
export const createSeededWorkspace = Effect.fn("createSeededWorkspace")(
  function* (h: Harness, owner: TestUser, slug: string, name = "Alfa s.r.o.") {
    yield* seedUser(owner);
    const member = yield* Effect.promise(() => h.createWorkspace(owner, { name }));
    yield* insertWorkspaceRow(member.workspaceId, slug, name);
    return member;
  },
  (effect, h) => h.run(effect),
);

/** Invites `invitee` into `owner`'s Workspace with `role`, accepts it, and mirrors the user in SQL. */
export const joinMember = Effect.fn("joinMember")(
  function* (_h: Harness, owner: MemberCaller, invitee: TestUser, role: Exclude<Role, "owner">) {
    yield* seedUser(invitee);
    const ws = yield* Workspaces;
    const capture = yield* CaptureInvitationDelivery;
    yield* ws.invite(owner, invitee.email, role);
    const sent = yield* Ref.get(capture.sent);
    const latest = sent.at(-1);
    if (latest === undefined) {
      return yield* Effect.die(new Error("Expected captured invitation delivery"));
    }
    const tokens = yield* WorkspacesModule.InvitationTokens;
    const token = yield* tokens.token(latest.invitationId, latest.epoch);
    return yield* ws.acceptInvitation(
      Caller.account({
        userId: invitee.id,
        email: invitee.email,
        locale: "cs",
        channel: "web",
      }),
      InvitationToken.make(token),
    );
  },
  (effect, h) => h.run(effect),
);

interface SeedOAuthClientInput {
  readonly id?: string;
  readonly clientId: string;
  readonly name: string | null;
  readonly redirectUris: ReadonlyArray<string>;
}

/** Inserts an OAuth 2.1 client into `auth.oauth_client`. */
export const seedOAuthClient = Effect.fn("seedOAuthClient")(function* (
  input: SeedOAuthClientInput,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    insert into auth.oauth_client (id, client_id, name, redirect_uris)
    values (
      ${input.id ?? `oc-${input.clientId}`},
      ${input.clientId},
      ${input.name},
      ${[...input.redirectUris]}
    )
    on conflict (client_id) do nothing
  `;
});

interface SeedOAuthGrantInput {
  readonly id: string;
  readonly clientId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly access: AccessMode;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly wireScopes?: ReadonlyArray<string>;
  readonly createdAt?: DateTime.Utc;
  readonly lastUsedAt?: DateTime.Utc | null;
}

const DEFAULT_GRANT_CREATED_AT = DateTime.makeUnsafe("2026-11-20T10:00:00.000Z");

/** Inserts a Workspace-bound MCP OAuth grant into `auth.oauth_consent`. */
export const seedOAuthGrant = Effect.fn("seedOAuthGrant")(function* (input: SeedOAuthGrantInput) {
  const sql = yield* SqlClient.SqlClient;
  const wireScopes = input.wireScopes ?? ["kvitbit:read"];
  const createdAt = DateTime.toDateUtc(input.createdAt ?? DEFAULT_GRANT_CREATED_AT);
  const lastUsedAt =
    input.lastUsedAt === undefined || input.lastUsedAt === null
      ? null
      : DateTime.toDateUtc(input.lastUsedAt);
  yield* sql`
    insert into auth.oauth_consent (
      id,
      client_id,
      user_id,
      scopes,
      created_at,
      updated_at,
      workspace_id,
      access,
      granted_scopes,
      last_used_at
    ) values (
      ${input.id},
      ${input.clientId},
      ${input.userId},
      ${[...wireScopes]},
      ${createdAt},
      ${createdAt},
      ${input.workspaceId},
      ${input.access},
      ${[...input.grantedScopes]},
      ${lastUsedAt}
    )
  `;
});

/** Inserts an access token and refresh token bound to `consentId`. */
export const seedOAuthTokens = Effect.fn("seedOAuthTokens")(function* (input: {
  readonly consentId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly suffix: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const refreshId = `rt-${input.suffix}`;
  const accessId = `at-${input.suffix}`;
  yield* sql`
    insert into auth.oauth_refresh_token (
      id, token, client_id, user_id, consent_id, scopes
    ) values (
      ${refreshId},
      ${`refresh-tok-${input.suffix}`},
      ${input.clientId},
      ${input.userId},
      ${input.consentId},
      ${["kvitbit:read", "offline_access"]}
    )
  `;
  yield* sql`
    insert into auth.oauth_access_token (
      id, token, client_id, user_id, consent_id, refresh_id, scopes
    ) values (
      ${accessId},
      ${`access-tok-${input.suffix}`},
      ${input.clientId},
      ${input.userId},
      ${input.consentId},
      ${refreshId},
      ${["kvitbit:read"]}
    )
  `;
});
