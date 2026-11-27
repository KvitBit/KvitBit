import * as Effect from "effect/Effect";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { PlatformOperationFailed } from "../platform-effect";
import type { CaptureStorage } from "./capture-storage-port";

const storage = fromMobilePromise(() => import("@react-native-async-storage/async-storage")).pipe(
  Effect.map((module) => module.default),
);
const keyFor = (scope: string) => `expense-capture:v1:${scope}`;
const locks = new Map<string, Promise<unknown>>();

const save = Effect.fn("CaptureStorage.save")(function* (
  scope: string,
  value: string,
  previous: string,
) {
  const store = yield* storage;
  const key = keyFor(scope);
  const latest = (yield* fromMobilePromise(() => store.getItem(key))) ?? "[]";
  if (latest !== previous)
    return yield* PlatformOperationFailed.make({ cause: "Receipt queue changed while saving" });
  yield* fromMobilePromise(() => store.setItem(key, value));
});

export const captureStorage: CaptureStorage = {
  load: (scope) =>
    runMobileEffect(
      storage.pipe(
        Effect.flatMap((store) => fromMobilePromise(() => store.getItem(keyFor(scope)))),
      ),
    ),
  save: (scope, value, previous) => runMobileEffect(save(scope, value, previous)),
  lock: (scope, work) => {
    const previous = locks.get(scope);
    const wait =
      previous === undefined ? Effect.yieldNow : Effect.ignore(fromMobilePromise(() => previous));
    const clear = Effect.sync(() => {
      if (locks.get(scope) === next) locks.delete(scope);
    });
    const next: ReturnType<typeof work> = runMobileEffect(
      wait.pipe(Effect.andThen(fromMobilePromise(work)), Effect.ensuring(clear)),
    );
    locks.set(scope, next);
    return next;
  },
};
