import { Platform } from "react-native";

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

async function loadBridge(): Promise<BackgroundTaskBridge | null> {
  try {
    const [TaskManager, BackgroundTask] = await Promise.all([
      import("expo-task-manager"),
      import("expo-background-task"),
    ]);
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
  } catch {
    return null;
  }
}

export async function registerBackgroundCaptureDrain(
  bridge?: BackgroundTaskBridge,
): Promise<boolean> {
  try {
    const resolved = bridge ?? (await loadBridge());
    if (resolved === null) return false;
    if ((resolved.platformOs ?? Platform.OS) !== "android") return false;
    if (!(await resolved.isAvailableAsync())) return false;
    if ((await resolved.getStatusAsync()) !== resolved.availableStatus) return false;
    if (!resolved.isTaskDefined(BACKGROUND_CAPTURE_DRAIN_TASK)) return false;
    if (await resolved.isTaskRegisteredAsync(BACKGROUND_CAPTURE_DRAIN_TASK)) return true;
    await resolved.registerTaskAsync(BACKGROUND_CAPTURE_DRAIN_TASK, {
      minimumInterval: BACKGROUND_DRAIN_MIN_INTERVAL_MINUTES,
    });
    return true;
  } catch {
    return false;
  }
}

export async function unregisterBackgroundCaptureDrain(
  bridge?: BackgroundTaskBridge,
): Promise<boolean> {
  try {
    const resolved = bridge ?? (await loadBridge());
    if (resolved === null) return false;
    if ((resolved.platformOs ?? Platform.OS) !== "android") return false;
    if (!(await resolved.isTaskRegisteredAsync(BACKGROUND_CAPTURE_DRAIN_TASK))) return false;
    await resolved.unregisterTaskAsync(BACKGROUND_CAPTURE_DRAIN_TASK);
    return true;
  } catch {
    return false;
  }
}
