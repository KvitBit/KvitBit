import * as Effect from "effect/Effect";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { PlatformOperationFailed, tryPlatform } from "../platform-effect";

export const openIndexedStore = (store: string) => (name: string) => {
  let opening: Promise<IDBDatabase> | undefined;

  const connect = Effect.yieldNow.pipe(
    Effect.andThen(tryPlatform(() => indexedDB.open(name, 1))),
    Effect.flatMap((request) =>
      Effect.callback<IDBDatabase, DOMException | null>((resume) => {
        request.onupgradeneeded = () => request.result.createObjectStore(store);
        request.onsuccess = () => resume(Effect.succeed(request.result));
        request.onerror = () => resume(Effect.fail(request.error));
      }),
    ),
    Effect.tapError(() =>
      Effect.sync(() => {
        opening = undefined;
      }),
    ),
  );

  return Effect.suspend(() =>
    fromMobilePromise(() => {
      opening ??= runMobileEffect(connect);
      return opening;
    }),
  );
};

// @effect-diagnostics-next-line missingPipeableSignature:off The curried store operation is applied to its open database.
export const inIndexedStore =
  <A>(
    name: string,
    mode: IDBTransactionMode,
    requestFor: (store: IDBObjectStore) => IDBRequest<A>,
    options?: IDBTransactionOptions,
  ) =>
  (db: IDBDatabase) =>
    tryPlatform(() => {
      const transaction = db.transaction(name, mode, options);
      return { transaction, request: requestFor(transaction.objectStore(name)) };
    }).pipe(
      Effect.flatMap(({ transaction, request }) =>
        Effect.callback<A, PlatformOperationFailed>((resume) => {
          transaction.oncomplete = () => resume(Effect.succeed(request.result));
          transaction.onabort = () =>
            resume(
              Effect.fail(
                PlatformOperationFailed.make({
                  cause: transaction.error ?? "Receipt queue changed while saving",
                }),
              ),
            );
        }),
      ),
    );
