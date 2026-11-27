/**
 * The PWA's file store (ui-port-contracts 5.3 Capture.persist, PWA column): queued receipts live
 * in IndexedDB under `idb:<key>` refs so they survive reloads; other refs are object URLs.
 */
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as EffectString from "effect/String";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { tryPlatform } from "../platform-effect";
import { inIndexedStore, openIndexedStore } from "./indexed-db.web";

const STORE = "blobs";
const db = openIndexedStore(STORE)("kvitbit-capture");

const run = <A>(mode: IDBTransactionMode, requestFor: (store: IDBObjectStore) => IDBRequest<A>) =>
  db.pipe(Effect.flatMap((database) => inIndexedStore(STORE, mode, requestFor)(database)));

const read = Effect.fn("BlobStore.read")(function* (ref: string) {
  if (EffectString.startsWith("idb:")(ref)) {
    const value = yield* run<unknown>("readonly", (store) => store.get(EffectString.slice(4)(ref)));
    return value instanceof Blob ? value : null;
  }
  const fetch = yield* FetchHttpClient.Fetch;
  const response = yield* fromMobilePromise(() => fetch(ref));
  return yield* fromMobilePromise(() => response.blob());
});

export const blobOf = (ref: string): Promise<Blob | null> =>
  runMobileEffect(read(ref).pipe(Effect.orElseSucceed(() => null)));

export const putBlob: {
  (blob: Blob): (key: string) => Promise<string>;
  (key: string, blob: Blob): Promise<string>;
} = Fn.dual(
  2,
  (key: string, blob: Blob): Promise<string> =>
    runMobileEffect(
      run("readwrite", (store) => store.put(blob, key)).pipe(Effect.as(`idb:${key}`)),
    ),
);

const remove = Effect.fn("BlobStore.remove")(function* (ref: string) {
  if (EffectString.startsWith("idb:")(ref)) {
    yield* Effect.ignore(run("readwrite", (store) => store.delete(EffectString.slice(4)(ref))));
  } else if (EffectString.startsWith("blob:")(ref)) {
    yield* tryPlatform(() => URL.revokeObjectURL(ref));
  }
});

export const deleteBlob = (ref: string): Promise<void> => runMobileEffect(remove(ref));
