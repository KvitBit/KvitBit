/**
 * Test harness for the HTTP edge: `HttpRoutesLive` behind `HttpRouter.toWebHandler` on TestCore
 * (memory persistence and fakes). Credentials come from `FakePrincipalResolver` unless a test
 * provides the real one:
 *
 * - `Authorization: Bearer session:<userId>` -> mobile session principal;
 * - cookie `__Secure-kvitbit.session_token=session:<userId>` -> web session principal;
 * - `Authorization: Bearer kvb_key:<userId>:<workspaceId>:<scope,scope>` -> API Key principal.
 *
 * `harness.run` runs an effect against the same TestCore and database (SqlClient).
 *
 * Users are registered with `harness.addUser`; `harness.createWorkspace` creates a Workspace
 * owned by a user directly in core (as its Account caller).
 */
import { BunHttpServer } from "@effect/platform-bun";
import { type BotProtection, NoopBotProtection } from "@kvitbit/adapters/altcha";
import { ApiKeyId, type Principal, SESSION_COOKIE, Unauthorized } from "@kvitbit/api-contract";
import { TestCore, type TestCoreOptions } from "@kvitbit/core/testing";
import {
  Caller,
  CurrentCaller,
  type MemberCaller,
  type Scope,
  UserId,
  WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import type { EmailSender } from "@kvitbit/domain/ports";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { TestClock } from "effect/testing";
import {
  AuthServerLive,
  type AuthServerOverrides,
  makeAuthServerLayer,
} from "../../src/auth/AuthServerLive";
import { PrincipalResolver } from "../../src/auth/PrincipalResolver";
import { PrincipalResolverLive } from "../../src/auth/PrincipalResolverLive";
import { HttpConfigTest, HttpRoutesLive, RateLimiterMemory } from "../../src/http";
import { acceptLanguageLocale, bearerToken } from "../../src/http/edge/request";
import { ServerDocumentProjectionsLive } from "../../src/projections/documents";
import { type Analytics, AnalyticsNoop } from "../../src/runtime/analytics";
import { TestDatabase } from "./database";

export const ORIGIN = "https://kvitbit.test";
export const TEST_NOW = Date.UTC(2026, 10, 23, 9, 0, 0);

export interface TestUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
}

const cookieValue = (header: string | null, name: string) =>
  header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** Resolves the fake credentials described above against `users`. */
export const FakePrincipalResolver = (users: Map<string, TestUser>) =>
  Layer.succeed(
    PrincipalResolver,
    PrincipalResolver.of({
      fromApiRequest: (request) =>
        Effect.gen(function* () {
          const locale =
            acceptLanguageLocale(request.headers.get("accept-language") ?? undefined) ?? "cs";
          const bearer = bearerToken(request.headers.get("authorization") ?? undefined);
          const cookie = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
          const value = bearer ?? cookie;
          if (value === undefined) return yield* new Unauthorized({ reason: "missing" });
          const [kind, userId = "", workspaceId = "", scopes = ""] = value.split(":");
          const user = users.get(userId);
          if (user === undefined) return yield* new Unauthorized({ reason: "invalid" });
          if (kind === "session") {
            return {
              userId: user.id,
              email: user.email,
              channel: bearer === undefined ? "web" : "mobile",
              locale,
              credential: {
                _tag: "Session",
                sessionId: `s-${userId}`,
                authenticatedAt: new Date(TEST_NOW).toISOString(),
              },
            } satisfies Principal;
          }
          if (kind === "kvb_key" && bearer !== undefined) {
            return {
              userId: user.id,
              email: user.email,
              channel: "api",
              locale,
              credential: {
                _tag: "ApiKey",
                keyId: ApiKeyId.make("01900000-0000-7000-8000-0000000000aa"),
                keyName: "test key",
                workspaceId: WorkspaceId.make(workspaceId),
                scopes: scopes.split(",").filter((s) => s.length > 0) as Array<Scope>,
              },
            } satisfies Principal;
          }
          return yield* new Unauthorized({ reason: "invalid" });
        }),
      fromMcpBearer: () => Effect.fail(new Unauthorized({ reason: "invalid" })),
    }),
  );

