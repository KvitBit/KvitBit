import { describe, expect, test } from "bun:test";
import { ContactId, WorkspaceId } from "@kvitbit/domain/contract";
import { Effect, Exit, Fiber, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import {
  layer as apiLayer,
  attempt,
  bearer,
  call,
  describeError,
  fromExit,
  idempotencyHeaders,
  ifMatchHeaders,
  inWorkspace,
  KvitbitApi,
  type KvitbitApiConfig,
  keyAfter,
  layerFetch,
  pageQuery,
  sessionCookie,
} from "../../src/api";
import { hangingFetch, json, mockFetch } from "./mock-fetch";

const ws = Schema.decodeUnknownSync(WorkspaceId)("01932f5e-7b6a-7c3d-8e9f-0a1b2c3d4e5f");
const contactId = Schema.decodeUnknownSync(ContactId)("01932f5e-7b6a-7c3d-8e9f-0a1b2c3d4e60");
const contact = { id: "c1", name: "Acme s.r.o.", defaults: {}, revision: 3 };
const base = "https://app.kvitbit.test";

const cookieConfig: KvitbitApiConfig = {
  baseUrl: base,
  credentials: sessionCookie,
  acceptLanguage: () => "cs",
};
const bearerConfig: KvitbitApiConfig = {
  baseUrl: base,
  credentials: bearer("kvb_key1_secret"),
  acceptLanguage: () => "en",
};

const run = <A, E>(
  effect: Effect.Effect<A, E, KvitbitApi>,
  fetch: typeof globalThis.fetch,
  config: KvitbitApiConfig = cookieConfig,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layerFetch(config)),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );

const search = Effect.gen(function* () {
  const api = yield* KvitbitApi;
  return yield* api.contacts.search({
    params: inWorkspace(ws),
    query: pageQuery({ text: "acme", role: "customer" as const }, "cur-1"),
  });
});

const create = (key: string) =>
  Effect.gen(function* () {
    const api = yield* KvitbitApi;
    return yield* api.contacts.create({
      params: inWorkspace(ws),
      headers: idempotencyHeaders(key),
      payload: { name: "Acme s.r.o." },
    });
  });

/** One request against a scripted status/body, mapped through the one error mapping. */
const failWith = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const mock = mockFetch(() => json(status, body, headers));
  const result = await run(attempt(create("key-00000001")), mock.fetch);
  if (result._tag !== "Err") throw new Error("expected Err");
  return result.error;
};

