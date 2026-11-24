import { Effect } from "effect";
import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { findReadyUpdate, type ReadyUpdate } from "./ota-update";
import { otaUpdatesApply, scheduleUpdateChecks } from "./update-check";
import { nextReadyUpdate, selectUpdatePrompt, type UpdatePrompt } from "./update-prompt";

// The one runtime edge for update work: it runs in the background and never
// reports a failure to the user.
const runInBackground = (effect: Effect.Effect<unknown, unknown>): void => {
  Effect.runFork(
    effect.pipe(Effect.catchCause((cause) => Effect.logWarning("Update work failed", cause))),
  );
};

/**
 * Starts the update checks this app session runs: one on launch and one on
 * each return to the foreground once the interval has passed. Each check
 * downloads an available update and reports what a reload would launch.
 * Nothing runs on web, in dev, or where expo-updates is disabled. Returns
 * the function that stops the checks.
 */
export const startUpdateChecks = ({
  platform,
  updates,
  dev,
  appState,
  now,
  onCheck,
}: {
  readonly platform: string;
  readonly updates: Pick<typeof Updates, "isEnabled" | "checkForUpdateAsync" | "fetchUpdateAsync">;
  readonly dev: boolean;
  readonly appState: Parameters<typeof scheduleUpdateChecks>[0]["appState"];
  readonly now: () => number;
  readonly onCheck: (found: ReadyUpdate | undefined) => void;
}): (() => void) => {
  if (!otaUpdatesApply({ platform, updatesEnabled: updates.isEnabled, dev })) {
    return () => undefined;
  }
  return scheduleUpdateChecks({
    appState,
    now,
    check: () =>
      runInBackground(
        findReadyUpdate(updates).pipe(Effect.tap((found) => Effect.sync(() => onCheck(found)))),
      ),
  });
};

/**
 * The reload prompt to show, if any, and the action that reloads into the
 * ready update.
 */
export function useUpdatePrompt(): {
  readonly prompt: UpdatePrompt | undefined;
  readonly reload: () => void;
} {
  const [readyUpdate, setReadyUpdate] = useState<ReadyUpdate>();

  useEffect(
    () =>
      startUpdateChecks({
        platform: Platform.OS,
        updates: Updates,
        dev: typeof __DEV__ !== "undefined" && __DEV__,
        appState: AppState,
        now: Date.now,
        onCheck: (found) => setReadyUpdate((previous) => nextReadyUpdate(previous, found)),
      }),
    [],
  );

  return {
    prompt: selectUpdatePrompt({ readyUpdate, runsEmbeddedUpdate: Updates.isEmbeddedLaunch }),
    reload: () => runInBackground(Effect.tryPromise(() => Updates.reloadAsync())),
  };
}
