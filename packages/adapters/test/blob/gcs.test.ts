import { describe, expect, test } from "bun:test";
import { BlobStorage } from "@kvitbit/domain/ports";
import { Effect, Layer, Ref } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import {
  GcsAccessToken,
  GcsAccessTokenError,
  GcsAccessTokens,
  GcsBlobStorage,
  type GcsBlobStorageOptions,
} from "../../src/blob/index";
import {
  bytesOf,
  chunked,
  describeBlobStorageContract,
  endless,
  key,
  meta,
  readAll,
  sha256,
  withStore,
} from "./contract";

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Uint8Array | undefined;
}

type Override = (seen: Seen) => Response | "transport-error" | undefined;

/**
 * A GCS JSON API stand-in over an in-memory bucket "b". `overrides` answer requests in order
 * before the bucket does; an override returning `undefined` passes the request through.
 */
const fakeGcs = (overrides: Array<Override> = []) => {
  const objects = new Map<string, Uint8Array>();
  const seen: Array<Seen> = [];
  const respond = (seenRequest: Seen): Response => {
    const { method, url } = seenRequest;
    if (method === "POST" && url.pathname === "/upload/storage/v1/b/b/o") {
      const name = url.searchParams.get("name") ?? "";
      objects.set(name, seenRequest.body ?? new Uint8Array());
      return Response.json({ name, bucket: "b" });
    }
    const match = /^\/storage\/v1\/b\/b\/o\/([^/]+)$/.exec(url.pathname);
    const name = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    if (name === undefined) return new Response("no route", { status: 400 });
    const object = objects.get(name);
    if (method === "GET" && url.searchParams.get("alt") === "media") {
      return object === undefined
        ? Response.json({ error: { code: 404 } }, { status: 404 })
        : new Response(object);
    }
    if (method === "DELETE") {
      if (object === undefined) return Response.json({ error: { code: 404 } }, { status: 404 });
      objects.delete(name);
      return new Response(null, { status: 204 });
    }
    return new Response("no route", { status: 400 });
  };
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest, url: URL) => {
    const record: Seen = {
      method: request.method,
      url,
      authorization: request.headers.authorization,
      contentType: request.body._tag === "Uint8Array" ? request.body.contentType : undefined,
      body: request.body._tag === "Uint8Array" ? request.body.body : undefined,
    };
    seen.push(record);
    const override = overrides.shift()?.(record);
    if (override === "transport-error") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("reset") }),
        }),
      );
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, override ?? respond(record)));
  });
  return { objects, seen, client };
};

const tokensFrom = (values: ReadonlyArray<string>, invalidated: Array<string>) =>
  Layer.effect(
    GcsAccessToken,
    Effect.gen(function* () {
      const index = yield* Ref.make(0);
      return GcsAccessToken.of({
        get: Ref.getAndUpdate(index, (n) => Math.min(n + 1, values.length - 1)).pipe(
          Effect.map((n) => values[n] ?? "none"),
        ),
        invalidate: (token) => Effect.sync(() => void invalidated.push(token)),
      });
    }),
  );

const layerFor = (
  fake: ReturnType<typeof fakeGcs>,
  options: Partial<GcsBlobStorageOptions> = {},
  tokens: Layer.Layer<GcsAccessToken> = GcsAccessTokens.fromEffect(Effect.succeed("tok-1")),
) =>
  GcsBlobStorage.layer({ bucket: "b", retries: 0, retryBackoff: "1 millis", ...options }).pipe(
    Layer.provide([Layer.succeed(HttpClient.HttpClient, fake.client), tokens]),
  );

const run = <A, E>(layer: Layer.Layer<BlobStorage>, effect: Effect.Effect<A, E, BlobStorage>) =>
  Effect.runPromise(Effect.provide(effect, layer));

describeBlobStorageContract("GcsBlobStorage (fake JSON API)", () => layerFor(fakeGcs()));

