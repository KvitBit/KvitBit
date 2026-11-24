/** BlobStorage behaviour every adapter must share, run against each adapter's test layer. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type BlobKey, BlobStorage } from "@kvitbit/domain/ports";
import { Effect, type Layer, Stream } from "effect";
import { InvalidBlobKey } from "../../src/blob/index";

export const key = (value: string) => value as BlobKey;
export const bytesOf = (text: string) => new TextEncoder().encode(text);
export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const meta = (maxBytes = 1024) => ({ contentType: "application/pdf", maxBytes });

export const readAll = (stream: Stream.Stream<Uint8Array>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

/** Chunks of `body` one at a time, so limits are crossed mid-stream. */
export const chunked = (...parts: ReadonlyArray<string>) => Stream.fromIterable(parts.map(bytesOf));

/** An endless stream: `put` only returns if it stops reading at the limit. */
export const endless = () =>
  Stream.fromIterable(
    (function* () {
      for (;;) yield new Uint8Array(4).fill(7);
    })(),
  );

/** Runs `f` with the provided BlobStorage. */
export const withStore = <A, E>(f: (store: BlobStorage["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* f(yield* BlobStorage);
  });

export const defectOf = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flatMap(() => Effect.die("expected a defect")),
    Effect.catchDefect((defect) => Effect.succeed(defect)),
  );

export const describeBlobStorageContract = (
  name: string,
  layer: () => Layer.Layer<BlobStorage, unknown>,
) => {
  const run = <A, E>(effect: Effect.Effect<A, E, BlobStorage>) =>
    Effect.runPromise(Effect.provide(effect, layer()));

  describe(`${name} (BlobStorage contract)`, () => {
    test("round-trips a multi-chunk body and reports bytes and sha256", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const k = key("ws-1/attachments/a.pdf");
          const result = yield* store.put(k, chunked("hello ", "blob ", "world"), meta());
          const whole = bytesOf("hello blob world");
          expect(result).toEqual({ key: k, bytes: whole.byteLength, sha256: sha256(whole) });
          const read = yield* readAll(yield* store.get(k));
          expect(new Uint8Array(read)).toEqual(whole);
        }),
      ));

    test("stores an empty body", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const result = yield* store.put(key("ws-1/empty"), Stream.empty, meta());
          expect(result.bytes).toBe(0);
          expect(result.sha256).toBe(sha256(new Uint8Array()));
          expect((yield* readAll(yield* store.get(key("ws-1/empty")))).byteLength).toBe(0);
        }),
      ));

    test("accepts a body of exactly maxBytes", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const result = yield* store.put(key("ws-1/exact"), chunked("abcd", "efgh"), meta(8));
          expect(result.bytes).toBe(8);
        }),
      ));

    test("fails with BlobTooLarge one byte over the limit and keeps no object", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const error = yield* Effect.flip(
            store.put(key("ws-1/big"), chunked("abcd", "efgh", "i"), meta(8)),
          );
          expect(error._tag).toBe("BlobTooLarge");
          expect(error).toMatchObject({ maxBytes: 8 });
          const missing = yield* Effect.flip(store.get(key("ws-1/big")));
          expect(missing._tag).toBe("BlobMissing");
        }),
      ));

    test("stops reading an endless body at the limit", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const error = yield* Effect.flip(store.put(key("ws-1/endless"), endless(), meta(64)));
          expect(error._tag).toBe("BlobTooLarge");
        }),
      ));

    test("a failed overwrite keeps the previous object", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const k = key("ws-1/keep");
          yield* store.put(k, chunked("old"), meta(8));
          yield* Effect.flip(store.put(k, chunked("much too long"), meta(8)));
          expect((yield* readAll(yield* store.get(k))).toString()).toBe("old");
        }),
      ));

    test("an overwrite replaces the object", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const k = key("ws-1/replace");
          yield* store.put(k, chunked("first"), meta());
          yield* store.put(k, chunked("second"), meta());
          expect((yield* readAll(yield* store.get(k))).toString()).toBe("second");
        }),
      ));

    test("stores the emitted bytes even when the producer reuses its Buffer", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const reused = Buffer.from("abcd");
          const body = Stream.concat(
            Stream.make(reused),
            Stream.suspend(() => {
              reused.fill(0x7a);
              return Stream.make(reused);
            }),
          );
          const result = yield* store.put(key("ws-1/reused"), body, meta());
          const read = yield* readAll(yield* store.get(key("ws-1/reused")));
          expect(read.toString()).toBe("abcdzzzz");
          expect(result.sha256).toBe(sha256(read));
        }),
      ));

    test("accepts segments that merely start with dots", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const k = key("ws-1/..hidden/...x");
          yield* store.put(k, chunked("dots"), meta());
          expect((yield* readAll(yield* store.get(k))).toString()).toBe("dots");
        }),
      ));

    test("a key whose former descendants were all deleted can be stored", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          yield* store.put(key("ws-1/p/q/r"), chunked("deep"), meta());
          yield* store.put(key("ws-1/p/s"), chunked("near"), meta());
          yield* store.delete(key("ws-1/p/q/r"));
          yield* store.delete(key("ws-1/p/s"));
          yield* store.put(key("ws-1/p"), chunked("now a file"), meta());
          expect((yield* readAll(yield* store.get(key("ws-1/p")))).toString()).toBe("now a file");
        }),
      ));

    test("get of an unknown key fails with BlobMissing", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const error = yield* Effect.flip(store.get(key("ws-1/nope")));
          expect(error).toMatchObject({ _tag: "BlobMissing", key: "ws-1/nope" });
        }),
      ));

    test("delete removes the object and is idempotent", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const k = key("ws-1/gone");
          yield* store.put(k, chunked("x"), meta());
          yield* store.delete(k);
          yield* store.delete(k);
          yield* store.delete(key("ws-1/never-existed"));
          expect((yield* Effect.flip(store.get(k)))._tag).toBe("BlobMissing");
        }),
      ));

    const badKeys = [
      "",
      "/etc/passwd",
      "../escape",
      "ws-1/../../escape",
      "ws-1/./a",
      "ws-1//a",
      "ws-1/a/",
      "ws-1\\a",
      "ws-1/a\u0000b",
      ".partial/x",
      "x".repeat(1025),
      "\u017e".repeat(513),
    ];
    for (const bad of badKeys) {
      test(`rejects key ${JSON.stringify(bad.slice(0, 20))} as a defect on every operation`, () =>
        run(
          Effect.gen(function* () {
            const store = yield* BlobStorage;
            const k = key(bad);
            for (const op of [
              store.put(k, chunked("x"), meta()),
              store.get(k),
              store.delete(k),
            ] as ReadonlyArray<Effect.Effect<unknown, unknown>>) {
              const defect = yield* defectOf(op);
              expect(defect).toBeInstanceOf(InvalidBlobKey);
            }
          }),
        ));
    }
  });
};
