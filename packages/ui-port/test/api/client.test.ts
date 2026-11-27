import { describe, expect, test } from "bun:test";
import { ContactId, WorkspaceId } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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
  runCommand,
  sessionCookie,
  toUiError,
} from "../../src/api";
import { stringifyJson } from "../../src/json";
import { hangingFetch, json, mockFetch } from "./mock-fetch";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const parseJson = (source: string): unknown => Effect.runSync(decodeJson(source));

const ws = WorkspaceId.make("01932f5e-7b6a-7c3d-8e9f-0a1b2c3d4e5f");
const contactId = ContactId.make("01932f5e-7b6a-7c3d-8e9f-0a1b2c3d4e60");
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
    expect(Rec.fromEntries(req?.url.searchParams ?? [])).toEqual({
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
    expect(parseJson(req?.body ?? "{}")).toEqual({ name: "Acme s.r.o." });
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
        const fiber = yield* search.pipe(attempt(), Effect.forkChild);
        yield* Effect.sleep("10 millis");
        return yield* Fiber.interrupt(fiber).pipe(Effect.as(fiber), Effect.flatMap(Fiber.await));
      }),
      hangingFetch(),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    exit.pipe(fromExit, expect).toEqual(Option.some({ _tag: "Cancelled" }));
    const inner = await Effect.interrupt.pipe(attempt(), Effect.runPromise);
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
    expect(Arr.map(mock.calls, (c) => c.headers.get("accept-language"))).toEqual(["cs", "en"]);
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
      seen.push(stringifyJson(request.urlParams));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(stringifyJson({ items: [], nextCursor: null }), {
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

describe("review round 1 regressions", () => {
  test("a pre-send failure after a successful GET carries no status or request id", async () => {
    const mock = mockFetch(() =>
      json(200, { items: [], nextCursor: null }, { "x-request-id": "first" }),
    );
    // "x" is no UUID: the Idempotency-Key header fails to encode before anything is sent
    const result = await run(attempt(Effect.andThen(search, create("x"))), mock.fetch);
    expect(mock.calls).toHaveLength(1);
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "Unexpected", status: null, requestId: null },
    });
  });

  test("a body that fails to decode after a good exchange keeps its own status and request id", async () => {
    let n = 0;
    const mock = mockFetch(() =>
      n++ === 0
        ? json(200, { items: [], nextCursor: null }, { "x-request-id": "first" })
        : json(200, { nope: true }, { "x-request-id": "second" }),
    );
    const result = await run(attempt(Effect.andThen(search, search)), mock.fetch);
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "Unexpected", status: 200, requestId: "second" },
    });
  });

  const probe = () =>
    call(
      "probe",
      () => Effect.never,
      (result) => ({ _tag: "Probe" as const, result }),
    );
  const cancelledMsg = { _tag: "Probe", result: { _tag: "Err", error: { _tag: "Cancelled" } } };

  test("runCommand: interrupting a running command delivers exactly one cancelled Message", async () => {
    const delivered: Array<unknown> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* runCommand(probe(), (msg) => delivered.push(msg));
          yield* Effect.sleep("10 millis");
          yield* Fiber.interrupt(fiber);
          yield* Effect.sleep("5 millis");
        }),
      ),
      hangingFetch(),
    );
    await Bun.sleep(5);
    expect(delivered).toEqual([cancelledMsg]);
  });

  test("runCommand: interrupted before it starts, or by closing the scope, still one Message", async () => {
    const early: Array<unknown> = [];
    const closed: Array<unknown> = [];
    await run(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.flatMap(
            runCommand(probe(), (msg) => early.push(msg)),
            Fiber.interrupt,
          ),
        );
        yield* Effect.scoped(
          Effect.andThen(
            runCommand(probe(), (msg) => closed.push(msg)),
            Effect.sleep("5 millis"),
          ),
        );
      }),
      hangingFetch(),
    );
    await Bun.sleep(5);
    expect(early).toEqual([cancelledMsg]);
    expect(closed).toEqual([cancelledMsg]);
  });

  test("runCommand: success and failure results arrive once, as the command's own Message", async () => {
    const delivered: Array<unknown> = [];
    const mock = mockFetch(() => json(200, { items: [], nextCursor: null }));
    const command = call(
      "contacts.search",
      (api) => api.contacts.search({ params: inWorkspace(ws), query: pageQuery({}) }),
      (result) => result._tag,
    );
    const failing = call(
      "boom",
      () => Effect.fail("nope"),
      (result) => (result._tag === "Err" ? result.error._tag : "Ok"),
    );
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const success = yield* runCommand(command, (msg) => delivered.push(msg));
          yield* Fiber.await(success);
          const failure = yield* runCommand(failing, (msg) => delivered.push(msg));
          yield* Fiber.await(failure);
          yield* Effect.sleep("5 millis");
        }),
      ),
      mock.fetch,
    );
    expect(delivered).toEqual(["Ok", "Unexpected"]);
  });

  test("a Better Auth Invalid is a typed UiError; malformed shapes are not", () => {
    const error = toUiError({
      _tag: "Invalid",
      issues: [{ path: ["email"], code: "auth.bot_proof_required", params: { n: "1" } }],
    });
    expect(error._tag).toBe("Invalid");
    if (error._tag !== "Invalid") return;
    // compiles: the auth variant is part of UiError's type
    expect(
      Arr.some(
        error.issues,
        ({ code }: { readonly code: string }) => code === "auth.bot_proof_required",
      ),
    ).toBe(true);
    expect(describeError(error).freshBotProof).toBe(true);
    for (const bad of [
      { _tag: "Invalid", issues: [{ path: [{}], code: "auth.x" }] },
      { _tag: "Invalid", issues: [{ path: [], code: "not.a_code" }] },
      { _tag: "Invalid", issues: [{ path: [], code: "auth.x", params: { n: 1 } }] },
      { _tag: "Invalid", issues: [] },
    ]) {
      expect(toUiError(bad)._tag).toBe("Unexpected");
    }
  });
});

