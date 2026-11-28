import type { Locale } from "@kvitbit/domain/contract";
import type { SettingsSection } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  Check,
  FileSpreadsheet,
  FileText,
  Hash,
  Key,
  Landmark,
  LogOut,
  Palette,
  Plug,
  Plus,
  ReceiptText,
  Shield,
  Tag,
  User,
  Users,
} from "lucide-react-native";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useSession } from "../../session/session-provider";
import {
  Badge,
  Banner,
  Button,
  Card,
  type IconComponent,
  ListRow,
  Screen,
  Section,
  SegmentedChoice,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canEditWorkspaceSettings } from "../settings/permissions";
import { forkFeatureEffect } from "../ui-effect";
import { filterWorkspaces, hiddenTabItems, roleLabelKey, SETTINGS_NAV_ITEMS } from "./more-model";

const HIDDEN_TAB_ICON: Readonly<Record<string, IconComponent>> = {
  templates: FileSpreadsheet,
  priceList: Tag,
  reports: BarChart3,
};

const SETTINGS_ICON: Readonly<Record<SettingsSection, IconComponent>> = {
  issuingEntity: Building2,
  taxRegime: ReceiptText,
  bankAccounts: Landmark,
  branding: Palette,
  numbering: Hash,
  documentDefaults: FileText,
  reminders: Bell,
  team: Users,
  apiKeys: Key,
  connectedApps: Plug,
  dangerZone: AlertTriangle,
};

