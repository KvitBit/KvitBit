import type { AppStateStatus } from "react-native";

/**
 * The app checks on launch and then, on each return to the foreground, at
 * most once per interval since its last check, so switching apps back and
 * forth doesn't poll the update server.
 */
export const updateCheckIntervalMs = 15 * 60 * 1000;

export const isUpdateCheckDue = (lastCheckStartedAt: number, now: number): boolean =>
  now < lastCheckStartedAt || now - lastCheckStartedAt >= updateCheckIntervalMs;

/**
 * Whether over-the-air updates apply to this build. The web build is served
 * fresh by the server. `updatesEnabled` is `Updates.isEnabled`, false when the
 * build disables or misconfigures expo-updates; `dev` is `__DEV__`, since
 * debug and dev-client builds load JS from Metro and expo-updates rejects
 * every check there.
 */
export const otaUpdatesApply = ({
  platform,
  updatesEnabled,
  dev,
}: {
  readonly platform: string;
  readonly updatesEnabled: boolean;
  readonly dev: boolean;
}): boolean => platform !== "web" && updatesEnabled && !dev;

/** The part of React Native's `AppState` the schedule listens to. */
export interface AppStateSource {
  readonly addEventListener: (
    type: "change",
    listener: (state: AppStateStatus) => void,
  ) => { readonly remove: () => void };
}

/**
 * Checks once now and again each time the app becomes active once the
 * interval has passed since the last check. Returns the function that stops
 * the foreground checks.
 */
export const scheduleUpdateChecks = ({
  appState,
  now,
  check,
}: {
  readonly appState: AppStateSource;
  readonly now: () => number;
  readonly check: () => void;
}): (() => void) => {
  let lastCheckStartedAt = now();
  check();
  const subscription = appState.addEventListener("change", (state) => {
    const startedAt = now();
    if (state !== "active" || !isUpdateCheckDue(lastCheckStartedAt, startedAt)) return;
    lastCheckStartedAt = startedAt;
    check();
  });
  return () => subscription.remove();
};
