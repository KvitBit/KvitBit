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
  type NewWorkspace,
  type Scope,
  UserId,
  type WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import { PrincipalResolver } from "../../src/auth/PrincipalResolver";
import { type RateLimiter, RateLimiterSql } from "../../src/http";
import { McpConfigTest, McpRoutesLive } from "../../src/mcp";
import { ServerDocumentProjectionsLive } from "../../src/projections/documents";
import { SqlTestCore } from "../persistence/conformance/sqlCore";

export const MCP_ORIGIN = "https://kvitbit.test";

const BEARER_TOKEN = /^Bearer[ ]+(\S+)\s*$/i;
const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
type RpcObject = typeof JsonRecord.Type;
type PostBody = Schema.Json | RpcObject | ReadonlyArray<RpcObject> | undefined;
const decodeRpcResponse = JsonRecord.pipe(Schema.fromJsonString, Schema.decodeUnknownEffect);
const decodeToolResult = Schema.Struct({
  isError: Schema.Boolean,
  content: Schema.Array(JsonRecord),
  structuredContent: Schema.optionalKey(JsonRecord),
}).pipe(
  (result) => Schema.StructWithRest(result, [JsonRecord]),
  Schema.UndefinedOr,
  Schema.decodeUnknownEffect,
);
const decodeResourceResult = Schema.Struct({
  contents: Schema.Array(JsonRecord).pipe(Schema.optionalKey),
}).pipe(Schema.UndefinedOr, Schema.decodeUnknownEffect);
const decodeRpcError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
}).pipe(
  (error) => Schema.StructWithRest(error, [JsonRecord]),
  Schema.UndefinedOr,
  Schema.decodeUnknownEffect,
);
const encodeJson = Schema.Unknown.pipe(Schema.fromJsonString, Schema.encodeEffect);

class McpIoError extends Schema.TaggedError<McpIoError, { readonly brand: unique symbol }>()(
  "McpIoError",
  {
    operation: Schema.Literals(["post", "read"]),
    cause: Schema.Unknown,
  },
) {}

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
      fromApiRequest: () => Effect.fail(Unauthorized.make({ reason: "invalid" })),
      fromMcpBearer: (request) =>
        Effect.gen(function* () {
          const auth = request.headers.get("authorization");
          if (auth === null) return yield* Unauthorized.make({ reason: "missing" });
          const match = BEARER_TOKEN.exec(auth);
          const rawToken = match?.[1];
          if (rawToken === undefined) return yield* Unauthorized.make({ reason: "missing" });
          if (rawToken === "expired-token") {
            return yield* Unauthorized.make({ reason: "expired" });
          }
          const grant = grants.get(rawToken);
          if (grant === undefined) return yield* Unauthorized.make({ reason: "invalid" });
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
  const core = ServerDocumentProjectionsLive.pipe(
    Layer.provideMerge(SqlTestCore(coreOptions)),
    Layer.provideMerge(clockLayer),
  );
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
          '{kvitbit:read}', 'custom', string_to_array(${Arr.join(grant.scopes, ",")}, ','))
        ON CONFLICT (id) DO NOTHING
      `;
      }),
    );
  const ensureGrantSeeded = (grant: TestMcpGrant) => {
    const pending = seededGrants.get(grant.grantId);
    if (pending !== undefined) return pending;
    const seeded = seedGrant(grant);
    seededGrants.set(grant.grantId, seeded);
    return seeded;
  };
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

    const post = Effect.fn(function* (
      token: string | null,
      body: PostBody,
      extraHeaders: Record<string, string> = {},
    ) {
      const grant = token === null ? undefined : grants.get(token);
      if (grant !== undefined) {
        yield* Effect.promise(() => ensureGrantSeeded(grant));
      }
      const contentHeaders = { "content-type": "application/json" };
      const headers =
        token === null ? contentHeaders : { ...contentHeaders, authorization: `Bearer ${token}` };
      const requestBody = Str.isString(body) || body === undefined ? body : yield* encodeJson(body);
      return yield* Effect.tryPromise({
        try: () =>
          fetch("/mcp", {
            method: "POST",
            headers: { ...headers, ...extraHeaders },
            body: requestBody ?? null,
          }),
        catch: (cause) => McpIoError.make({ operation: "post", cause }),
      });
    });

    const requestRpc = Effect.fn(function* (
      token: string | null,
      method: string,
      params?: RpcObject,
      id: string | number = 1,
      extraHeaders: Record<string, string> = {},
    ) {
      const res = yield* post(token, { jsonrpc: "2.0", id, method, params }, extraHeaders);
      const body = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (cause) => McpIoError.make({ operation: "read", cause }),
      });
      const json = yield* decodeRpcResponse(body);
      return { res, json };
    });

    const invokeTool = Effect.fn(function* (
      token: string,
      name: string,
      args: RpcObject = {},
      id: string | number = 1,
    ) {
      const { res, json } = yield* requestRpc(token, "tools/call", { name, arguments: args }, id);
      return {
        res,
        json,
        result: yield* decodeToolResult(json["result"]),
        error: yield* decodeRpcError(json["error"]),
      };
    });

    const requestResource = Effect.fn(function* (
      token: string,
      uri: string,
      id: string | number = 1,
    ) {
      const { res, json } = yield* requestRpc(token, "resources/read", { uri }, id);
      const result = yield* decodeResourceResult(json["result"]);
      return {
        res,
        json,
        contents: result?.contents,
        error: yield* decodeRpcError(json["error"]),
      };
    });

    return {
      fetch,
      postMcp: (...args: Parameters<typeof post>) => Effect.runPromise(post(...args)),
      rpc: (...args: Parameters<typeof requestRpc>) => Effect.runPromise(requestRpc(...args)),
      callTool: (...args: Parameters<typeof invokeTool>) => Effect.runPromise(invokeTool(...args)),
      readResource: (...args: Parameters<typeof requestResource>) =>
        Effect.runPromise(requestResource(...args)),
      dispose: () => {
        instances.delete(web);
        return web.dispose();
      },
    };
  };
  const instance = createInstance();

  const addUser = (name: string): TestUser => {
    const id = UserId.make(
      `01900000-0000-7000-8000-${Str.padStart(12, "0")(String(users.size + 1))}`,
    );
    const user = {
      id,
      name,
      email: `${Str.replace(/\s+/g, ".")(Str.toLowerCase(name))}@example.cz`,
    };
    users.set(id, user);
    return user;
  };

  const createWorkspace = (
    user: TestUser,
    input: NewWorkspace = { name: "Kvitbit Test s.r.o.", taxRegime: "vat_payer" },
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* seedUser(user);
        const ws = yield* Workspaces;
        return yield* ws.create(input);
      }).pipe(
        Effect.provideService(
          CurrentCaller,
          Caller.account({ userId: user.id, email: user.email, locale: "en", channel: "web" }),
        ),
      ),
    );

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

  const dispose = () =>
    Effect.runPromise(
      Effect.forEach(instances, (web) => Effect.promise(() => web.dispose()), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.andThen(Effect.promise(() => runtime.dispose()))),
    );

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