describe("KvitbitApi round trips over a mock transport", () => {
  test("GET list: workspace path binding, paging and filters, cookie mode", async () => {
    const mock = mockFetch(() => json(200, { items: [contact], nextCursor: "cur-2" }));
    const page = await run(search, mock.fetch);

    expect(page.nextCursor).toBe("cur-2");
    expect(page.items[0]?.name).toBe("Acme s.r.o.");
    const [req] = mock.calls;
    expect(req?.method).toBe("GET");
    expect(req?.url.pathname).toBe(`/api/v1/workspaces/${ws}/contacts`);
    expect(Object.fromEntries(req?.url.searchParams ?? [])).toEqual({
      text: "acme",
      role: "customer",
      cursor: "cur-1",
      limit: "50",
    });
    expect(req?.credentials).toBe("include");
    expect(req?.headers.get("authorization")).toBeNull();
    expect(req?.headers.get("accept-language")).toBe("cs");
  });

  test("POST with Idempotency-Key in bearer mode", async () => {
    const mock = mockFetch(() => json(201, contact));
    const view = await run(
      create("0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000"),
      mock.fetch,
      bearerConfig,
    );

    expect(view.revision).toBe(3);
    const [req] = mock.calls;
    expect(req?.method).toBe("POST");
    expect(req?.headers.get("idempotency-key")).toBe("0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000");
    expect(req?.headers.get("authorization")).toBe("Bearer kvb_key1_secret");
    expect(req?.credentials).toBe("omit"); // no same-origin session cookie beside the bearer
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ name: "Acme s.r.o." });
  });

  test("ApiResult meta carries ETag revision and Idempotent-Replayed", async () => {
    const replay = mockFetch(() =>
      json(201, contact, { etag: '"3"', "idempotent-replayed": "true" }),
    );
    const result = await run(attempt(create("key-00000001")), replay.fetch);
    expect(result._tag === "Ok" && result.meta).toEqual({ etag: 3, replayed: true });
    const fresh = await run(
      attempt(create("key-00000002")),
      mockFetch(() => json(201, contact)).fetch,
    );
    expect(fresh._tag === "Ok" && fresh.meta).toEqual({ etag: null, replayed: false });
  });

  test("PUT sends If-Match with the strong entity tag", async () => {
    const mock = mockFetch(() => json(412, { _tag: "PreconditionFailed", currentRevision: 4 }));
    const result = await run(
      attempt(
        Effect.gen(function* () {
          const api = yield* KvitbitApi;
          return yield* api.contacts.update({
            params: inWorkspace(ws, { contactId }),
            headers: ifMatchHeaders(3),
            payload: { name: "Acme" },
          });
        }),
      ),
      mock.fetch,
    );
    expect(mock.calls[0]?.url.pathname).toBe(`/api/v1/workspaces/${ws}/contacts/${contactId}`);
    expect(mock.calls[0]?.headers.get("if-match")).toBe('"3"');
    if (result._tag !== "Err") throw new Error("expected Err");
    expect(result.error._tag).toBe("PreconditionFailed");
    expect(describeError(result.error).staleRevision).toBe(true);
  });
});

describe("typed error decoding into UiError", () => {
  test("422 Invalid -> field issues with issue.<code> text", async () => {
    const error = await failWith(422, {
      _tag: "Invalid",
      issues: [{ path: ["ico"], code: "ico.checksum" }],
    });
    expect(error._tag).toBe("Invalid");
    const view = describeError(error);
    expect(view.surface).toBe("fields");
    expect(view.text).toEqual({ key: "error.invalid" });
    expect(view.issues).toEqual([{ path: ["ico"], text: { key: "issue.ico.checksum" } }]);
    expect(view.retryable).toBe(false);
  });

  test("401 Unauthorized -> session surface with error.unauthorized.<reason>", async () => {
    const view = describeError(await failWith(401, { _tag: "Unauthorized", reason: "expired" }));
    expect(view.surface).toBe("session");
    expect(view.text.key).toBe("error.unauthorized.expired");
  });

  test("409 Conflict{duplicate} with detail -> inline issue text", async () => {
    const view = describeError(
      await failWith(409, {
        _tag: "Conflict",
        reason: "duplicate",
        detail: "workspace.slug_taken",
      }),
    );
    expect(view.surface).toBe("inline");
    expect(view.text.key).toBe("issue.workspace.slug_taken");
  });

  test("409 Conflict{idempotency_mismatch} clears the request key", async () => {
    const error = await failWith(409, { _tag: "Conflict", reason: "idempotency_mismatch" });
    expect(describeError(error).text.key).toBe("error.unknown");
    expect(keyAfter(Option.some("key-00000001"), { _tag: "Err", error })).toEqual(Option.none());
  });

  test("429 RateLimited -> retryable after Retry-After, fresh bot proof", async () => {
    const error = await failWith(
      429,
      { _tag: "RateLimited", retryAfterSeconds: 30 },
      {
        "retry-after": "30",
      },
    );
    const view = describeError(error);
    expect(error._tag).toBe("RateLimited");
    expect(view.text).toEqual({ key: "error.rateLimited", params: { seconds: 30 } });
    expect(view.retryable).toBe(true);
    expect(view.retryAfterSeconds).toBe(30);
    expect(view.freshBotProof).toBe(true);
  });

  test("500 -> Unexpected with status and X-Request-Id, retryable", async () => {
    const error = await failWith(
      500,
      { _tag: "InternalError", requestId: "req-1" },
      { "x-request-id": "req-1" },
    );
    expect(error).toEqual({ _tag: "Unexpected", status: 500, requestId: "req-1" });
    const view = describeError(error);
    expect(view.text).toEqual({ key: "error.unknownWithId", params: { requestId: "req-1" } });
    expect(view.retryable).toBe(true);
  });

  test("2xx body that does not decode -> Unexpected keeping status and X-Request-Id", async () => {
    const error = await failWith(201, { nope: true }, { "x-request-id": "req-2" });
    expect(error).toEqual({ _tag: "Unexpected", status: 201, requestId: "req-2" });
  });

  test("transport failure -> Offline", async () => {
    const mock = mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const result = await run(attempt(search), mock.fetch);
    expect(result).toEqual({ _tag: "Err", error: { _tag: "Offline" } });
  });

  test("timeout -> Timeout", async () => {
    const result = await run(attempt(search, { timeout: "20 millis" }), hangingFetch());
    expect(result).toEqual({ _tag: "Err", error: { _tag: "Timeout" } });
  });

  test("interruption -> Cancelled", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(attempt(search));
        yield* Effect.sleep("10 millis");
        return yield* Fiber.interrupt(fiber).pipe(Effect.as(fiber), Effect.flatMap(Fiber.await));
      }),
      hangingFetch(),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fromExit(exit)).toEqual(Option.some({ _tag: "Cancelled" }));
    const inner = await Effect.runPromise(attempt(Effect.interrupt));
    expect(inner).toEqual({ _tag: "Err", error: { _tag: "Cancelled" } });
  });
});

