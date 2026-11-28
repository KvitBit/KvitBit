import { describe, expect, test } from "bun:test";
import {
  type BlobMissing,
  BlobStorage,
  BlobTooLarge,
  type BlobUnavailable,
} from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
  defectOf,
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
  readonly contentRange: string | undefined;
}

type Override = (seen: Seen) => Response | "transport-error" | undefined;

/**
 * A GCS JSON API stand-in over an in-memory bucket "b". `overrides` answer requests in order
 * before the bucket does; an override returning `undefined` passes the request through.
 */
/** Makes the next resumable chunk persist only `persist` bytes and answer `status`. */
interface ChunkFault {
  readonly persist: number;
  readonly status: number;
}

interface Session {
  readonly name: string;
  readonly parts: Array<Uint8Array>;
  persisted: number;
  done: boolean;
}

const progressRange = /^bytes \*\/(\*|\d+)$/;
const uploadRange = /^bytes (\d+)-(\d+)\/(\*|\d+)$/;
const objectPath = /^\/storage\/v1\/b\/b\/o\/([^/]+)$/;
const quarterMiB = 256 * 1024;

const fakeGcs = (overrides: Array<Override> = [], chunkFaults: Array<ChunkFault> = []) => {
  const objects = new Map<string, Uint8Array>();
  const seen: Array<Seen> = [];
  const sessions = new Map<string, Session>();
  const persistedHeader = (session: Session): Record<string, string> =>
    session.persisted > 0 ? { range: `bytes=0-${session.persisted - 1}` } : {};
  const resumable = (seenRequest: Seen): Response | undefined => {
    const { method, url } = seenRequest;
    if (url.pathname !== "/upload/storage/v1/b/b/o") return undefined;
    if (method === "POST" && url.searchParams.get("uploadType") === "resumable") {
      const id = `secret-session-${sessions.size + 1}`;
      sessions.set(id, {
        name: url.searchParams.get("name") ?? "",
        parts: [],
        persisted: 0,
        done: false,
      });
      return new Response(null, {
        status: 200,
        headers: {
          location: `https://storage.googleapis.com/upload/storage/v1/b/b/o?uploadType=resumable&upload_id=${id}`,
        },
      });
    }
    const id = url.searchParams.get("upload_id");
    const session = id === null ? undefined : sessions.get(id);
    if (id === null) return undefined;
    if (session === undefined) return new Response("no session", { status: 404 });
    if (method === "DELETE") {
      sessions.delete(id);
      return new Response(null, { status: 499 });
    }
    const range = seenRequest.contentRange ?? "";
    const query = progressRange.exec(range);
    if (query !== null) {
      return session.done
        ? Response.json({ name: session.name })
        : new Response(null, { status: 308, headers: persistedHeader(session) });
    }
    const match = uploadRange.exec(range);
    const body = seenRequest.body ?? new Uint8Array();
    if (match === null || Number(match[1]) !== session.persisted) {
      return new Response(`bad range ${range} at ${session.persisted}`, { status: 400 });
    }
    if (match[3] === "*" && body.byteLength % quarterMiB !== 0) {
      return new Response("non-final chunk not a multiple of 256 KiB", { status: 400 });
    }
    const fault = chunkFaults.shift();
    const kept = fault === undefined ? body : body.subarray(0, fault.persist);
    session.parts.push(kept.slice());
    session.persisted += kept.byteLength;
    if (fault !== undefined) return new Response("flaky", { status: fault.status });
    if (match[3] !== "*" && session.persisted === Number(match[3])) {
      session.done = true;
      objects.set(session.name, new Uint8Array(Buffer.concat(session.parts)));
      return Response.json({ name: session.name });
    }
    return new Response(null, { status: 308, headers: persistedHeader(session) });
  };
  const respond = (seenRequest: Seen): Response => {
    const { method, url } = seenRequest;
    const fromSession = resumable(seenRequest);
    if (fromSession !== undefined) return fromSession;
    if (method === "POST" && url.pathname === "/upload/storage/v1/b/b/o") {
      const name = url.searchParams.get("name") ?? "";
      objects.set(name, (seenRequest.body ?? new Uint8Array()).slice());
      return Response.json({ name, bucket: "b" });
    }
    const match = objectPath.exec(url.pathname);
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
      authorization: request.headers["authorization"],
      contentRange: request.headers["content-range"],
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
  return { objects, seen, sessions, client };
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
        invalidate: (token) =>
          Effect.sync(() => {
            invalidated.push(token);
          }),
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

describeBlobStorageContract({
  name: "GcsBlobStorage (fake JSON API)",
  layer: () => layerFor(fakeGcs()),
});

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
        const value = yield* store.get(key("ws/x.pdf"));
        const data = yield* readAll(value);
        yield* store.delete(key("ws/x.pdf"));
        return data.toString();
      }),
    );
    expect(text).toBe("data");
    expect(Arr.map(fake.seen, (s) => `${s.method} ${s.url.href}`)).toEqual([
      "GET http://emulator:4443/storage/v1/b/b/o/ws%2Fx.pdf?alt=media",
      "DELETE http://emulator:4443/storage/v1/b/b/o/ws%2Fx.pdf",
    ]);
    expect(fake.objects.size).toBe(0);
  });

  test("an oversized body fails with BlobTooLarge before any request", async () => {
    const fake = fakeGcs();
    const error = await run(
      layerFor(fake),
      withStore((store) => Effect.flip(store.put(key("ws/big"), endless, meta(1000)))),
    );
    expect(error).toBeInstanceOf(BlobTooLarge);
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

  const operations: ReadonlyArray<
    readonly [
      string,
      (
        store: BlobStorage["Service"],
      ) => Effect.Effect<void, BlobMissing | BlobUnavailable | BlobTooLarge>,
    ]
  > = [
    [
      "put",
      (store: BlobStorage["Service"]) =>
        store.put(key("ws/a"), chunked("x"), meta()).pipe(Effect.asVoid),
    ],
    ["get", (store: BlobStorage["Service"]) => store.get(key("ws/a")).pipe(Effect.asVoid)],
    ["delete", (store: BlobStorage["Service"]) => store.delete(key("ws/a"))],
  ];
  for (const [label, op] of operations) {
    test(`${label}: 5xx after retries is BlobUnavailable carrying the status`, async () => {
      const fake = fakeGcs([failing(503), failing(503), failing(500)]);
      const error = await run(
        layerFor(fake, { retries: 2 }),
        withStore((store) => Effect.flip(op(store))),
      );
      expect(error._tag).toBe("BlobUnavailable");
      expect(error).toMatchObject({ cause: { status: 500, body: "upstream 500" } });
      expect(fake.seen).toHaveLength(3);
    });

    test(`${label}: a non-transient 4xx is BlobUnavailable without retry`, async () => {
      const fake = fakeGcs([failing(403)]);
      const error = await run(
        layerFor(fake, { retries: 2 }),
        withStore((store) => Effect.flip(op(store))),
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
    expect(Arr.every(fake.seen, (s) => s.body !== undefined && s.body.byteLength === 3)).toBe(true);
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
    expect(Arr.map(fake.seen, (s) => s.authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  test("a token failure is BlobUnavailable and sends nothing", async () => {
    const fake = fakeGcs();
    const error = await run(
      layerFor(
        fake,
        {},
        GcsAccessTokens.fromEffect(
          Effect.fail(GcsAccessTokenError.make({ reason: "status" })),
          (e) => e,
        ),
      ),
      withStore((store) => Effect.flip(store.get(key("ws/a")))),
    );
    expect(error._tag).toBe("BlobUnavailable");
    expect(fake.seen).toHaveLength(0);
  });
});

describe("GcsBlobStorage resumable uploads", () => {
  /** `size` bytes of a repeating pattern, emitted in `piece`-byte chunks. */
  const pattern = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31) % 251);
  const pieces = (data: Uint8Array, piece: number) =>
    Stream.fromIterable(
      Array.from({ length: Math.ceil(data.byteLength / piece) }, (_, i) =>
        data.subarray(i * piece, (i + 1) * piece),
      ),
    );
  const opts = { chunkSize: quarterMiB, retries: 2, retryBackoff: "1 millis" } as const;

  test("a body larger than one chunk goes up in 256 KiB-aligned chunks", async () => {
    const fake = fakeGcs();
    const data = pattern(2 * quarterMiB + 1000);
    const result = await run(
      layerFor(fake, opts),
      withStore((store) =>
        store.put(key("exports/ws/e.zip"), pieces(data, 100_000), meta(10 ** 7)),
      ),
    );
    expect(result).toEqual({
      key: key("exports/ws/e.zip"),
      bytes: data.byteLength,
      sha256: sha256(data),
    });
    expect(fake.objects.get("exports/ws/e.zip")).toEqual(data);
    expect(
      Arr.map(fake.seen, (s) => s.contentRange ?? s.url.searchParams.get("uploadType")),
    ).toEqual([
      "resumable",
      `bytes 0-${quarterMiB - 1}/*`,
      `bytes ${quarterMiB}-${2 * quarterMiB - 1}/*`,
      `bytes ${2 * quarterMiB}-${data.byteLength - 1}/${data.byteLength}`,
    ]);
  });

  test("a body of exactly one chunk takes the single media upload", async () => {
    const fake = fakeGcs();
    await run(
      layerFor(fake, opts),
      withStore((store) =>
        store.put(key("ws/one"), pieces(pattern(quarterMiB), 1000), meta(10 ** 7)),
      ),
    );
    expect(Arr.map(fake.seen, (s) => s.url.searchParams.get("uploadType"))).toEqual(["media"]);
  });

  test("after a chunk fails part-persisted, it resumes from the offset GCS reports", async () => {
    const fake = fakeGcs([], [{ persist: quarterMiB, status: 503 }]);
    const data = pattern(3 * quarterMiB + 5);
    await run(
      layerFor(fake, { ...opts, chunkSize: 2 * quarterMiB }),
      withStore((store) => store.put(key("ws/flaky"), pieces(data, 65_536), meta(10 ** 7))),
    );
    expect(fake.objects.get("ws/flaky")).toEqual(data);
    expect(
      Arr.map(fake.seen, (s) => s.contentRange ?? s.url.searchParams.get("uploadType")),
    ).toEqual([
      "resumable",
      `bytes 0-${2 * quarterMiB - 1}/*`,
      "bytes */*",
      `bytes ${quarterMiB}-${2 * quarterMiB - 1}/*`,
      `bytes ${2 * quarterMiB}-${data.byteLength - 1}/${data.byteLength}`,
    ]);
  });

  test("a body over the limit mid-upload cancels the session and creates no object", async () => {
    const fake = fakeGcs();
    const error = await run(
      layerFor(fake, opts),
      withStore((store) => Effect.flip(store.put(key("ws/huge"), endless, meta(3 * quarterMiB)))),
    );
    expect(error).toBeInstanceOf(BlobTooLarge);
    expect(fake.objects.has("ws/huge")).toBe(false);
    expect(fake.sessions.size).toBe(0);
    expect(fake.seen.at(-1)?.method).toBe("DELETE");
  });

  test("a chunk that keeps failing is BlobUnavailable and cancels the session", async () => {
    const fake = fakeGcs(
      [],
      [
        { persist: 0, status: 503 },
        { persist: 0, status: 503 },
        { persist: 0, status: 503 },
      ],
    );
    const error = await run(
      layerFor(fake, opts),
      withStore((store) =>
        Effect.flip(
          store.put(key("ws/down"), pieces(pattern(2 * quarterMiB), 65_536), meta(10 ** 7)),
        ),
      ),
    );
    expect(error._tag).toBe("BlobUnavailable");
    expect(fake.sessions.size).toBe(0);
  });

  test("rejects a chunk size GCS would refuse", async () => {
    const defect = await layerFor(fakeGcs(), { chunkSize: 1000 }).pipe(
      Layer.build,
      Effect.scoped,
      Effect.asVoid,
      defectOf,
      Effect.runPromise,
    );
    expect(defect).toBeInstanceOf(RangeError);
  });
});

describe("GcsBlobStorage responses", () => {
  test("a 401 whose refresh returns the same token is BlobUnavailable without a resend", async () => {
    const fake = fakeGcs([() => new Response("expired", { status: 401 })]);
    const error = await run(
      layerFor(fake, { retries: 2 }),
      withStore((store) => Effect.flip(store.delete(key("ws/a")))),
    );
    expect(error).toMatchObject({ _tag: "BlobUnavailable", cause: { status: 401 } });
    expect(fake.seen).toHaveLength(1);
  });

  test("a 408 is retried", async () => {
    const fake = fakeGcs([() => new Response("slow", { status: 408 })]);
    await run(
      layerFor(fake, { retries: 1 }),
      withStore((store) => store.delete(key("ws/a"))),
    );
    expect(fake.seen).toHaveLength(2);
  });

  test("a 200 with no body for an empty object reads as an empty stream", async () => {
    const fake = fakeGcs([
      () => new Response(null, { status: 200, headers: { "content-length": "0" } }),
    ]);
    const data = await run(
      layerFor(fake),
      withStore((store) => Effect.flatMap(store.get(key("ws/empty")), readAll)),
    );
    expect(data.byteLength).toBe(0);
  });
});

describe("GcsBlobStorage review fixes", () => {
  const data = Uint8Array.from({ length: 2 * quarterMiB + 10 }, (_, i) => i % 256);
  const opts = { chunkSize: quarterMiB, retryBackoff: "1 millis" } as const;

  test("one transient chunk failure costs one retry", async () => {
    const fake = fakeGcs([], [{ persist: 0, status: 503 }]);
    await run(
      layerFor(fake, { ...opts, retries: 1 }),
      withStore((store) => store.put(key("ws/once"), Stream.make(data), meta(10 ** 7))),
    );
    expect(fake.objects.get("ws/once")).toEqual(data);
  });

  test("errors never carry the resumable session id", async () => {
    const fake = fakeGcs([() => undefined, () => "transport-error"]);
    const error = await run(
      layerFor(fake, { ...opts, retries: 0 }),
      withStore((store) =>
        Effect.flip(store.put(key("ws/secret"), Stream.make(data), meta(10 ** 7))),
      ),
    );
    expect(error._tag).toBe("BlobUnavailable");
    const rendered = `${String(error)} ${String(error._tag === "BlobUnavailable" ? error.cause : undefined)}`;
    expect(rendered).toContain("upload_id");
    expect(rendered).not.toContain("secret-session");
  });

  test("a download that stalls mid-body dies after the idle timeout", async () => {
    let pulls = 0;
    const finishPull = Deferred.makeUnsafe<void>();
    const stalled = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array([1, 2, 3]));
        return pulls === 1 ? undefined : finishPull.pipe(Deferred.await, Effect.runPromise);
      },
      cancel: () => {
        Effect.runSync(Deferred.succeed(finishPull, undefined));
      },
    });
    const fake = fakeGcs([() => new Response(stalled, { status: 200 })]);
    const defect = await withStore((store) =>
      Effect.flatMap(store.get(key("ws/slow")), readAll),
    ).pipe(
      Effect.provide(layerFor(fake, { idleTimeout: "30 millis" })),
      defectOf,
      Effect.runPromise,
    );
    expect(defect).toMatchObject({ _tag: "BlobUnavailable", cause: { reason: "idle timeout" } });
  });
});

describe("GcsBlobStorage error bodies", () => {
  test("a session id echoed anywhere in an error body never reaches the cause", async () => {
    const data = new Uint8Array(2 * quarterMiB + 1);
    const echo: Override = (seen) =>
      seen.url.searchParams.has("upload_id")
        ? Response.json(
            {
              error: {
                message: `bad chunk for ${seen.url.href}`,
                session: seen.url.searchParams.get("upload_id"),
              },
            },
            { status: 400 },
          )
        : undefined;
    const fake = fakeGcs([echo, echo]);
    const error = await run(
      layerFor(fake, { chunkSize: quarterMiB }),
      withStore((store) =>
        Effect.flip(store.put(key("ws/echo"), Stream.make(data), meta(10 ** 7))),
      ),
    );
    expect(error._tag).toBe("BlobUnavailable");
    const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
    const serialized = encodeJson(error).pipe(Effect.runSync);
    expect(error).toMatchObject({ cause: { operation: "session", status: 400 } });
    expect(serialized).not.toContain("secret-session");
  });
});
