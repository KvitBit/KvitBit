import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as EffectString from "effect/String";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { tryPlatform } from "../platform-effect";

const fs = fromMobilePromise(() => import("expo-file-system"));

const read = Effect.fn("ReceiptFiles.read")(function* (ref: string, limit: number) {
  const { File } = yield* fs;
  const file = yield* tryPlatform(() => new File(ref));
  return file.size > limit ? null : yield* fromMobilePromise(() => file.bytes());
});

const save = Effect.fn("ReceiptFiles.save")(function* (
  key: string,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  const { Directory, File, Paths } = yield* fs;
  const directory = yield* tryPlatform(() => {
    const dir = new Directory(Paths.document, "expense-capture", key);
    dir.create({ idempotent: true, intermediates: true });
    return dir;
  });
  // The multipart uploader uses the last URI segment as the filename.
  const basename = EffectString.trim(EffectString.replace(/[/\\]/g, "-")(name));
  const file = yield* tryPlatform(
    () =>
      new File(
        directory,
        basename === "" || basename === "." || basename === ".." ? "receipt" : basename,
      ),
  );
  yield* fromMobilePromise(() => file.write(bytes)).pipe(
    Effect.tapError(() => Effect.ignore(tryPlatform(() => directory.delete()))),
  );
  return file.uri;
});

const remove = Effect.fn("ReceiptFiles.remove")(function* (ref: string) {
  const { File } = yield* fs;
  yield* tryPlatform(() => {
    const directory = new File(ref).parentDirectory;
    if (directory.exists) directory.delete();
  });
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
  (name: string, bytes: Uint8Array<ArrayBuffer>): (key: string) => Promise<string>;
  (key: string, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;
} = Fn.dual(
  3,
  (key: string, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
    runMobileEffect(save(key, name, bytes)),
);

export const removeReceiptBytes = (ref: string): Promise<void> => runMobileEffect(remove(ref));
