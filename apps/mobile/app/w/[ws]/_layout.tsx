import { MOBILE_NAV, type NavSection, navLabelKey } from "@kvitbit/ui-port/view-models";
import { Redirect, router, Tabs, useLocalSearchParams, useUnstableGlobalHref } from "expo-router";
import { FileText, House, Menu, Receipt, Users } from "lucide-react-native";
import { useEffect } from "react";
import { useI18n } from "../../../src/i18n/i18n-provider";
import { safeReturnTo } from "../../../src/navigation/return-to";
import { hrefOf, param } from "../../../src/navigation/routes";
import { useRemote } from "../../../src/runtime/api-runtime";
import { useSession } from "../../../src/session/session-provider";
import { useTheme } from "../../../src/theme/theme-provider";
import type { IconComponent } from "../../../src/ui/icon";
import { RemoteView } from "../../../src/ui/remote-view";
import { Screen } from "../../../src/ui/screen";
import { EmptyState } from "../../../src/ui/surface";
import { lastWorkspace } from "../../../src/workspace/last-workspace";
import { WorkspaceProvider } from "../../../src/workspace/workspace-provider";

/** Tab route per mobile navigation section (screen 06); the rest are hidden tab routes. */
const TAB_ROUTE: Readonly<Partial<Record<NavSection, string>>> = {
  dashboard: "index",
  documents: "documents",
  expenses: "expenses",
  contacts: "contacts",
  more: "more",
};
const TAB_ICON: Readonly<Partial<Record<NavSection, IconComponent>>> = {
  dashboard: House,
  documents: FileText,
  expenses: Receipt,
  contacts: Users,
  more: Menu,
};
const HIDDEN = ["templates", "price-list", "reports", "settings"] as const;

export default function WorkspaceLayout() {
  const session = useSession();
  const theme = useTheme();
  const { t, local } = useI18n();
  const slug = param(useLocalSearchParams<{ ws: string }>().ws) ?? "";
  const returnTo = safeReturnTo(useUnstableGlobalHref());
  const signedIn = session.state.status === "signed-in";
  const workspaces = useRemote(signedIn ? (api) => api.myWorkspaces.listMine() : null, [signedIn]);
  const isMember =
    signedIn &&
    workspaces.state._tag === "Ready" &&
    workspaces.state.value.some((w) => w.slug === slug);
  useEffect(() => {
    if (isMember) void lastWorkspace.write(slug);
  }, [isMember, slug]);
  if (!signedIn) {
    const href = hrefOf({ _tag: "SignIn", ...(returnTo === null ? {} : { returnTo }) });
    return <Redirect href={href as never} />;
  }
  return (
    <RemoteView state={workspaces.state} onRetry={workspaces.reload}>
      {(all) => {
        const workspace = all.find((w) => w.slug === slug);
        if (workspace === undefined)
          return (
            <Screen title={t("app.name")}>
              <EmptyState
                title={local({ cs: "Workspace nenalezen", en: "Workspace not found" })}
                action={{ label: t("common.action.back"), onPress: () => router.replace("/") }}
              />
            </Screen>
          );
        return (
          <WorkspaceProvider workspace={workspace} workspaces={all} reload={workspaces.reload}>
            <Tabs
              screenOptions={{
                headerShown: false,
                tabBarActiveTintColor: theme.colors.onSecondaryContainer,
                tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
                tabBarStyle: {
                  backgroundColor: theme.colors.surfaceContainer,
                  borderTopColor: theme.colors.outlineVariant,
                  minHeight: 64,
                },
              }}
            >
              {MOBILE_NAV.map((section) => {
                const name = TAB_ROUTE[section];
                const Glyph = TAB_ICON[section];
                if (name === undefined || Glyph === undefined) return null;
                return (
                  <Tabs.Screen
                    key={section}
                    name={name}
                    options={{
                      title: t(navLabelKey(section)),
                      tabBarIcon: ({ color, size }) => <Glyph color={color} size={size} />,
                    }}
                  />
                );
              })}
              {HIDDEN.map((name) => (
                <Tabs.Screen key={name} name={name} options={{ href: null }} />
              ))}
            </Tabs>
          </WorkspaceProvider>
        );
      }}
    </RemoteView>
  );
}
