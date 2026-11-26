import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { BunHttpServer } from "@effect/platform-bun";
import { READ_SCOPES, SESSION_COOKIE } from "@kvitbit/api-contract";
import { UserId } from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { PrincipalResolverLive } from "../../src/auth/PrincipalResolverLive";
import { McpConfigTest, McpRoutesLive } from "../../src/mcp";
import { createSeededWorkspace, joinMember, seedWorkspaceRow } from "./credentials/seed";
import { makeHarness, ORIGIN } from "./harness";

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

test.each(["DCR", "CIMD"])(
  "%s tokens keep their workspace through refresh and revocation",
  async (registration) => {
    const harness = makeHarness({
      principalResolver: "live",
      authOverrides: {
        fetchClientMetadata: async (input) => {
          expect(String(input)).toBe(clientMetadataUrl);
          return Response.json({ client_id: clientMetadataUrl, ...clientMetadata });
        },
      },
    });
    const core = Layer.succeedContext(await harness.runtime.context());
    const mcp = HttpRouter.toWebHandler(
      McpRoutesLive.pipe(
        Layer.provide([
          core,
          PrincipalResolverLive.pipe(Layer.provide(core)),
          McpConfigTest({ appOrigin: ORIGIN }),
          BunHttpServer.layerHttpServices,
        ]),
      ),
      { disableLogger: true },
    );

    const postJson = (path: string, body: unknown, cookie?: string) =>
      harness.fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      });

    try {
      await harness.run(TestClock.setTime(Date.now()));
      const identity = { email: "oauth-owner@example.test", password: "OAuth-test-password-123" };
      const signUp = await postJson("/api/auth/sign-up/email", {
        ...identity,
        name: "OAuth owner",
      });
      expect(signUp.status).toBe(200);
      const { user } = (await signUp.json()) as {
        user: { id: string; name: string; email: string };
      };
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

      let clientId = clientMetadataUrl;
      if (registration === "DCR") {
        const registered = await postJson("/api/auth/oauth2/register", clientMetadata);
        expect(registered.ok).toBe(true);
        clientId = ((await registered.json()) as { client_id: string }).client_id;
      }

      const startConsent = async (scope = "kvitbit:write offline_access") => {
        const verifier = randomBytes(32).toString("base64url");
        const state = randomBytes(12).toString("base64url");
        const query = new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          scope,
          resource,
          state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
        });
        const authorize = await harness.fetch(`/api/auth/oauth2/authorize?${query}`, {
          ...(cookie === undefined ? {} : { headers: { cookie } }),
          redirect: "manual",
        });
        expect([302, 303]).toContain(authorize.status);
        let location = new URL(authorize.headers.get("location") ?? "", ORIGIN);
        if (cookie === undefined) {
          expect(location.pathname).toBe("/sign-in");
          const signIn = await postJson("/api/auth/sign-in/email", {
            ...identity,
            oauth_query: location.search.slice(1),
          });
          expect(signIn.status).toBe(200);
          cookie = signIn.headers
            .getSetCookie()
            .find((value) => value.startsWith(`${SESSION_COOKIE}=`))
            ?.split(";", 1)[0];
          if (cookie === undefined) throw new Error("Better Auth did not return a session cookie");
          const { url } = (await signIn.json()) as { url: string };
          location = new URL(url, ORIGIN);
        }
        expect(location.pathname).toBe("/oauth/consent");
        const consentId = location.searchParams.get("consent_id");
        if (consentId === null) throw new Error("The consent redirect must include consent_id");
        const path = `/api/v1/oauth/consents/${encodeURIComponent(consentId)}`;
        return { path, state, verifier, cookie };
      };

      const consent = async (workspaceId: string) => {
        const { path, state, verifier, cookie: sessionCookie } = await startConsent();
        const view = await harness.fetch(path, { headers: { cookie: sessionCookie } });
        expect(view.status).toBe(200);
        if (workspaceId === second.workspaceId) {
          const { workspaces } = (await view.json()) as {
            workspaces: Array<{ id: string; maxAccess: string }>;
          };
          expect(workspaces.find((workspace) => workspace.id === workspaceId)?.maxAccess).toBe(
            "read",
          );
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
        const { redirectTo } = (await decide.json()) as { redirectTo: string };
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
        const body = (await response.json()) as {
          access_token: string;
          refresh_token: string;
          scope: string;
          expires_at: number;
          expires_in: number;
        };
        expect(response.status).toBe(200);
        expect(body.access_token).toBeTruthy();
        expect(body.refresh_token).toBeTruthy();
        expect(body.scope.split(" ").sort()).toEqual(["kvitbit:workspace:read", "offline_access"]);
        return body;
      };

      const readWorkspace = (accessToken: string, uri = "kvitbit://workspace") =>
        mcp.handler(
          new Request(resource, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "resources/read",
              params: { uri },
            }),
          }),
        );
      const expectWorkspace = async (accessToken: string, name: string) => {
        const response = await readWorkspace(accessToken);
        expect(response.status).toBe(200);
        const { result } = (await response.json()) as { result: { contents: [{ text: string }] } };
        expect(JSON.parse(result.contents[0].text)).toMatchObject({ name });
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
      const deniedCallback = new URL(((await denial.json()) as { redirectTo: string }).redirectTo);
      expect(deniedCallback.searchParams.get("error")).toBe("access_denied");
      expect(deniedCallback.searchParams.get("state")).toBe(denied.state);
      expect((await harness.fetch(denied.path, { headers: session })).status).toBe(404);

      const firstCode = await consent(first.workspaceId);
      const firstTokens = await tokens(await exchange(firstCode));
      await expectWorkspace(firstTokens.access_token, "OAuth Alpha");
      const outsideScope = await readWorkspace(firstTokens.access_token, "kvitbit://price-list");
      expect(await outsideScope.json()).toHaveProperty("error");
      const [rotation, parallelReplay] = await Promise.all([
        refresh(firstTokens.refresh_token),
        refresh(firstTokens.refresh_token),
      ]);
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

      const pendingCode = await consent(first.workspaceId);
      const pendingUntilReconnected = await consent(first.workspaceId);
      const appsPath = `/api/v1/workspaces/${first.workspaceId}/connected-apps`;
      const listed = await harness.fetch(appsPath, { headers: session });
      expect(listed.status).toBe(200);
      const [grant] = (await listed.json()) as [{ grantId: string }];
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
      await harness.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const digest = createHash("sha256")
            .update(secondTokens.refresh_token)
            .digest("base64url");
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
