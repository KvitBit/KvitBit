import Constants from "expo-constants";
import PostHog from "posthog-react-native";

type PostHogConfig = {
  readonly posthogProjectToken?: string;
  readonly posthogHost?: string;
};

const config = Constants.expoConfig?.extra as PostHogConfig | undefined;
const projectToken = config?.posthogProjectToken?.trim();
const host = config?.posthogHost?.trim();

const reportMissingConfiguration = (variableName: string) => {
  if (__DEV__) {
    console.error(
      new Error(
        `${variableName} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variableName} is configured`,
      ),
    );
  }
};

if (!projectToken) reportMissingConfiguration("EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN");
if (!host) reportMissingConfiguration("EXPO_PUBLIC_POSTHOG_HOST");

/** The single PostHog client used throughout the Expo application. */
export const posthog =
  projectToken && host
    ? new PostHog(projectToken, {
        host,
        captureAppLifecycleEvents: true,
        logs: {
          serviceName: "kvitbit-mobile",
          environment: __DEV__ ? "development" : "production",
          serviceVersion: Constants.expoConfig?.version,
        },
        errorTracking: {
          autocapture: {
            uncaughtExceptions: true,
            unhandledRejections: true,
            // Console output is not part of the error-monitoring scope.
            console: [],
          },
        },
        debug: __DEV__,
      })
    : null;

/**
 * Dedicated PostHog log capture. Existing application console output is intentionally not exported.
 */
export const posthogLog = {
  info: (message: string, attributes?: Record<string, string | number | boolean>) => {
    try {
      posthog?.logger.info(message, attributes);
    } catch {
      // Log capture must not affect application work.
    }
  },
};