/** Mobile More tab (M18): workspace switcher, hidden tabs, settings sections, account & sign out. */
export function MoreScreen() {
  const { workspace, workspaces, reload } = useWorkspace();
  const session = useSession();
  const { t, locale, setLocale, local } = useI18n();
  const overlay = useOverlay();

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  const visibleWorkspaces = useMemo(
    () => filterWorkspaces(workspaces, search),
    [workspaces, search],
  );
  const hiddenTabs = useMemo(() => hiddenTabItems({ ws: workspace.slug }), [workspace.slug]);
  const isAdminOrOwner = canEditWorkspaceSettings(workspace.role, workspace.closed);

  const handleSwitchWorkspace = (targetSlug: typeof workspace.slug) => {
    setSwitcherOpen(false);
    setSearch("");
    if (targetSlug === workspace.slug) return;
    navigate({ _tag: "Dashboard", ws: targetSlug }, { replace: true });
  };

  const handleSignOut = () =>
    forkFeatureEffect(
      Effect.gen(function* () {
        const confirmed = yield* Effect.promise(() =>
          overlay.confirm({
            title: t("common.action.signOut"),
            body: local({
              cs: "Opravdu se chcete odhlásit z tohoto zařízení?",
              en: "Are you sure you want to sign out on this device?",
            }),
            confirmLabel: t("common.action.signOut"),
            cancelLabel: t("common.action.cancel"),
            destructive: true,
          }),
        );
        if (confirmed === false) return;
        setSigningOut(true);
        yield* Effect.promise(() =>
          session.auth("/sign-out", { method: "POST" }).catch(() => undefined),
        ).pipe(
          Effect.andThen(Effect.promise(session.clear)),
          Effect.tap(() => Effect.sync(() => navigate({ _tag: "SignIn" }, { replace: true }))),
          Effect.ensuring(Effect.sync(() => setSigningOut(false))),
        );
      }),
    );

  return (
    <Screen title={t("shell.nav.more")} onRefresh={reload}>
      {workspace.closed ? <Banner text={t("shell.closedWorkspace")} tone="warning" /> : null}

      <Section title={t("shell.workspaceSwitcher.title")}>
        <Card>
          <ListRow
            testID="workspace-switcher-toggle"
            leading={Building2}
            title={workspace.name}
            subtitle={`${workspace.slug} · ${t("shell.workspaceSwitcher.role", { role: t(roleLabelKey(workspace.role)) })}`}
            badge={
              workspace.closed ? (
                <Badge label={t("common.state.readOnly")} tone="warning" />
              ) : (
                <Badge label={t(roleLabelKey(workspace.role))} tone="info" />
              )
            }
            onPress={() => setSwitcherOpen((open) => !open)}
            chevron={false}
            trailing={switcherOpen === true ? "▲" : "▼"}
          />
          {switcherOpen === true ? (
            <View className="gap-2 pt-2">
              {workspaces.length > 3 ? (
                <TextField
                  label={t("shell.workspaceSwitcher.search")}
                  value={search}
                  onChangeText={setSearch}
                />
              ) : null}
              {visibleWorkspaces.length === 0 ? (
                <Text variant="meta" color="onSurfaceVariant">
                  {t("shell.workspaceSwitcher.empty")}
                </Text>
              ) : (
                Arr.map(visibleWorkspaces, (item) => {
                  const isCurrent = item.id === workspace.id;
                  return (
                    <ListRow
                      key={item.id}
                      testID={`workspace-option-${item.slug}`}
                      leading={isCurrent ? Check : Building2}
                      title={item.name}
                      subtitle={t(roleLabelKey(item.role))}
                      badge={
                        isCurrent ? (
                          <Badge label={t("shell.workspaceSwitcher.current")} tone="success" />
                        ) : undefined
                      }
                      onPress={() => handleSwitchWorkspace(item.slug)}
                    />
                  );
                })
              )}
              <View className="items-start pt-1">
                <Button
                  testID="workspace-create-button"
                  kind="tonal"
                  icon={Plus}
                  label={t("shell.workspaceSwitcher.create")}
                  onPress={() => navigate({ _tag: "Onboarding" })}
                />
              </View>
            </View>
          ) : null}
        </Card>
      </Section>

      <Section title={local({ cs: "Agenda", en: "Workspace" })}>
        <Card className="gap-0 px-3 py-1">
          {Arr.map(hiddenTabs, (item) => (
            <ListRow
              key={item.id}
              testID={`more-nav-${item.id}`}
              leading={HIDDEN_TAB_ICON[item.id] ?? FileText}
              title={t(item.labelKey)}
              onPress={() => navigate(item.route)}
            />
          ))}
        </Card>
      </Section>

      <Section
        title={t("settings.title")}
        action={
          isAdminOrOwner ? undefined : <Badge label={t("common.state.readOnly")} tone="neutral" />
        }
      >
        <Card className="gap-0 px-3 py-1">
          {Arr.map(SETTINGS_NAV_ITEMS, (item) => (
            <ListRow
              key={item.section}
              testID={`more-settings-${item.section}`}
              leading={SETTINGS_ICON[item.section]}
              title={t(item.labelKey)}
              onPress={() =>
                navigate({ _tag: "Settings", ws: workspace.slug, section: item.section })
              }
            />
          ))}
        </Card>
      </Section>

      <Section title={t("account.title")}>
        <Card className="gap-0 px-3 py-1">
          <ListRow
            testID="more-account-profile"
            leading={User}
            title={t("account.profile.title")}
            {...(session.state.status === "signed-in"
              ? { subtitle: session.state.user.email }
              : {})}
            onPress={() => navigate({ _tag: "Account", tab: "profile" })}
          />
          <ListRow
            testID="more-account-appearance"
            leading={Palette}
            title={t("account.appearance.title")}
            onPress={() => navigate({ _tag: "Account", tab: "appearance" })}
          />
          <ListRow
            testID="more-account-security"
            leading={Shield}
            title={t("account.security.title")}
            onPress={() => navigate({ _tag: "Account", tab: "security" })}
          />
        </Card>
      </Section>

      <Section title={t("account.profile.language")}>
        <Card>
          <SegmentedChoice<Locale>
            value={locale}
            choices={[
              { value: "cs", label: t("enum.locale.cs") },
              { value: "en", label: t("enum.locale.en") },
            ]}
            onChange={setLocale}
          />
        </Card>
      </Section>

      <View className="pt-1">
        <Button
          testID="more-sign-out"
          kind="outlined"
          icon={LogOut}
          label={t("common.action.signOut")}
          busy={signingOut}
          onPress={() => {
            handleSignOut();
          }}
        />
      </View>
    </Screen>
  );
}
