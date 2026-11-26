import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { runBackgroundCaptureDrain } from "../../features/expenses/background-drain";
import { BACKGROUND_CAPTURE_DRAIN_TASK } from "./background-drain";

if (Platform.OS === "android" && !TaskManager.isTaskDefined(BACKGROUND_CAPTURE_DRAIN_TASK)) {
  TaskManager.defineTask(BACKGROUND_CAPTURE_DRAIN_TASK, async () => {
    try {
      const outcome = await runBackgroundCaptureDrain();
      return outcome.status === "error"
        ? BackgroundTask.BackgroundTaskResult.Failed
        : BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}