describe("client configuration", () => {
  test("Accept-Language follows a locale switch between requests", async () => {
    let locale = "cs";
    const mock = mockFetch(() => json(200, { items: [], nextCursor: null }));
    const config: KvitbitApiConfig = { ...cookieConfig, acceptLanguage: () => locale };
    await run(search, mock.fetch, config);
    locale = "en";
    await run(search, mock.fetch, config);
    expect(mock.calls.map((c) => c.headers.get("accept-language"))).toEqual(["cs", "en"]);
  });

  test("cookie mode keeps the adapter's RequestInit options", async () => {
    const mock = mockFetch(() => json(200, { items: [], nextCursor: null }));
    await run(
      search.pipe(Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" })),
      mock.fetch,
    );
    expect(mock.calls[0]?.credentials).toBe("include");
    expect(mock.calls[0]?.cache).toBe("no-store");
  });

  test("an injected HttpClient carries the request (no fetch)", async () => {
    const seen: Array<string> = [];
    const client = HttpClient.make((request) => {
      seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
      seen.push(JSON.stringify(request.urlParams));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ items: [], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });
    const page = await Effect.runPromise(
      search.pipe(
        Effect.provide(apiLayer(bearerConfig)),
        Effect.provideService(HttpClient.HttpClient, client),
      ),
    );
    expect(page.items).toEqual([]);
    expect(seen[1]).toContain("cur-1");
    expect(seen.slice(0, 1)).toEqual([
      `GET ${base}/api/v1/workspaces/${ws}/contacts Bearer kvb_key1_secret`,
    ]);
  });

  test("call() ends in a Message, with a precomputed one for runner interruption (T2)", async () => {
    const mock = mockFetch(() => json(200, { items: [], nextCursor: null }));
    const command = call(
      "contacts.search",
      (api) => api.contacts.search({ params: inWorkspace(ws), query: pageQuery({}) }),
      (result) => ({ _tag: "GotContacts" as const, result }),
      { key: "contacts" },
    );
    expect(command.key).toBe("contacts");
    expect(command.cancelled).toEqual({
      _tag: "GotContacts",
      result: { _tag: "Err", error: { _tag: "Cancelled" } },
    });
    const msg = await run(command.effect, mock.fetch);
    expect(msg.result._tag).toBe("Ok");
    const unkeyed = call(
      "x",
      () => Effect.succeed(1),
      (r) => r,
    );
    expect("key" in unkeyed).toBe(false);
  });
});
