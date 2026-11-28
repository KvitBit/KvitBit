import { expect, test } from "bun:test";
import { BunHttpServer } from "@effect/platform-bun";
import { READ_SCOPES, SESSION_COOKIE } from "@kvitbit/api-contract";
import { UserId } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { PrincipalResolverLive } from "../../src/auth/PrincipalResolverLive";
import { RateLimiterMemory } from "../../src/http";
import { McpConfigTest, McpRoutesLive } from "../../src/mcp";
import { createSeededWorkspace, joinMember, seedWorkspaceRow } from "./credentials/seed";
import { json, makeHarness, ORIGIN } from "./harness";

const encodeBase64Url = Schema.encodeEffect(Schema.Uint8ArrayFromBase64Url);
const redirectUri = "https://oauth-client.example.test/callback";
const resource = `${ORIGIN}/mcp`;
const clientMetadataUrl = "https://oauth-client.example/metadata.json";
const clientMetadata = {
  client_name: "Local MCP test client",
  redirect_uris: [redirectUri],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: "kvitbit:read kvitbit:write offline_access",
};

const signupFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    user: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
  }),
);
const registrationFields = Schema.decodeUnknownEffect(Schema.Struct({ client_id: Schema.String }));
const signInFields = Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String }));
const workspaceFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    workspaces: Schema.Array(Schema.Struct({ id: Schema.String, maxAccess: Schema.String })),
  }),
);
const redirectFields = Schema.decodeUnknownEffect(Schema.Struct({ redirectTo: Schema.String }));
const tokenFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    scope: Schema.String,
    expires_at: Schema.Finite,
    expires_in: Schema.Finite,
  }),
);
const resourceFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      contents: Schema.TupleWithRest(Schema.Tuple([Schema.Struct({ text: Schema.String })]), [
        Schema.Unknown,
      ]),
    }),
  }),
);
const grantFields = Schema.decodeUnknownEffect(
  Schema.TupleWithRest(Schema.Tuple([Schema.Struct({ grantId: Schema.String })]), [Schema.Unknown]),
);
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

