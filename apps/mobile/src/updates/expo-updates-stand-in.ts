/**
 * What tests put in place of `expo-updates`, which Bun can't load (it needs
 * the native Expo modules). A test registers it before importing the module
 * under test: `mock.module("expo-updates", () => expoUpdatesStandIn)`. Bun
 * keeps the export names of the first mock for the whole run, so it names
 * every export the app takes from expo-updates. Updates are disabled and
 * every call is inert.
 */
export const expoUpdatesStandIn = {
  isEnabled: false,
  isEmbeddedLaunch: true,
  checkForUpdateAsync: async () => ({
    isAvailable: false as const,
    isRollBackToEmbedded: false as const,
    manifest: undefined,
    reason: undefined,
  }),
  fetchUpdateAsync: async () => ({
    isNew: false as const,
    isRollBackToEmbedded: false as const,
    manifest: undefined,
  }),
  reloadAsync: async () => undefined,
};
