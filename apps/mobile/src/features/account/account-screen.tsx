import type { ThemeContrast, ThemeMode, ThemeStyle } from "@kvitbit/domain/contract";
import { describeError } from "@kvitbit/ui-port/api";
import { enumText, type Locale } from "@kvitbit/ui-port/i18n";
import { KeyRound, LogOut, MonitorSmartphone, ShieldAlert, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useRemote } from "../../runtime/api-runtime";
import { useSession } from "../../session/session-provider";
import { useAppTheme } from "../../theme/theme-provider";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ListRow,
  Loading,
  RemoteView,
  Screen,
  Section,
  SegmentedChoice,
  SwitchRow,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import type { AuthClient, PasskeyView, SessionView } from "../auth/auth-port";
import { useAuthClient } from "../auth/use-auth-client";

export type AccountTab = "profile" | "appearance" | "security" | "sessions" | "danger";

export const parseAccountTab = (raw: string | undefined): AccountTab =>
  raw === "profile" ||
  raw === "appearance" ||
  raw === "security" ||
  raw === "sessions" ||
  raw === "danger"
    ? raw
    : "profile";

const MIN_PASSWORD_LENGTH = 10;

export function AccountScreen(props: {
  readonly tab: AccountTab;
  readonly authClient?: AuthClient;
}) {
  const { t, text, locale, setLocale } = useI18n();
  const session = useSession();
  const appTheme = useAppTheme();
  const overlay = useOverlay();
  const contextAuth = useAuthClient();
  const auth = props.authClient ?? contextAuth;

  const user = session.state.status === "signed-in" ? session.state.user : null;

  // Profile state
  const [name, setName] = useState(user?.name ?? "");
  const [newEmail, setNewEmail] = useState("");
  const [emailChangeSent, setEmailChangeSent] = useState<string | null>(null);

  // Security: Passkeys
  const [passkeys, setPasskeys] = useState<ReadonlyArray<PasskeyView> | null>(null);
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  // Security: Password
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);

  // Sessions
  const [sessions, setSessions] = useState<ReadonlyArray<SessionView> | null>(null);

  // Danger: Delete account
  const workspaces = useRemote(
    props.tab === "danger" && user !== null ? (api) => api.myWorkspaces.listMine() : null,
    [props.tab, user?.id],
  );
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deletePassword, setDeletePassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const loadPasskeys = useCallback(async () => {
    const res = await auth.passkeys();
    if (res._tag === "Ok") setPasskeys(res.value);
    else if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
  }, [auth, text]);

  const loadSessions = useCallback(async () => {
    const res = await auth.sessions();
    if (res._tag === "Ok") setSessions(res.value);
    else if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
  }, [auth, text]);

  useEffect(() => {
    setErrorBanner(null);
    if (props.tab === "security") void loadPasskeys();
    if (props.tab === "sessions") void loadSessions();
  }, [props.tab, loadPasskeys, loadSessions]);

  const handleSaveName = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.updateUser({ name: trimmed });
    setBusy(false);
    if (res._tag === "Ok") {
      overlay.toast(t("common.state.saved"));
      return;
    }
    if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
  };

  const handleChangeEmail = async () => {
    const trimmed = newEmail.trim();
    if (!trimmed.includes("@")) {
      setErrorBanner(t("issue.form.email_invalid"));
      return;
    }
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.changeEmail(trimmed);
    setBusy(false);
    if (res._tag === "Ok") {
      setEmailChangeSent(trimmed);
      setNewEmail("");
      return;
    }
    if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
  };

  const handleAddPasskey = async () => {
    const label = newPasskeyName.trim() || "Passkey";
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.passkeyAdd(label);
    setBusy(false);
    if (res._tag === "Ok") {
      setNewPasskeyName("");
      overlay.toast(t("account.security.passkeyAdded"));
      setPasskeys((prev) => (prev === null ? [res.value] : [...prev, res.value]));
      return;
    }
    if (res._tag === "Cancelled") return;
    setErrorBanner(text(describeError(res.error).text));
  };

  const handleRenamePasskey = async (id: string) => {
    const trimmed = renameText.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.renamePasskey(id, trimmed);
    setBusy(false);
    if (res._tag === "Ok") {
      setRenamingId(null);
      setRenameText("");
      setPasskeys((prev) =>
        prev === null ? null : prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
      );
      overlay.toast(t("common.state.saved"));
      return;
    }
    if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
  };

  const handleRemovePasskey = async (pk: PasskeyView) => {
    const confirmed = await overlay.confirm({
      title: t("account.security.removePasskeyTitle", { name: pk.name }),
      confirmLabel: t("common.action.remove"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.removePasskey(pk.id);
    setBusy(false);
    if (res._tag === "Ok") {
      setPasskeys((prev) => (prev === null ? null : prev.filter((p) => p.id !== pk.id)));
      return;
    }
    if (res._tag === "Err") {
      if (res.error._tag === "Conflict" && res.error.reason === "illegal_transition") {
        setErrorBanner(t("account.security.lastMethod"));
      } else {
        setErrorBanner(text(describeError(res.error).text));
      }
    }
  };

  const handleChangePassword = async () => {
    if (nextPassword.length < MIN_PASSWORD_LENGTH) {
      setErrorBanner(t("issue.form.password_too_short", { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (nextPassword !== confirmPassword) {
      setErrorBanner(t("issue.form.password_mismatch"));
      return;
    }
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.changePassword(currentPassword, nextPassword, revokeOthers);
    setBusy(false);
    if (res._tag === "Ok") {
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      overlay.toast(t("account.security.passwordChanged"));
      return;
    }
    if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
  };

  const handleRevokeSession = async (id: string | "others") => {
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.revokeSession(id);
    setBusy(false);
    if (res._tag === "Ok") {
      setSessions((prev) =>
        prev === null
          ? null
          : id === "others"
            ? prev.filter((s) => s.current)
            : prev.filter((s) => s.id !== id),
      );
      overlay.toast(t("common.state.saved"));
      return;
    }
    if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
  };

  const handleSignOut = async () => {
    setBusy(true);
    await auth.signOut();
    setBusy(false);
    navigate({ _tag: "SignIn" }, { replace: true });
  };

  const expectedPhrase = t("account.danger.confirmPhrase");
  const handleDeleteAccount = async () => {
    if (deletePhrase.trim() !== expectedPhrase) {
      setErrorBanner(t("issue.form.confirmation_mismatch"));
      return;
    }
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.deleteAccount(
      deletePassword.length > 0 ? { password: deletePassword } : {},
    );
    setBusy(false);
    if (res._tag === "Ok") {
      navigate({ _tag: "SignIn" }, { replace: true });
      return;
    }
    if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
  };

  return (
    <Screen title={t("account.title")} back>
      <SegmentedChoice<AccountTab>
        value={props.tab}
        onChange={(next) => navigate({ _tag: "Account", tab: next }, { replace: true })}
        choices={[
          { value: "profile", label: t("account.profile.title") },
          { value: "appearance", label: t("account.appearance.title") },
          { value: "security", label: t("account.security.title") },
          { value: "sessions", label: t("account.security.sessions") },
          { value: "danger", label: t("account.danger.title") },
        ]}
      />

      {errorBanner === null ? null : <Banner tone="error" text={errorBanner} />}

      {props.tab === "profile" ? (
        <>
          <Section title={t("account.profile.title")}>
            <Card>
              <TextField
                label={t("account.profile.name")}
                value={name}
                onChangeText={setName}
                disabled={busy}
                testID="account-name"
              />
              <Button
                label={t("common.action.save")}
                onPress={() => void handleSaveName()}
                busy={busy}
                testID="account-save-name"
              />
              <SegmentedChoice<Locale>
                label={t("account.profile.language")}
                value={locale}
                onChange={setLocale}
                choices={[
                  { value: "cs", label: t("enum.locale.cs") },
                  { value: "en", label: t("enum.locale.en") },
                ]}
              />
            </Card>
          </Section>

          <Section title={t("account.profile.email")}>
            <Card>
              {user === null ? null : (
                <Text variant="bodyMedium" color="onSurfaceVariant">
                  {user.email}
                </Text>
              )}
              {emailChangeSent === null ? null : (
                <Banner
                  tone="info"
                  text={t("account.profile.emailChangeSent", { email: emailChangeSent })}
                />
              )}
              <TextField
                label={t("account.profile.changeEmail")}
                value={newEmail}
                onChangeText={setNewEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                disabled={busy}
                testID="account-new-email"
              />
              <Button
                kind="tonal"
                label={t("account.profile.changeEmail")}
                onPress={() => void handleChangeEmail()}
                disabled={newEmail.trim().length === 0}
                busy={busy}
                testID="account-change-email"
              />
            </Card>
          </Section>

          <Button
            kind="outlined"
            icon={LogOut}
            label={t("common.action.signOut")}
            onPress={() => void handleSignOut()}
            busy={busy}
            testID="account-sign-out"
          />
        </>
      ) : props.tab === "appearance" ? (
        <Section title={t("account.appearance.title")}>
          <Card>
            <SegmentedChoice<ThemeMode>
              label={t("account.appearance.mode")}
              value={appTheme.preference.mode}
              onChange={(mode) => appTheme.setPreference({ ...appTheme.preference, mode })}
              choices={[
                { value: "system", label: text(enumText("themeMode", "system")) },
                { value: "light", label: text(enumText("themeMode", "light")) },
                { value: "dark", label: text(enumText("themeMode", "dark")) },
              ]}
            />
            <SegmentedChoice<ThemeStyle>
              label={t("account.appearance.style")}
              value={appTheme.preference.style}
              onChange={(style) => appTheme.setPreference({ ...appTheme.preference, style })}
              choices={[
                { value: "elegant", label: text(enumText("themeStyle", "elegant")) },
                { value: "cozy", label: text(enumText("themeStyle", "cozy")) },
              ]}
            />
            <SegmentedChoice<ThemeContrast>
              label={t("account.appearance.contrast")}
              value={appTheme.preference.contrast}
              onChange={(contrast) => appTheme.setPreference({ ...appTheme.preference, contrast })}
              choices={[
                { value: "standard", label: text(enumText("themeContrast", "standard")) },
                { value: "medium", label: text(enumText("themeContrast", "medium")) },
                { value: "high", label: text(enumText("themeContrast", "high")) },
              ]}
            />
            {appTheme.dynamicAvailable ? (
              <SwitchRow
                label={t("account.appearance.dynamicColor")}
                description={t("account.appearance.dynamicColorHint")}
                value={appTheme.preference.dynamicColor}
                onChange={(dynamicColor) =>
                  appTheme.setPreference({ ...appTheme.preference, dynamicColor })
                }
              />
            ) : null}
          </Card>
        </Section>
      ) : props.tab === "security" ? (
        <>
          <Section title={t("account.security.passkeys")}>
            <Card>
              <View className="flex-row items-end gap-2">
                <View className="flex-1">
                  <TextField
                    label={t("account.security.passkeyName")}
                    value={newPasskeyName}
                    onChangeText={setNewPasskeyName}
                    disabled={busy}
                    testID="passkey-name-input"
                  />
                </View>
                <Button
                  kind="tonal"
                  icon={KeyRound}
                  label={t("account.security.addPasskey")}
                  onPress={() => void handleAddPasskey()}
                  busy={busy}
                  testID="passkey-add-btn"
                />
              </View>

              {passkeys === null ? (
                <Loading />
              ) : passkeys.length === 0 ? (
                <EmptyState title={t("account.security.noPasskeys")} />
              ) : (
                passkeys.map((pk) => (
                  <View key={pk.id} className="gap-1">
                    {renamingId === pk.id ? (
                      <View className="flex-row items-end gap-2">
                        <View className="flex-1">
                          <TextField
                            label={t("account.security.passkeyName")}
                            value={renameText}
                            onChangeText={setRenameText}
                            disabled={busy}
                          />
                        </View>
                        <Button
                          label={t("common.action.save")}
                          onPress={() => void handleRenamePasskey(pk.id)}
                          busy={busy}
                        />
                        <Button
                          kind="text"
                          label={t("common.action.cancel")}
                          onPress={() => setRenamingId(null)}
                        />
                      </View>
                    ) : (
                      <>
                        <ListRow
                          leading={KeyRound}
                          title={pk.name}
                          subtitle={pk.createdAt.slice(0, 10)}
                        />
                        <View className="flex-row justify-end gap-2">
                          <Button
                            kind="text"
                            label={t("common.action.rename")}
                            onPress={() => {
                              setRenamingId(pk.id);
                              setRenameText(pk.name);
                            }}
                            disabled={busy}
                          />
                          <Button
                            kind="text"
                            label={t("common.action.remove")}
                            onPress={() => void handleRemovePasskey(pk)}
                            disabled={busy}
                            testID={`passkey-remove-${pk.id}`}
                          />
                        </View>
                      </>
                    )}
                  </View>
                ))
              )}
            </Card>
          </Section>

          <Section title={t("account.security.changePassword")}>
            <Card>
              <TextField
                label={t("account.security.currentPassword")}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                secureTextEntry
                disabled={busy}
                testID="change-password-current"
              />
              <TextField
                label={t("account.security.newPassword")}
                value={nextPassword}
                onChangeText={setNextPassword}
                supporting={t("auth.signUp.passwordHint")}
                secureTextEntry
                disabled={busy}
                testID="change-password-next"
              />
              <TextField
                label={t("auth.resetPassword.confirmPassword")}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                disabled={busy}
                testID="change-password-confirm"
              />
              <SwitchRow
                label={t("account.security.signOutOthers")}
                value={revokeOthers}
                onChange={setRevokeOthers}
                disabled={busy}
              />
              <Button
                label={t("account.security.changePassword")}
                onPress={() => void handleChangePassword()}
                busy={busy}
                testID="change-password-submit"
              />
            </Card>
          </Section>
        </>
      ) : props.tab === "sessions" ? (
        <Section
          title={t("account.security.sessions")}
          action={
            <Button
              kind="text"
              label={t("account.security.signOutOthers")}
              onPress={() => void handleRevokeSession("others")}
              disabled={busy}
              testID="sessions-revoke-others"
            />
          }
        >
          <Card>
            {sessions === null ? (
              <Loading />
            ) : sessions.length === 0 ? (
              <EmptyState title={t("common.state.empty")} />
            ) : (
              sessions.map((s) => (
                <View key={s.id} className="gap-1">
                  <ListRow
                    leading={MonitorSmartphone}
                    title={s.userAgent ?? t("common.state.unknown")}
                    subtitle={[s.ipAddress, s.createdAt.slice(0, 10)].filter(Boolean).join(" · ")}
                    badge={
                      s.current ? (
                        <Badge tone="info" label={t("account.security.thisDevice")} />
                      ) : undefined
                    }
                  />
                  {s.current ? null : (
                    <View className="flex-row justify-end gap-2">
                      <Button
                        kind="text"
                        label={t("account.security.revokeSession")}
                        onPress={() => void handleRevokeSession(s.id)}
                        disabled={busy}
                        testID={`session-revoke-${s.id}`}
                      />
                    </View>
                  )}
                </View>
              ))
            )}
          </Card>
          <Button
            kind="outlined"
            icon={LogOut}
            label={t("common.action.signOut")}
            onPress={() => void handleSignOut()}
            busy={busy}
          />
        </Section>
      ) : (
        <Section title={t("account.danger.title")}>
          <Card>
            <View className="flex-row items-center gap-2">
              <ShieldAlert size={20} />
              <Text variant="bodyMedium">{t("account.danger.body")}</Text>
            </View>

            <RemoteView state={workspaces.state} onRetry={workspaces.reload}>
              {(list) =>
                list.length === 0 ? null : (
                  <View>
                    {list.map((ws) => (
                      <ListRow
                        key={ws.id}
                        title={ws.name}
                        subtitle={text(enumText("role", ws.role))}
                      />
                    ))}
                  </View>
                )
              }
            </RemoteView>

            <TextField
              label={t("account.danger.confirm", { phrase: expectedPhrase })}
              value={deletePhrase}
              onChangeText={setDeletePhrase}
              autoCapitalize="characters"
              disabled={busy}
              testID="delete-account-phrase"
            />
            <TextField
              label={t("common.field.password")}
              value={deletePassword}
              onChangeText={setDeletePassword}
              supporting={t("common.state.optional")}
              secureTextEntry
              disabled={busy}
              testID="delete-account-password"
            />
            <Button
              kind="danger"
              icon={Trash2}
              label={t("account.danger.submit")}
              onPress={() => void handleDeleteAccount()}
              disabled={deletePhrase.trim() !== expectedPhrase}
              busy={busy}
              testID="delete-account-submit"
            />
          </Card>
        </Section>
      )}
    </Screen>
  );
}
