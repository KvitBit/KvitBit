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
  CurrentCaller,
  type InvitationToken,
  type MemberCaller,
  type Role,
  Workspaces,
} from "@kvitbit/domain/contract";
import { Effect, Ref } from "effect";
import { SqlClient } from "effect/sql";
import type { Harness, TestUser } from "../harness";

/** Inserts a Better Auth user row into `auth."user"` (idempotent). */
export const seedUser = (h: Harness, user: TestUser): Promise<void> =>
  h.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        insert into auth."user" (id, name, email, email_verified)
        values (${user.id}, ${user.name}, ${user.email}, true)
        on conflict (id) do nothing
      `;
    }),
  );

/** Inserts a Workspace row into `workspaces` so FK constraints on `auth.*` tables succeed. */
export const seedWorkspaceRow = (
  h: Harness,
  workspaceId: string,
  slug: string,
  name = "Alfa s.r.o.",
): Promise<void> =>
  h.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        insert into workspaces (id, slug, name)
        values (${workspaceId}, ${slug}, ${name})
        on conflict (id) do nothing
      `;
    }),
  );

/** Creates a Workspace in core AND mirrors the owner user + workspace row into PGlite. */
export const createSeededWorkspace = async (
  h: Harness,
  owner: TestUser,
  slug: string,
  name = "Alfa s.r.o.",
): Promise<MemberCaller> => {
  await seedUser(h, owner);
  const member = await h.createWorkspace(owner, { name });
  await seedWorkspaceRow(h, member.workspaceId, slug, name);
  return member;
};

/** Invites `invitee` into `owner`'s Workspace with `role`, accepts it, and mirrors the user in SQL. */
export const joinMember = async (
  h: Harness,
  owner: MemberCaller,
  invitee: TestUser,
  role: Exclude<Role, "owner">,
): Promise<MemberCaller> => {
  await seedUser(h, invitee);
  return h.run(
    Effect.gen(function* () {
      const ws = yield* Workspaces;
      const capture = yield* CaptureInvitationDelivery;
      yield* ws.invite(invitee.email, role).pipe(Effect.provideService(CurrentCaller, owner));
      const sent = yield* Ref.get(capture.sent);
      const latest = sent[sent.length - 1];
      if (latest === undefined) {
        return yield* Effect.die(new Error("Expected captured invitation delivery"));
      }
      const tokens = yield* WorkspacesModule.InvitationTokens;
      const token = (yield* tokens.token(latest.invitationId, latest.epoch)) as InvitationToken;
      return yield* ws.acceptInvitation(token).pipe(
        Effect.provideService(
          CurrentCaller,
          Caller.account({
            userId: invitee.id,
            email: invitee.email,
            locale: "cs",
            channel: "web",
          }),
        ),
      );
    }),
  );
};

export interface SeedOAuthClientInput {
  readonly id?: string;
  readonly clientId: string;
  readonly name: string | null;
  readonly redirectUris: ReadonlyArray<string>;
}

/** Inserts an OAuth 2.1 client into `auth.oauth_client`. */
export const seedOAuthClient = (h: Harness, input: SeedOAuthClientInput): Promise<void> =>
  h.run(
    Effect.gen(function* () {
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
    }),
  );

export interface SeedOAuthGrantInput {
  readonly id: string;
  readonly clientId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly access: AccessMode;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly wireScopes?: ReadonlyArray<string>;
  readonly createdAt?: Date;
  readonly lastUsedAt?: Date | null;
}

/** Inserts a Workspace-bound MCP OAuth grant into `auth.oauth_consent`. */
export const seedOAuthGrant = (h: Harness, input: SeedOAuthGrantInput): Promise<void> =>
  h.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const wireScopes = input.wireScopes ?? ["kvitbit:read"];
      const createdAt = input.createdAt ?? new Date("2026-11-20T10:00:00.000Z");
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
          ${input.lastUsedAt ?? null}
        )
      `;
    }),
  );

/** Inserts an access token and refresh token bound to `consentId`. */
export const seedOAuthTokens = (
  h: Harness,
  input: {
    readonly consentId: string;
    readonly clientId: string;
    readonly userId: string;
    readonly suffix: string;
  },
): Promise<void> =>
  h.run(
    Effect.gen(function* () {
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
    }),
  );
