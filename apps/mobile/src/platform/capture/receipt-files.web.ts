import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { PlatformOperationFailed } from "../platform-effect";
import { blobOf, putBlob } from "./blob-store";

const read = Effect.fn("ReceiptFiles.read")(function* (ref: string, limit: number) {
  const blob = yield* fromMobilePromise(() => blobOf(ref));
  if (blob === null)
    return yield* PlatformOperationFailed.make({ cause: "Receipt file unavailable" });
  if (blob.size > limit) return null;
  const bytes = yield* fromMobilePromise(() => blob.arrayBuffer());
  return new Uint8Array(bytes);
});

const save = Effect.fn("ReceiptFiles.save")(function* (
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  const ref = yield* fromMobilePromise(() => putBlob(key, new Blob([bytes])));
  const stored = yield* fromMobilePromise(() => blobOf(ref));
  if (stored?.size !== bytes.byteLength) {
    return yield* PlatformOperationFailed.make({ cause: "Receipt file was not saved" });
  }
  return ref;
});

export const readReceiptBytes: {
  (limit: number): (ref: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  (ref: string, limit: number): Promise<Uint8Array<ArrayBuffer> | null>;
} = Fn.dual(
  2,
  (ref: string, limit: number): Promise<Uint8Array<ArrayBuffer> | null> =>
    runMobileEffect(read(ref, limit)),
);

export const saveReceiptBytes: {
  (_name: string, bytes: Uint8Array<ArrayBuffer>): (key: string) => Promise<string>;
  (key: string, _name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;
} = Fn.dual(
  3,
  (key: string, _name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
    runMobileEffect(save(key, bytes)),
);

export { deleteBlob as removeReceiptBytes } from "./blob-store";