describe("GcsBlobStorage requests", () => {
  test("put sends one media upload with the token, content type and exact bytes", async () => {
    const fake = fakeGcs();
    const result = await run(
      layerFor(fake),
      withStore((store) => store.put(key("ws/a b/ü.pdf"), chunked("%PDF", "-1.7"), meta())),
    );
    expect(result).toEqual({
      key: key("ws/a b/ü.pdf"),
      bytes: 8,
      sha256: sha256(bytesOf("%PDF-1.7")),
    });
    expect(fake.seen).toHaveLength(1);
    const [upload] = fake.seen;
    expect(upload?.method).toBe("POST");
    expect(`${upload?.url.origin}${upload?.url.pathname}`).toBe(
      "https://storage.googleapis.com/upload/storage/v1/b/b/o",
    );
    expect(upload?.url.searchParams.get("uploadType")).toBe("media");
    expect(upload?.url.searchParams.get("name")).toBe("ws/a b/ü.pdf");
    expect(upload?.authorization).toBe("Bearer tok-1");
    expect(upload?.contentType).toBe("application/pdf");
    expect(fake.objects.get("ws/a b/ü.pdf")).toEqual(bytesOf("%PDF-1.7"));
  });

  test("get and delete address the object with its name percent-encoded, slashes included", async () => {
    const fake = fakeGcs();
    fake.objects.set("ws/x.pdf", bytesOf("data"));
    const text = await run(
      layerFor(fake, { endpoint: "http://emulator:4443/" }),
      Effect.gen(function* () {
        const store = yield* BlobStorage;
        const data = yield* readAll(yield* store.get(key("ws/x.pdf")));
        yield* store.delete(key("ws/x.pdf"));
        return data.toString();
      }),
    );
    expect(text).toBe("data");
    expect(fake.seen.map((s) => `${s.method} ${s.url.href}`)).toEqual([
      "GET http://emulator:4443/storage/v1/b/b/o/ws%2Fx.pdf?alt=media",
      "DELETE http://emulator:4443/storage/v1/b/b/o/ws%2Fx.pdf",
    ]);
    expect(fake.objects.size).toBe(0);
  });

  test("an oversized body fails with BlobTooLarge before any request", async () => {
    const fake = fakeGcs();
    const error = await run(
      layerFor(fake),
      withStore((store) => Effect.flip(store.put(key("ws/big"), endless(), meta(1000)))),
    );
    expect(error._tag).toBe("BlobTooLarge");
    expect(fake.seen).toHaveLength(0);
  });

  test("404 on get is BlobMissing and 404 on delete is success", async () => {
    const fake = fakeGcs();
    const error = await run(
      layerFor(fake),
      Effect.gen(function* () {
        const store = yield* BlobStorage;
        yield* store.delete(key("ws/none"));
        return yield* Effect.flip(store.get(key("ws/none")));
      }),
    );
    expect(error).toMatchObject({ _tag: "BlobMissing", key: "ws/none" });
  });

  const failing =
    (status: number): Override =>
    () =>
      new Response(`upstream ${status}`, { status });

  for (const [label, op] of [
    ["put", (store: BlobStorage["Service"]) => store.put(key("ws/a"), chunked("x"), meta())],
    ["get", (store: BlobStorage["Service"]) => store.get(key("ws/a"))],
    ["delete", (store: BlobStorage["Service"]) => store.delete(key("ws/a"))],
  ] as const) {
    test(`${label}: 5xx after retries is BlobUnavailable carrying the status`, async () => {
      const fake = fakeGcs([failing(503), failing(503), failing(500)]);
      const error = await run(
        layerFor(fake, { retries: 2 }),
        withStore((store) =>
          Effect.flip(op(store) as Effect.Effect<unknown, { readonly _tag: string }>),
        ),
      );
      expect(error._tag).toBe("BlobUnavailable");
      expect(error).toMatchObject({ cause: { status: 500, body: "upstream 500" } });
      expect(fake.seen).toHaveLength(3);
    });

    test(`${label}: a non-transient 4xx is BlobUnavailable without retry`, async () => {
      const fake = fakeGcs([failing(403)]);
      const error = await run(
        layerFor(fake, { retries: 2 }),
        withStore((store) =>
          Effect.flip(op(store) as Effect.Effect<unknown, { readonly _tag: string }>),
        ),
      );
      expect(error).toMatchObject({ _tag: "BlobUnavailable", cause: { status: 403 } });
      expect(fake.seen).toHaveLength(1);
    });
  }

  test("a 503 or a lost connection is retried and then succeeds", async () => {
    const fake = fakeGcs([failing(503), () => "transport-error"]);
    const result = await run(
      layerFor(fake, { retries: 2 }),
      withStore((store) => store.put(key("ws/r"), chunked("abc"), meta())),
    );
    expect(result.bytes).toBe(3);
    expect(fake.seen).toHaveLength(3);
    expect(fake.seen.every((s) => s.body !== undefined && s.body.byteLength === 3)).toBe(true);
    expect(fake.objects.get("ws/r")).toEqual(bytesOf("abc"));
  });

  test("a 401 invalidates the token and retries with a fresh one", async () => {
    const fake = fakeGcs([failing(401)]);
    const invalidated: Array<string> = [];
    await run(
      layerFor(fake, { retries: 1 }, tokensFrom(["stale", "fresh"], invalidated)),
      withStore((store) => store.delete(key("ws/a"))),
    );
    expect(invalidated).toEqual(["stale"]);
    expect(fake.seen.map((s) => s.authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  test("a token failure is BlobUnavailable and sends nothing", async () => {
    const fake = fakeGcs();
    const error = await run(
      layerFor(
        fake,
        {},
        GcsAccessTokens.fromEffect(
          Effect.fail(new GcsAccessTokenError({ reason: "status" })),
          (e) => e,
        ),
      ),
      withStore((store) => Effect.flip(store.get(key("ws/a")))),
    );
    expect(error._tag).toBe("BlobUnavailable");
    expect(fake.seen).toHaveLength(0);
  });
});