describe("review round 2 regressions", () => {
  test("a pre-send failure after a handled 401 carries no status or request id", async () => {
    const mock = mockFetch(() =>
      json(401, { _tag: "Unauthorized", reason: "expired" }, { "x-request-id": "first" }),
    );
    // the 401 is handled; "x" is no UUID, so the second request fails before anything is sent
    const result = await run(
      search.pipe(Effect.ignore, Effect.andThen(create("x")), attempt()),
      mock.fetch,
    );
    expect(mock.calls).toHaveLength(1);
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "Unexpected", status: null, requestId: null },
    });
  });

  test("runCommand: a runner interrupted between fork and observer still delivers the Message", async () => {
    // The command interrupts its runner as it runs; with a small op budget the interrupt lands
    // right after the fork. Every budget must still dispatch the command's own Message.
    const client = await run(KvitbitApi, hangingFetch());
    for (let budget = 2; budget <= 16; budget++) {
      const delivered: Array<unknown> = [];
      let onDelivered: () => void = () => undefined;
      // The observer callback releases the platform Promise after its first delivery.
      // @effect-diagnostics-next-line newPromise:off
      const firstDelivery = new Promise<"delivered">((resolve) => {
        onDelivered = () => resolve("delivered");
      });
      const scope = Scope.makeUnsafe();
      Effect.runFork(
        Effect.withFiber((runner) =>
          runCommand(
            {
              name: "self-interrupt",
              effect: Effect.sync(() => {
                runner.interruptUnsafe();
                return "done";
              }),
              cancelled: "cancelled",
              failed: () => "defect",
            },
            (msg) => {
              delivered.push(msg);
              onDelivered();
            },
          ),
        ).pipe(
          // the command never calls the API
          Effect.provideService(KvitbitApi, client),
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
        ),
      );
      // Close the scope only once the command ran and dispatched, so cleanup cannot cancel it
      // first; a delivery that never comes fails at the deadline instead of hanging.
      // biome-ignore lint/performance/noAwaitInLoops: Each op budget finishes its interruption and scope cleanup before the next one.
      const outcome = await Promise.race([
        firstDelivery,
        Bun.sleep(2_000).then(() => "missing" as const),
      ]);
      await Effect.runPromise(Scope.close(scope, Exit.void));
      // a duplicate dispatch would land after cleanup; give it a turn of the event loop
      await Bun.sleep(0);
      expect({ budget, outcome, delivered }).toEqual({
        budget,
        outcome: "delivered",
        delivered: ["done"],
      });
    }
  });
});

