/** BlobStorage behaviour every adapter must share, run against each adapter's test layer. */

import { describe, expect, test } from "bun:test";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto"; // Independent SHA-256 implementation for the expected bytes.
import { BlobKey, BlobStorage, BlobTooLarge, type BlobUnavailable } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { InvalidBlobKey } from "../../src/blob/index";

export const key = (value: string) => BlobKey.make(value);
export const bytesOf = (text: string) => new TextEncoder().encode(text);
export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const meta = (maxBytes = 1024) => ({ contentType: "application/pdf", maxBytes });

export const readAll = (stream: Stream.Stream<Uint8Array>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

/** Chunks of `body` one at a time, so limits are crossed mid-stream. */
export const chunked = (...parts: ReadonlyArray<string>) =>
  Stream.fromIterable(Arr.map(parts, bytesOf));

/** An endless stream: `put` only returns if it stops reading at the limit. */
export const endless = Stream.fromEffectRepeat(Effect.sync(() => new Uint8Array(4).fill(7)));

/** Runs `f` with the provided BlobStorage. */
export const withStore = <A, E>(f: (store: BlobStorage["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const BlobStorage_1 = yield* BlobStorage;
    return yield* f(BlobStorage_1);
  });

export const defectOf = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flatMap(() => Effect.die("expected a defect")),
    Effect.catchDefect((defect) => Effect.succeed(defect)),
  );

export const describeBlobStorageContract = ({
  name,
  layer,
}: {
  readonly name: string;
  readonly layer: () => Layer.Layer<BlobStorage, BlobUnavailable>;
}) => {
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
          const value_1 = yield* store.get(k);
          const read = yield* readAll(value_1);
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
          const value_2 = yield* store.get(key("ws-1/empty"));
          expect((yield* readAll(value_2)).byteLength).toBe(0);
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
          expect(error).toBeInstanceOf(BlobTooLarge);
          expect(error).toMatchObject({ maxBytes: 8 });
          const missing = yield* Effect.flip(store.get(key("ws-1/big")));
          expect(missing._tag).toBe("BlobMissing");
        }),
      ));

    test("stops reading an endless body at the limit", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const error = yield* Effect.flip(store.put(key("ws-1/endless"), endless, meta(64)));
          expect(error).toBeInstanceOf(BlobTooLarge);
        }),
      ));

    test("a failed overwrite keeps the previous object", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const k = key("ws-1/keep");
          yield* store.put(k, chunked("old"), meta(8));
          yield* Effect.flip(store.put(k, chunked("much too long"), meta(8)));
          const value_3 = yield* store.get(k);
          expect((yield* readAll(value_3)).toString()).toBe("old");
        }),
      ));

    test("an overwrite replaces the object", () =>
      run(
        Effect.gen(function* () {
          const store = yield* BlobStorage;
          const k = key("ws-1/replace");
          yield* store.put(k, chunked("first"), meta());
          yield* store.put(k, chunked("second"), meta());
          const value_4 = yield* store.get(k);
          expect((yield* readAll(value_4)).toString()).toBe("second");
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
          const value_5 = yield* store.get(key("ws-1/reused"));
          const read = yield* readAll(value_5);
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
          const value_6 = yield* store.get(k);
          expect((yield* readAll(value_6)).toString()).toBe("dots");
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
          const value_7 = yield* store.get(key("ws-1/p"));
          expect((yield* readAll(value_7)).toString()).toBe("now a file");
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
      Str.repeat(1025)("x"),
      Str.repeat(513)("\u017e"),
    ];
    for (const bad of badKeys) {
      test(`rejects key ${Str.slice(0, 20)(bad)} as a defect on every operation`, () =>
        run(
          Effect.gen(function* () {
            const store = yield* BlobStorage;
            const k = key(bad);
            const defects = [
              defectOf(store.put(k, chunked("x"), meta())),
              defectOf(store.get(k)),
              defectOf(store.delete(k)),
            ];
            for (const operation of defects) {
              const defect = yield* operation;
              expect(defect).toBeInstanceOf(InvalidBlobKey);
            }
          }),
        ));
    }
  });
};
