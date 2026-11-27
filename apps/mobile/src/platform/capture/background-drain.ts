import * as Effect from "effect/Effect";
import { Platform } from "react-native";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { tryPlatform } from "../platform-effect";

export const BACKGROUND_CAPTURE_DRAIN_TASK = "kvitbit.expense-capture.drain";
export const BACKGROUND_DRAIN_MIN_INTERVAL_MINUTES = 15;

export interface BackgroundTaskBridge {
  readonly platformOs?: string;
  readonly isAvailableAsync: () => Promise<boolean>;
  readonly getStatusAsync: () => Promise<number>;
  readonly availableStatus: number;
  readonly isTaskDefined: (taskName: string) => boolean;
  readonly isTaskRegisteredAsync: (taskName: string) => Promise<boolean>;
  readonly registerTaskAsync: (
    taskName: string,
    options?: { readonly minimumInterval?: number },
  ) => Promise<void>;
  readonly unregisterTaskAsync: (taskName: string) => Promise<void>;
}

const loadBridge = Effect.fn("BackgroundCapture.loadBridge")(function* () {
  const [TaskManager, BackgroundTask] = yield* Effect.all(
    [
      fromMobilePromise(() => import("expo-task-manager")),
      fromMobilePromise(() => import("expo-background-task")),
    ],
    { concurrency: "unbounded" },
  );
  return {
    platformOs: Platform.OS,
    isAvailableAsync: TaskManager.isAvailableAsync,
    getStatusAsync: BackgroundTask.getStatusAsync,
    availableStatus: BackgroundTask.BackgroundTaskStatus.Available,
    isTaskDefined: TaskManager.isTaskDefined,
    isTaskRegisteredAsync: TaskManager.isTaskRegisteredAsync,
    registerTaskAsync: BackgroundTask.registerTaskAsync,
    unregisterTaskAsync: BackgroundTask.unregisterTaskAsync,
  };
});

const register = Effect.fn("BackgroundCapture.register")(function* (bridge?: BackgroundTaskBridge) {
  const resolved = bridge ?? (yield* loadBridge());
  if ((resolved.platformOs ?? Platform.OS) !== "android") return false;
  if (!(yield* fromMobilePromise(() => resolved.isAvailableAsync()))) return false;
  if ((yield* fromMobilePromise(() => resolved.getStatusAsync())) !== resolved.availableStatus) {
    return false;
  }
  const defined = yield* tryPlatform(() => resolved.isTaskDefined(BACKGROUND_CAPTURE_DRAIN_TASK));
  if (!defined) return false;
  if (
    yield* fromMobilePromise(() => resolved.isTaskRegisteredAsync(BACKGROUND_CAPTURE_DRAIN_TASK))
  ) {
    return true;
  }
  yield* fromMobilePromise(() =>
    resolved.registerTaskAsync(BACKGROUND_CAPTURE_DRAIN_TASK, {
      minimumInterval: BACKGROUND_DRAIN_MIN_INTERVAL_MINUTES,
    }),
  );
  return true;
});

const unregister = Effect.fn("BackgroundCapture.unregister")(function* (
  bridge?: BackgroundTaskBridge,
) {
  const resolved = bridge ?? (yield* loadBridge());
  if ((resolved.platformOs ?? Platform.OS) !== "android") return false;
  const registered = yield* fromMobilePromise(() =>
    resolved.isTaskRegisteredAsync(BACKGROUND_CAPTURE_DRAIN_TASK),
  );
  if (!registered) return false;
  yield* fromMobilePromise(() => resolved.unregisterTaskAsync(BACKGROUND_CAPTURE_DRAIN_TASK));
  return true;
});

export const registerBackgroundCaptureDrain = (bridge?: BackgroundTaskBridge): Promise<boolean> =>
  runMobileEffect(register(bridge).pipe(Effect.orElseSucceed(() => false)));

export const unregisterBackgroundCaptureDrain = (bridge?: BackgroundTaskBridge): Promise<boolean> =>
  runMobileEffect(unregister(bridge).pipe(Effect.orElseSucceed(() => false)));