describe("review round 3 regressions", () => {
  /** A 200 whose malformed body only finishes reading once `release` is called. */
  const gatedMalformed = (requestId: string) => {
    let started!: () => void;
    let release!: () => void;
    // The Response method signals when body decoding starts and awaits a separate release.
    // @effect-diagnostics-next-line newPromise:off
    const decodingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    // @effect-diagnostics-next-line newPromise:off
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = () => {
      const r = json(200, { nope: true }, { "x-request-id": requestId });
      return Object.defineProperty(r, "arrayBuffer", {
        value: async () => {
          started();
          await gate;
          return new TextEncoder().encode('{"nope":true}').buffer;
        },
      });
    };
    return { response, decodingStarted, release };
  };
  const unauthorized = (requestId: string) =>
    json(401, { _tag: "Unauthorized", reason: "expired" }, { "x-request-id": requestId });

  test("a decode failure keeps its own status and request id when a sibling call handles a 401 meanwhile", async () => {
    const malformed = gatedMalformed("broken");
    let n = 0;
    const mock = mockFetch(() => (n++ === 0 ? malformed.response() : unauthorized("handled")));
    const sibling = Effect.gen(function* () {
      yield* Effect.promise(() => malformed.decodingStarted);
      yield* Effect.ignore(search);
      malformed.release();
    });
    const result = await run(
      attempt(Effect.all([search, sibling], { concurrency: "unbounded" })),
      mock.fetch,
    );
    expect(mock.calls).toHaveLength(2);
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "Unexpected", status: 200, requestId: "broken" },
    });
  });

  test("a sibling's 401 that fails first is reported as Unauthorized, not borrowed by the decode", async () => {
    const malformed = gatedMalformed("broken");
    let n = 0;
    const mock = mockFetch(() => (n++ === 0 ? malformed.response() : unauthorized("handled")));
    const result = await run(
      attempt(
        Effect.all(
          [
            search,
            Effect.andThen(
              Effect.promise(() => malformed.decodingStarted),
              Effect.ensuring(
                search,
                Effect.sync(() => malformed.release()),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      ),
      mock.fetch,
    );
    expect(mock.calls).toHaveLength(2);
    expect(result._tag === "Err" && result.error._tag).toBe("Unauthorized");
  });

  test("when the decode failure surfaces before a sibling's 500, it keeps its own status and request id", async () => {
    const malformed = gatedMalformed("broken");
    let n = 0;
    const mock = mockFetch(() =>
      n++ === 0
        ? malformed.response()
        : json(500, { _tag: "InternalError", requestId: "down" }, { "x-request-id": "down" }),
    );
    const sibling = Effect.gen(function* () {
      yield* Effect.promise(() => malformed.decodingStarted);
      const exit = yield* Effect.exit(search);
      malformed.release();
      yield* Effect.sleep("20 millis");
      return yield* exit;
    });
    const result = await run(
      attempt(Effect.all([search, sibling], { concurrency: "unbounded" })),
      mock.fetch,
    );
    expect(mock.calls).toHaveLength(2);
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "Unexpected", status: 200, requestId: "broken" },
    });
  });

  test("when sibling calls both fail, the reported status and request id belong together", async () => {
    const malformed = gatedMalformed("broken");
    let n = 0;
    const mock = mockFetch(() =>
      n++ === 0
        ? malformed.response()
        : json(500, { _tag: "InternalError", requestId: "down" }, { "x-request-id": "down" }),
    );
    const sibling = Effect.gen(function* () {
      yield* Effect.promise(() => malformed.decodingStarted);
      yield* Effect.ensuring(
        search,
        Effect.sync(() => malformed.release()),
      );
    });
    const result = await run(
      attempt(Effect.all([search, sibling], { concurrency: "unbounded" })),
      mock.fetch,
    );
    expect(mock.calls).toHaveLength(2);
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "Unexpected", status: 500, requestId: "down" },
    });
  });
});

describe("review round 4 regressions", () => {
  test("a body that fails to decode stays a SchemaError that typed recovery can catch", async () => {
    const recovered = search.pipe(Effect.catchTag("SchemaError", () => Effect.succeed("caught")));
    const result = await run(
      attempt(recovered),
      mockFetch(() => json(200, { nope: true }, { "x-request-id": "broken" })).fetch,
    );
    expect(result).toEqual({ _tag: "Ok", value: "caught", meta: { etag: null, replayed: false } });
  });

  test("an uncaught decode failure still maps to Unexpected with its exchange", async () => {
    const failure = await search.pipe(
      Effect.flip,
      Effect.provide(layerFetch(cookieConfig)),
      Effect.provideService(
        FetchHttpClient.Fetch,
        mockFetch(() => json(200, { nope: true }, { "x-request-id": "broken" })).fetch,
      ),
      Effect.runPromise,
    );
    expect(
      typeof failure === "object" && failure !== null && "_tag" in failure
        ? failure._tag
        : undefined,
    ).toBe("SchemaError");
    failure
      .pipe(toUiError, expect)
      .toEqual({ _tag: "Unexpected", status: 200, requestId: "broken" });
  });

  test("response-only mode keeps the success response's ETag and Idempotent-Replayed", async () => {
    const raw = Effect.gen(function* () {
      const api = yield* KvitbitApi;
      return yield* api.contacts.search({
        params: inWorkspace(ws),
        query: pageQuery({}),
        responseMode: "response-only",
      });
    });
    const result = await run(
      attempt(raw),
      mockFetch(() => json(200, {}, { etag: '"7"', "idempotent-replayed": "true" })).fetch,
    );
    expect(result._tag === "Ok" && result.meta).toEqual({ etag: 7, replayed: true });
  });
});