test.each(["DCR", "CIMD"])(
  "%s tokens keep their workspace through refresh and revocation",
  async (registration) => {
    const harness = makeHarness({
      principalResolver: "live",
      authOverrides: {
        fetchClientMetadata: (input) => {
          expect(String(input)).toBe(clientMetadataUrl);
          return Promise.resolve(
            Response.json({ client_id: clientMetadataUrl, ...clientMetadata }),
          );
        },
      },
    });
    const core = Layer.succeedContext(await harness.runtime.context());
    const mcp = HttpRouter.toWebHandler(
      McpRoutesLive.pipe(
        Layer.provide([
          core,
          RateLimiterMemory,
          PrincipalResolverLive.pipe(Layer.provide(core)),
          McpConfigTest({ appOrigin: ORIGIN }),
          BunHttpServer.layerHttpServices,
        ]),
      ),
      { disableLogger: true },
    );

    const postJson = (path: string, body: Schema.Json, cookie?: string) => {
      const headers = new Headers({ origin: ORIGIN, "content-type": "application/json" });
      if (cookie !== undefined) headers.set("cookie", cookie);
      return harness.fetch(path, { ...json(body), method: "POST", headers });
    };

    try {
      const wallTime = Effect.runSync(Clock.currentTimeMillis);
      await harness.run(TestClock.setTime(wallTime));
      const identity = { email: "oauth-owner@example.test", password: "OAuth-test-password-123" };
      const signUp = await postJson("/api/auth/sign-up/email", {
        ...identity,
        name: "OAuth owner",
      });
      expect(signUp.status).toBe(200);
      const { user } = signupFields(await signUp.json()).pipe(Effect.runSync);
      await harness.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`update auth."user" set email_verified = true where id = ${user.id}`;
        }),
      );
      let cookie: string | undefined;

      const owner = { ...user, id: UserId.make(user.id) };
      const first = await harness.createWorkspace(owner, { name: "OAuth Alpha" });
      const second = await createSeededWorkspace(
        harness,
        harness.addUser("BetaOwner"),
        "oauth-beta",
        "OAuth Beta",
      );
      await joinMember(harness, second, owner, "accountant");
      await seedWorkspaceRow(harness, first.workspaceId, "oauth-alpha", "OAuth Alpha");

      const register = async () => {
        const registered = await postJson("/api/auth/oauth2/register", clientMetadata);
        expect(registered.ok).toBe(true);
        return registrationFields(await registered.json()).pipe(Effect.runSync).client_id;
      };
      const clientId = registration === "DCR" ? await register() : clientMetadataUrl;

      const signInAt = async (location: URL) => {
        expect(location.pathname).toBe("/sign-in");
        const signIn = await postJson("/api/auth/sign-in/email", {
          ...identity,
          oauth_query: EffectString.slice(1)(location.search),
        });
        expect(signIn.status).toBe(200);
        const sessionCookie = EffectArray.findFirst(
          signIn.headers.getSetCookie(),
          EffectString.startsWith(`${SESSION_COOKIE}=`),
        ).pipe(
          Option.map((value) => EffectString.split(value, ";")[0]),
          Option.getOrUndefined,
        );
        if (sessionCookie === undefined)
          throw new Error("Better Auth did not return a session cookie");
        const { url } = signInFields(await signIn.json()).pipe(Effect.runSync);
        return { cookie: sessionCookie, location: new URL(url, ORIGIN) };
      };

      const startConsent = async (scope = "kvitbit:write offline_access") => {
        const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))).pipe(
          Effect.runSync,
        );
        const state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(12))).pipe(
          Effect.runSync,
        );
        const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
        const query = new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          scope,
          resource,
          state,
          code_challenge: encodeBase64Url(new Uint8Array(challenge)).pipe(Effect.runSync),
          code_challenge_method: "S256",
        });
        const headers = new Headers();
        if (cookie !== undefined) headers.set("cookie", cookie);
        const authorize = await harness.fetch(`/api/auth/oauth2/authorize?${query}`, {
          headers,
          redirect: "manual",
        });
        expect([302, 303]).toContain(authorize.status);
        let location = new URL(authorize.headers.get("location") ?? "", ORIGIN);
        if (cookie === undefined) {
          ({ cookie, location } = await signInAt(location));
        }
        expect(location.pathname).toBe("/oauth/consent");
        const consentId = location.searchParams.get("consent_id");
        if (consentId === null) throw new Error("The consent redirect must include consent_id");
        const path = `/api/v1/oauth/consents/${encodeURIComponent(consentId)}`;
        return { path, state, verifier, cookie };
      };

      const checkAccountantConsent = async (
        view: Response,
        path: string,
        workspaceId: string,
        sessionCookie: string,
      ) => {
        const { workspaces } = workspaceFields(await view.json()).pipe(Effect.runSync);
        const workspace = EffectArray.findFirst(workspaces, (entry) => entry.id === workspaceId);
        expect(Option.getOrUndefined(workspace)?.maxAccess).toBe("read");
        const overRole = await postJson(
          path,
          {
            _tag: "Approve",
            workspace: workspaceId,
            grant: { access: "read_write" },
          },
          sessionCookie,
        );
        expect(overRole.status).toBe(403);
      };

      const consent = async (workspaceId: string) => {
        const { path, state, verifier, cookie: sessionCookie } = await startConsent();
        const view = await harness.fetch(path, { headers: { cookie: sessionCookie } });
        expect(view.status).toBe(200);
        if (workspaceId === second.workspaceId) {
          await checkAccountantConsent(view, path, workspaceId, sessionCookie);
        }
        const approval = {
          _tag: "Approve",
          workspace: workspaceId,
          grant: { access: "custom", scopes: ["workspace:read"] },
        };
        const decide = await postJson(path, approval, sessionCookie);
        expect(decide.status).toBe(200);
        expect((await harness.fetch(path, { headers: { cookie: sessionCookie } })).status).toBe(
          404,
        );
        expect((await postJson(path, approval, sessionCookie)).status).toBe(404);
        const { redirectTo } = redirectFields(await decide.json()).pipe(Effect.runSync);
        const callback = new URL(redirectTo);
        expect(callback.origin + callback.pathname).toBe(redirectUri);
        expect(callback.searchParams.get("state")).toBe(state);
        const code = callback.searchParams.get("code");
        if (code === null) throw new Error("Better Auth did not return an authorization code");
        return { code, verifier };
      };

      const tokenRequest = (body: Record<string, string>) =>
        harness.fetch("/api/auth/oauth2/token", {
          method: "POST",
          body: new URLSearchParams({ client_id: clientId, resource, ...body }),
        });
      const exchange = ({ code, verifier }: { code: string; verifier: string }) =>
        tokenRequest({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        });
      const refresh = (refreshToken: string) =>
        tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
      const tokens = async (response: Response) => {
        const body = tokenFields(await response.json()).pipe(Effect.runSync);
        expect(response.status).toBe(200);
        expect(body.access_token).toBeTruthy();
        expect(body.refresh_token).toBeTruthy();
        expect(EffectString.split(body.scope, " ").sort()).toEqual([
          "kvitbit:workspace:read",
          "offline_access",
        ]);
        return body;
      };

      const readWorkspace = (accessToken: string, uri = "kvitbit://workspace") =>
        mcp.handler(
          new Request(resource, {
            ...json({
              jsonrpc: "2.0",
              id: 1,
              method: "resources/read",
              params: { uri },
            }),
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
          }),
        );
      const expectWorkspace = async (accessToken: string, name: string) => {
        const response = await readWorkspace(accessToken);
        expect(response.status).toBe(200);
        const { result } = resourceFields(await response.json()).pipe(Effect.runSync);
        expect(parseJson(result.contents[0].text).pipe(Effect.runSync)).toMatchObject({ name });
      };

      const denied = await startConsent("kvitbit:read offline_access");
      const session = { cookie: denied.cookie };
      const readOnly = await harness.fetch(denied.path, { headers: session });
      expect(readOnly.status).toBe(200);
      expect(await readOnly.json()).toMatchObject({
        client: {
          id: clientId,
          name: clientMetadata.client_name,
          redirectHost: new URL(redirectUri).host,
        },
        requestedAccess: "read",
        requestedScopes: READ_SCOPES,
        workspaces: expect.arrayContaining([
          expect.objectContaining({
            id: first.workspaceId,
            role: "owner",
            offerableScopes: READ_SCOPES,
          }),
        ]),
      });
      const widened = await postJson(
        denied.path,
        {
          _tag: "Approve",
          workspace: first.workspaceId,
          grant: { access: "read_write" },
        },
        session.cookie,
      );
      expect(widened.status).toBe(403);
      const denial = await postJson(denied.path, { _tag: "Deny" }, session.cookie);
      expect(denial.status).toBe(200);
      const deniedCallback = new URL(
        redirectFields(await denial.json()).pipe(Effect.runSync).redirectTo,
      );
      expect(deniedCallback.searchParams.get("error")).toBe("access_denied");
      expect(deniedCallback.searchParams.get("state")).toBe(denied.state);
      expect((await harness.fetch(denied.path, { headers: session })).status).toBe(404);

      const firstCode = await consent(first.workspaceId);
      const firstTokens = await tokens(await exchange(firstCode));
      await expectWorkspace(firstTokens.access_token, "OAuth Alpha");
      const outsideScope = await readWorkspace(firstTokens.access_token, "kvitbit://price-list");
      expect(await outsideScope.json()).toHaveProperty("error");

      await harness.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`create function suppress_rotation_replay() returns trigger language plpgsql as $$
          begin
            if new.rotation_replay_response is not null then return null; end if;
            return new;
          end;
        $$`;
          yield* sql`create trigger suppress_rotation_replay before update on auth.oauth_refresh_token
          for each row execute function suppress_rotation_replay()`;
        }),
      );
      const missingReplay = await refresh(firstTokens.refresh_token);
      expect(missingReplay.status).toBe(500);
      expect(await missingReplay.json()).toEqual({ error: "server_error" });
      await harness.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`drop trigger suppress_rotation_replay on auth.oauth_refresh_token`;
          yield* sql`delete from auth.rate_limit`;
          yield* sql`create function delay_initial_bucket() returns trigger language plpgsql as $$
          begin perform pg_sleep(0.05); return new; end;
        $$`;
          yield* sql`create trigger delay_initial_bucket before insert on auth.rate_limit
          for each row execute function delay_initial_bucket()`;
        }),
      );

      const [rotation, parallelReplay] = await Promise.all([
        refresh(firstTokens.refresh_token),
        refresh(firstTokens.refresh_token),
      ]);
      await harness.run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`drop trigger delay_initial_bucket on auth.rate_limit`,
        ),
      );
      const rotated = await tokens(rotation);
      const expectSameRotation = (replayed: typeof rotated) => {
        expect(replayed.access_token === rotated.access_token).toBe(true);
        expect(replayed.refresh_token === rotated.refresh_token).toBe(true);
        expect(replayed.expires_at).toBe(rotated.expires_at);
        // A replay preserves absolute expiry and reports the remaining lifetime at response time.
        expect(replayed.expires_in).toBeLessThanOrEqual(rotated.expires_in);
        expect(replayed.expires_in).toBeGreaterThanOrEqual(rotated.expires_in - 10);
      };
      expectSameRotation(await tokens(parallelReplay));
      await expectWorkspace(rotated.access_token, "OAuth Alpha");
      expectSameRotation(await tokens(await refresh(firstTokens.refresh_token)));
      const secondTokens = await tokens(await exchange(await consent(second.workspaceId)));
      await expectWorkspace(secondTokens.access_token, "OAuth Beta");

      const revokedFamily = await harness.fetch("/api/auth/oauth2/revoke", {
        method: "POST",
        body: new URLSearchParams({
          client_id: clientId,
          token_type_hint: "refresh_token",
          token: firstTokens.refresh_token,
        }),
      });
      // Better Auth reports that the presented token was already rotated and revokes its family.
      expect(revokedFamily.status).toBe(400);
      expect((await readWorkspace(rotated.access_token)).status).toBe(401);
      await expectWorkspace(secondTokens.access_token, "OAuth Beta");

      const pendingCode = await consent(first.workspaceId);
      const pendingUntilReconnected = await consent(first.workspaceId);
      const appsPath = `/api/v1/workspaces/${first.workspaceId}/connected-apps`;
      const listed = await harness.fetch(appsPath, { headers: session });
      expect(listed.status).toBe(200);
      const [grant] = grantFields(await listed.json()).pipe(Effect.runSync);
      const revoked = await harness.fetch(`${appsPath}/${grant.grantId}`, {
        method: "DELETE",
        headers: { ...session, origin: ORIGIN },
      });
      expect(revoked.status).toBe(204);
      const staleExchange = await exchange(pendingCode);
      expect(staleExchange.status).toBe(400);
      expect(await staleExchange.json()).toMatchObject({ error: "invalid_grant" });
      expect((await readWorkspace(firstTokens.access_token)).status).toBe(401);
      expect((await readWorkspace(rotated.access_token)).status).toBe(401);
      expect((await refresh(rotated.refresh_token)).status).toBe(400);
      await expectWorkspace(secondTokens.access_token, "OAuth Beta");

      const reconnected = await tokens(await exchange(await consent(first.workspaceId)));
      await expectWorkspace(reconnected.access_token, "OAuth Alpha");
      const reconnectedList = await harness.fetch(appsPath, { headers: session });
      expect(reconnectedList.status).toBe(200);
      expect(await reconnectedList.json()).not.toContainEqual(
        expect.objectContaining({ grantId: grant.grantId }),
      );
      expect((await readWorkspace(rotated.access_token)).status).toBe(401);
      expect((await refresh(rotated.refresh_token)).status).toBe(400);

      const staleAfterReconnect = await exchange(pendingUntilReconnected);
      expect(staleAfterReconnect.status).toBe(400);
      expect(await staleAfterReconnect.json()).toMatchObject({ error: "invalid_grant" });

      const secondRotated = await tokens(await refresh(secondTokens.refresh_token));
      const digest = encodeBase64Url(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(secondTokens.refresh_token),
          ),
        ),
      ).pipe(Effect.runSync);
      await harness.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`update auth.oauth_refresh_token
        set rotation_replay_expires_at = current_timestamp - interval '1 second'
        where token = ${digest}`;
        }),
      );
      expect((await refresh(secondTokens.refresh_token)).status).toBe(400);
      expect((await readWorkspace(secondRotated.access_token)).status).toBe(401);
      await expectWorkspace(reconnected.access_token, "OAuth Alpha");
    } finally {
      await mcp.dispose();
      await harness.dispose();
    }
  },
  30_000,
);
