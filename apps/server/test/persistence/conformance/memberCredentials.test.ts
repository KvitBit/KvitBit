import { expect, test } from "bun:test";
import { Caller, UserId, Workspaces } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { changeMembershipAndRevokeCredentials } from "../../../src/http/groups/workspace/revokeCredentials";
import { asCaller, runSqlCore } from "./sqlCore";

test("a credential cleanup failure rolls back membership removal and the preceding key deletion", async () => {
  const owner = {
    userId: UserId.make("01950000-0000-7000-8000-000000000001"),
    name: "Owner",
    email: "owner@example.test",
  };
  const member = {
    userId: UserId.make("01950000-0000-7000-8000-000000000002"),
    name: "Member",
    email: "member@example.test",
  };
  const exit = await runSqlCore(
    Caller.account({ ...owner, channel: "web", locale: "cs" }),
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workspaces = yield* Workspaces;
      const caller = yield* workspaces.create({ name: "Kvitbit fixture" });
      const workspace = caller.workspaceId;

      yield* sql`INSERT INTO memberships (workspace_id, user_id, role)
        VALUES (${workspace}, ${member.userId}, 'member')`;
      yield* sql`INSERT INTO auth.apikey (id, key, reference_id, workspace_id, created_by, access, scopes)
        VALUES ('key', 'fixture-hash', ${member.userId}, ${workspace}, ${member.userId}, 'read', '{documents:read}')`;
      yield* sql`INSERT INTO auth.oauth_client (id, client_id, redirect_uris)
        VALUES ('client', 'client', '{https://example.test/callback}')`;
      yield* sql`INSERT INTO auth.oauth_consent (id, client_id, user_id, workspace_id, access, granted_scopes, scopes)
        VALUES ('consent', 'client', ${member.userId}, ${workspace}, 'read', '{documents:read}', '{kvitbit:documents:read}')`;
      yield* sql`CREATE FUNCTION reject_consent_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic consent delete failure'; END;
        $$`;
      yield* sql`CREATE TRIGGER fail_consent_delete BEFORE DELETE ON auth.oauth_consent
        FOR EACH ROW EXECUTE FUNCTION reject_consent_delete()`;

      const remove = changeMembershipAndRevokeCredentials(
        sql,
        asCaller(caller, workspaces.setRole(member.userId, null)),
        workspace,
        member.userId,
      );
      const failed = yield* remove.pipe(Effect.result);
      const state = sql`SELECT
        exists(SELECT 1 FROM memberships WHERE workspace_id = ${workspace} AND user_id = ${member.userId} AND removed_at IS NULL) AS member,
        exists(SELECT 1 FROM auth.apikey WHERE id = 'key') AS key,
        exists(SELECT 1 FROM auth.oauth_consent WHERE id = 'consent') AS grant`;
      const [rolledBack] = yield* state;
      yield* sql`DROP TRIGGER fail_consent_delete ON auth.oauth_consent`;
      yield* remove;
      const [committed] = yield* state;
      return { failed, rolledBack, committed };
    }),
    { users: [owner, member] },
  );
  expect(exit).toMatchObject({
    _tag: "Success",
    value: {
      failed: { _tag: "Failure", failure: { _tag: "Unavailable" } },
      rolledBack: { member: true, key: true, grant: true },
      committed: { member: false, key: false, grant: false },
    },
  });
}, 30_000);
