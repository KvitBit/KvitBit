/**
 * Test harness for the MCP Streamable HTTP adapter: `McpRoutesLive` behind
 * `HttpRouter.toWebHandler` on the SQL-backed core + `TestClock`.
 */
import { BunHttpServer } from "@effect/platform-bun";
import { ALL_SCOPES, type Principal, READ_SCOPES, Unauthorized } from "@kvitbit/api-contract";
import type { TestCoreOptions } from "@kvitbit/core/testing";
import {
  Caller,
  CurrentCaller,
  type Locale,
  type MemberCaller,
  type Scope,
  UserId,
  type WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient, Statement } from "effect/sql";
import { TestClock } from "effect/testing";
import { PrincipalResolver } from "../../src/auth/PrincipalResolver";
import { type RateLimiter, RateLimiterSql } from "../../src/http";
import { McpConfigTest, McpRoutesLive } from "../../src/mcp";
import { SqlTestCore } from "../persistence/conformance/sqlCore";

export const MCP_ORIGIN = "https://kvitbit.test";

export interface TestUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
}

export interface TestMcpGrant {
  readonly token: string;
  readonly user: TestUser;
  readonly workspaceId: WorkspaceId;
  readonly grantId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: ReadonlyArray<Scope>;
  readonly locale?: Locale;
}

const FakeMcpPrincipalResolver = (grants: Map<string, TestMcpGrant>) =>
  Layer.succeed(
    PrincipalResolver,
    PrincipalResolver.of({
      fromApiRequest: () => Effect.fail(new Unauthorized({ reason: "invalid" })),
      fromMcpBearer: (request) =>
        Effect.gen(function* () {
          const auth = request.headers.get("authorization");
          if (auth === null) return yield* new Unauthorized({ reason: "missing" });
          const match = /^Bearer[ ]+(\S+)\s*$/i.exec(auth);
          const rawToken = match?.[1];
          if (rawToken === undefined) return yield* new Unauthorized({ reason: "missing" });
          if (rawToken === "expired-token") {
            return yield* new Unauthorized({ reason: "expired" });
          }
          const grant = grants.get(rawToken);
          if (grant === undefined) return yield* new Unauthorized({ reason: "invalid" });
          return {
            userId: grant.user.id,
            email: grant.user.email,
            channel: "mcp",
            locale: grant.locale ?? "en",
            credential: {
              _tag: "McpGrant",
              grantId: grant.grantId,
              clientId: grant.clientId,
              clientName: grant.clientName,
              workspaceId: grant.workspaceId,
              scopes: [...grant.scopes],
            },
          } satisfies Principal;
        }),
    }),
  );

export interface McpHarnessOptions extends TestCoreOptions {
  readonly rateLimiter?: Layer.Layer<RateLimiter>;
}