export interface HarnessOptions extends TestCoreOptions {
  /** Replace the fake resolver (e.g. `"live"` for `PrincipalResolverLive`, or a custom layer). */
  readonly principalResolver?: "live" | Layer.Layer<PrincipalResolver>;
  readonly botProtection?:
    | Layer.Layer<BotProtection>
    | Layer.Layer<BotProtection, never, import("effect/sql").SqlClient.SqlClient>;
  readonly authOverrides?: AuthServerOverrides;
  readonly authEmailSender?: Layer.Layer<EmailSender>;
  readonly logger?: Layer.Layer<never>;
  readonly config?: Parameters<typeof HttpConfigTest>[0];
  readonly analytics?: Layer.Layer<Analytics>;
  readonly feedbackFetch?: typeof globalThis.fetch;
}

export const makeHarness = (options: HarnessOptions = {}) => {
  const users = new Map<string, TestUser>();
  const memoMap = Layer.makeMemoMapUnsafe();
  // TestCore on memory ports, plus a migrated PGlite database (SqlClient) for the edge's own
  // tables (auth.*, user_preferences, rate limits). Both are memoized, so the web handler and
  // `run` share one instance.
  const configLayer = HttpConfigTest(options.config);
  const projectedTestCore = ServerDocumentProjectionsLive.pipe(
    Layer.provideMerge(TestCore(options)),
  );
  const dbAndCore = Layer.mergeAll(
    projectedTestCore,
    TestDatabase,
    configLayer,
    options.analytics ?? AnalyticsNoop,
  ).pipe(Layer.provideMerge(TestClock.layer()));
  const botLayer = (options.botProtection ?? NoopBotProtection).pipe(Layer.provide(dbAndCore));
  const baseCore = Layer.merge(dbAndCore, botLayer);
  const authLayer = (
    options.authOverrides === undefined
      ? AuthServerLive
      : makeAuthServerLayer(options.authOverrides)
  ).pipe(Layer.provide(options.authEmailSender ?? Layer.empty), Layer.provide(baseCore));
  const core = Layer.merge(baseCore, authLayer);
  const resolverLayer =
    options.principalResolver === "live"
      ? PrincipalResolverLive.pipe(Layer.provide(core))
      : (options.principalResolver ?? FakePrincipalResolver(users));
  const app = HttpRoutesLive.pipe(
    Layer.provide([
      core,
      resolverLayer,
      RateLimiterMemory,
      BunHttpServer.layerHttpServices,
      options.feedbackFetch === undefined
        ? Layer.empty
        : Layer.succeed(FetchHttpClient.Fetch, options.feedbackFetch),
    ]),
    Layer.provideMerge(options.logger ?? Layer.empty),
  );
  const web = HttpRouter.toWebHandler(app, {
    memoMap,
    disableLogger: true,
    routerConfig: { maxParamLength: 2048 },
  });
  const runtime = ManagedRuntime.make(core, { memoMap });

  const fetch = (path: string, init: RequestInit = {}) =>
    web.handler(new Request(`${ORIGIN}${path}`, init));

  const addUser = (name: string): TestUser => {
    const id = UserId.make(`01900000-0000-7000-8000-${String(users.size + 1).padStart(12, "0")}`);
    const user = { id, name, email: `${name.toLowerCase()}@example.cz` };
    users.set(id, user);
    return user;
  };

  /** Creates a Workspace owned by `user` (as its Account caller) and returns the owner caller. */
  const createWorkspace = (
    user: TestUser,
    input: Record<string, unknown> = { name: "Alfa s.r.o." },
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const ws = yield* Workspaces;
        return yield* ws.create(input as never);
      }).pipe(
        Effect.provideService(
          CurrentCaller,
          Caller.account({ userId: user.id, email: user.email, locale: "cs", channel: "web" }),
        ),
      ),
    ) as Promise<MemberCaller>;

  const dispose = async () => {
    await web.dispose();
    await runtime.dispose();
  };

  return { fetch, addUser, createWorkspace, run: runtime.runPromise, runtime, dispose };
};

export type Harness = ReturnType<typeof makeHarness>;

/** Request headers for a user's credential. */
export const as = {
  mobile: (user: TestUser): Record<string, string> => ({
    authorization: `Bearer session:${user.id}`,
  }),
  web: (user: TestUser): Record<string, string> => ({
    cookie: `${SESSION_COOKIE}=session:${user.id}`,
    origin: ORIGIN,
  }),
  apiKey: (
    user: TestUser,
    workspaceId: string,
    scopes: ReadonlyArray<string>,
  ): Record<string, string> => ({
    authorization: `Bearer kvb_key:${user.id}:${workspaceId}:${scopes.join(",")}`,
  }),
};

export const json = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});
