import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n/i18n-provider";
import {
  registerBackgroundCaptureDrain,
  unregisterBackgroundCaptureDrain,
} from "../src/platform/capture/background-drain";
import { ApiProvider } from "../src/runtime/api-runtime";
import { SessionProvider, useSession } from "../src/session/session-provider";
import { ThemeProvider, useAppTheme } from "../src/theme/theme-provider";
import { OverlayProvider } from "../src/ui/overlay";
import { UpdateBanner } from "../src/updates";

function Navigator() {
  const session = useSession();
  const { native } = useAppTheme();
  useEffect(() => {
    if (session.state.status === "signed-in") {
      void registerBackgroundCaptureDrain();
    } else if (session.state.status === "signed-out") {
      void unregisterBackgroundCaptureDrain();
    }
  }, [session.state.status]);
  if (session.state.status === "restoring") return null;
  const token = session.state.status === "signed-in" ? session.state.token : null;
  return (
    <ApiProvider token={token}>
      <OverlayProvider>
        <StatusBar style={native.dark ? "light" : "dark"} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: native.colors.surface },
          }}
        />
        <UpdateBanner />
      </OverlayProvider>
    </ApiProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <ThemeProvider>
          <SessionProvider>
            <Navigator />
          </SessionProvider>
        </ThemeProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