export const makeMcpHarness = (options: McpHarnessOptions = {}) => {
  const { rateLimiter, ...coreOptions } = options;
  const users = new Map<string, TestUser>();
  const grants = new Map<string, TestMcpGrant>();
  const seededGrants = new Map<string, Promise<unknown>>();

  const clockLayer = Layer.effectDiscard(
    TestClock.setTime(Date.parse("2026-11-23T10:00:00Z")),
  ).pipe(Layer.provideMerge(TestClock.layer()));
  const core = SqlTestCore(coreOptions).pipe(Layer.provideMerge(clockLayer));
  const runtime = ManagedRuntime.make(core);
  const seedUser = (user: TestUser) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO auth."user" (id, name, email) VALUES (${user.id}, ${user.name}, ${user.email})
        ON CONFLICT (id) DO NOTHING
      `;
    });
  const seedGrant = (grant: TestMcpGrant) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUser(grant.user);
        yield* sql`
        INSERT INTO auth.oauth_client (id, client_id, redirect_uris)
        VALUES (${grant.clientId}, ${grant.clientId}, '{}')
        ON CONFLICT (id) DO NOTHING
      `;
        yield* sql`
        INSERT INTO auth.oauth_consent (id, client_id, user_id, workspace_id, scopes, access, granted_scopes)
        VALUES (${grant.grantId}, ${grant.clientId}, ${grant.user.id}, ${grant.workspaceId},
          '{kvitbit:read}', 'custom', string_to_array(${grant.scopes.join(",")}, ','))
        ON CONFLICT (id) DO NOTHING
      `;
      }),
    );
  const sharedCore = Layer.effectContext(runtime.contextEffect);
  const limiterLayer =
    rateLimiter !== undefined ? rateLimiter : RateLimiterSql.pipe(Layer.provide(sharedCore));
  const app = McpRoutesLive.pipe(
    Layer.provide([
      sharedCore,
      limiterLayer,
      FakeMcpPrincipalResolver(grants),
      McpConfigTest({ appOrigin: MCP_ORIGIN }),
      BunHttpServer.layerHttpServices,
    ]),
  );

  const instances = new Set<ReturnType<typeof HttpRouter.toWebHandler>>();
  const createInstance = (transform?: Statement.Transformer) => {
    const routes =
      transform === undefined
        ? app
        : app.pipe(Layer.provide(Layer.succeed(Statement.CurrentTransformer, transform)));
    const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
    instances.add(web);

    const fetch = (path: string, init: RequestInit = {}) =>
      web.handler(new Request(`${MCP_ORIGIN}${path}`, init));

    const postMcp = async (
      token: string | null,
      body: unknown,
      extraHeaders: Record<string, string> = {},
    ) => {
      const grant = token === null ? undefined : grants.get(token);
      if (grant !== undefined && !seededGrants.has(grant.grantId)) {
        seededGrants.set(grant.grantId, seedGrant(grant));
      }
      if (grant !== undefined) await seededGrants.get(grant.grantId);
      return fetch("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    };

    const rpc = async (
      token: string | null,
      method: string,
      params?: Record<string, unknown>,
      id: string | number = 1,
      extraHeaders: Record<string, string> = {},
    ) => {
      const res = await postMcp(
        token,
        { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) },
        extraHeaders,
      );
      const json = (await res.json()) as Record<string, unknown>;
      return { res, json };
    };

    const callTool = async (
      token: string,
      name: string,
      args: Record<string, unknown> = {},
      id: string | number = 1,
    ) => {
      const { res, json } = await rpc(token, "tools/call", { name, arguments: args }, id);
      return {
        res,
        json,
        result: json.result as
          | {
              readonly isError: boolean;
              readonly content: ReadonlyArray<Record<string, unknown>>;
              readonly structuredContent?: Record<string, unknown>;
            }
          | undefined,
        error: json.error as
          | { readonly code: number; readonly message: string; readonly data?: unknown }
          | undefined,
      };
    };

    const readResource = async (token: string, uri: string, id: string | number = 1) => {
      const { res, json } = await rpc(token, "resources/read", { uri }, id);
      return {
        res,
        json,
        contents: (
          json.result as { readonly contents?: ReadonlyArray<Record<string, unknown>> } | undefined
        )?.contents,
        error: json.error as
          | { readonly code: number; readonly message: string; readonly data?: unknown }
          | undefined,
      };
    };

    return {
      fetch,
      postMcp,
      rpc,
      callTool,
      readResource,
      dispose: async () => {
        instances.delete(web);
        await web.dispose();
      },
    };
  };
  const instance = createInstance();

  const addUser = (name: string): TestUser => {
    const id = UserId.make(`01900000-0000-7000-8000-${String(users.size + 1).padStart(12, "0")}`);
    const user = { id, name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.cz` };
    users.set(id, user);
    return user;
  };

  const createWorkspace = (
    user: TestUser,
    input: Record<string, unknown> = { name: "Kvitbit Test s.r.o.", taxRegime: "vat_payer" },
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* seedUser(user);
        const ws = yield* Workspaces;
        return yield* ws.create(input as never);
      }).pipe(
        Effect.provideService(
          CurrentCaller,
          Caller.account({ userId: user.id, email: user.email, locale: "en", channel: "web" }),
        ),
      ),
    ) as Promise<MemberCaller>;

  const addGrant = (
    grant: Omit<TestMcpGrant, "token"> & { readonly token?: string },
  ): TestMcpGrant => {
    const token = grant.token ?? `mcp_tok_${grants.size + 1}`;
    const full: TestMcpGrant = { ...grant, token };
    grants.set(token, full);
    return full;
  };

  const addReadWriteGrant = (user: TestUser, workspaceId: WorkspaceId, locale: Locale = "en") =>
    addGrant({
      user,
      workspaceId,
      grantId: `grant-rw-${grants.size + 1}`,
      clientId: `client-claude-${grants.size + 1}`,
      clientName: "Claude Desktop",
      scopes: ALL_SCOPES,
      locale,
    });

  const addReadOnlyGrant = (user: TestUser, workspaceId: WorkspaceId, locale: Locale = "en") =>
    addGrant({
      user,
      workspaceId,
      grantId: `grant-ro-${grants.size + 1}`,
      clientId: `client-reader-${grants.size + 1}`,
      clientName: "ReadOnly Agent",
      scopes: READ_SCOPES,
      locale,
    });

  const dispose = async () => {
    await Promise.all([...instances].map((web) => web.dispose()));
    await runtime.dispose();
  };

  return {
    ...instance,
    createInstance,
    addUser,
    createWorkspace,
    addGrant,
    addReadWriteGrant,
    addReadOnlyGrant,
    run: runtime.runPromise,
    dispose,
  };
};
