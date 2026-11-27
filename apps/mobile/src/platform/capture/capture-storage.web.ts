import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { PlatformOperationFailed } from "../platform-effect";
import type { CaptureStorage } from "./capture-storage-port";
import { inIndexedStore, openIndexedStore } from "./indexed-db.web";

const STORE = "jobs";
const db = openIndexedStore(STORE)("kvitbit-expense-capture");
const isStoredQueue = Schema.is(Schema.String);

const transaction = <A>(
  mode: IDBTransactionMode,
  requestFor: (store: IDBObjectStore) => IDBRequest<A>,
) =>
  db.pipe(
    Effect.flatMap((database) =>
      inIndexedStore(STORE, mode, requestFor, { durability: "strict" })(database),
    ),
  );

export const captureStorage: CaptureStorage = {
  load: (scope) =>
    runMobileEffect(
      transaction<unknown>("readonly", (store) => store.get(scope)).pipe(
        Effect.flatMap((value) => {
          if (value === undefined || value === null) return Effect.succeed(null);
          return isStoredQueue(value)
            ? Effect.succeed(value)
            : Effect.fail(
                PlatformOperationFailed.make({ cause: "Invalid receipt queue in storage" }),
              );
        }),
      ),
    ),
  save: (scope, value, previous) =>
    runMobileEffect(
      transaction<unknown>("readwrite", (store) => {
        const latest = store.get(scope);
        latest.onsuccess = () => {
          if ((latest.result ?? "[]") === previous) store.put(value, scope);
          else store.transaction.abort();
        };
        return latest;
      }).pipe(Effect.asVoid),
    ),
  lock: (scope, work) =>
    runMobileEffect(
      fromMobilePromise(() =>
        navigator.locks === undefined
          ? work()
          : navigator.locks.request(`kvitbit-expense-capture:${scope}`, work),
      ),
    ),
};
