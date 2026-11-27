import * as Effect from "effect/Effect";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { runBackgroundCaptureDrain } from "../../features/expenses/background-drain";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { BACKGROUND_CAPTURE_DRAIN_TASK } from "./background-drain";

if (Platform.OS === "android" && !TaskManager.isTaskDefined(BACKGROUND_CAPTURE_DRAIN_TASK)) {
  TaskManager.defineTask(BACKGROUND_CAPTURE_DRAIN_TASK, () =>
    runMobileEffect(
      fromMobilePromise(runBackgroundCaptureDrain).pipe(
        Effect.map((outcome) =>
          outcome.status === "error"
            ? BackgroundTask.BackgroundTaskResult.Failed
            : BackgroundTask.BackgroundTaskResult.Success,
        ),
        Effect.orElseSucceed(() => BackgroundTask.BackgroundTaskResult.Failed),
      ),
    ),
  );
}
