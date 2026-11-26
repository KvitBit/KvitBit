import { describeError, UiError } from "@kvitbit/ui-port/api";
import type { Locale } from "@kvitbit/ui-port/i18n";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { passkeyBridge } from "../../platform/passkeys/passkey-bridge";
import {
  Banner,
  Button,
  Card,
  Screen,
  SegmentedChoice,
  SwitchRow,
  space,
  Text,
  TextField,
} from "../../ui";
import { checkEmailHref, inviteReturnTo } from "./auth-links";
import type { AuthClient } from "./auth-port";
import { BotProofWidget } from "./bot-proof-widget";
import { CheckEmailScreen } from "./check-email-screen";
import { useAuthClient } from "./use-auth-client";
import { useBotProof } from "./use-bot-proof";

const MIN_PASSWORD_LENGTH = 10;
type SignupMethod = "password" | "passkey";

export function SignUpScreen(props: {
  readonly invitation?: string;
  readonly lockedEmail?: string;
  readonly authClient?: AuthClient;
}) {
  const { t, text, locale, setLocale, local } = useI18n();
  const contextAuth = useAuthClient();
  const auth = props.authClient ?? contextAuth;

  const [name, setName] = useState("");
  const [email, setEmail] = useState(props.lockedEmail ?? "");
  const [password, setPassword] = useState("");
  const [method, setMethod] = useState<SignupMethod>("password");
  const [passkeyEmail, setPasskeyEmail] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const bot = useBotProof(method === "passkey" ? "magic_link" : "sign_up", { initial: "auto" });
  const returnTo = inviteReturnTo(props.invitation);

  const sendPasskeyLink = async (email: string) => {
    const fresh = await bot.ensureFresh();
    if (fresh._tag === "Failed") return { _tag: "Err" as const, error: fresh.error };
    if (fresh._tag !== "Solved" && fresh._tag !== "NotRequired")
      return { _tag: "Err" as const, error: UiError.offline };
    const result = await auth.sendMagicLink(
      email,
      fresh._tag === "Solved" ? fresh.payload : null,
      "/passkey-setup",
      { name: name.trim(), locale },
    );
    if (result._tag === "Ok" || (result._tag === "Err" && result.error._tag === "InvalidBotProof"))
      void bot.restart();
    return result;
  };

  const handleSubmit = async () => {
    const trimmedEmail = (props.lockedEmail ?? email).trim();
    const trimmedName = name.trim();
    const nextErrors: Record<string, string> = {};

    if (trimmedName.length === 0) nextErrors.name = t("issue.form.required");
    if (!trimmedEmail.includes("@")) nextErrors.email = t("issue.form.email_invalid");
    if (method === "password" && password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = t("issue.form.password_too_short", { min: MIN_PASSWORD_LENGTH });
    }
    if (!acceptedTerms) nextErrors.terms = t("issue.form.terms_required");

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setErrorBanner(nextErrors.terms ?? null);
      return;
    }

    setFieldErrors({});
    setErrorBanner(null);
    setBusy(true);

    if (method === "passkey") {
      if ((await passkeyBridge.availability()) === "unavailable") {
        setBusy(false);
        setErrorBanner(t("auth.passkey.unsupported"));
        return;
      }
      const res = await sendPasskeyLink(trimmedEmail);
      setBusy(false);
      if (res._tag === "Ok") setPasskeyEmail(trimmedEmail);
      else if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
      return;
    }
    const fresh = await bot.ensureFresh();
    if (fresh._tag === "Failed") {
      setBusy(false);
      setErrorBanner(t("auth.botProof.failed"));
      return;
    }
    const proof = fresh._tag === "Solved" ? fresh.payload : null;
    const res = await auth.signUpEmail(
      {
        email: trimmedEmail,
        password,
        name: trimmedName,
        locale,
        ...(props.invitation !== undefined ? { invitation: props.invitation } : {}),
      },
      proof,
    );
    setBusy(false);

    if (res._tag === "Ok") {
      router.push(checkEmailHref(trimmedEmail, returnTo) as never);
      return;
    }
    if (res._tag === "Cancelled") return;

    if (res.error._tag === "InvalidBotProof") void bot.restart();
    const described = describeError(res.error);
    setErrorBanner(text(described.text));
  };

  if (passkeyEmail !== null) {
    return (
      <CheckEmailScreen
        email={passkeyEmail}
        authClient={auth}
        resend={() => sendPasskeyLink(passkeyEmail)}
        onWrongEmail={() => setPasskeyEmail(null)}
      />
    );
  }

  return (
    <Screen title={t("auth.signUp.title")} back>
      <Text variant="bodyMedium" color="onSurfaceVariant">
        {t("auth.signUp.subtitle")}
      </Text>

      {props.invitation === undefined ? null : (
        <Banner tone="info" text={t("auth.signUp.invitationNote")} />
      )}
      {errorBanner === null ? null : <Banner tone="error" text={errorBanner} />}

      <Card>
        {props.invitation === undefined ? (
          <SegmentedChoice<SignupMethod>
            value={method}
            onChange={(next) => {
              if (busy || next === method) return;
              setMethod(next);
              setPassword("");
              setFieldErrors({});
              setErrorBanner(null);
            }}
            choices={[
              { value: "password", label: t("auth.signUp.methodPassword") },
              { value: "passkey", label: t("auth.signUp.methodPasskey") },
            ]}
          />
        ) : null}
        <SegmentedChoice<Locale>
          label={t("common.field.language")}
          value={locale}
          onChange={setLocale}
          choices={[
            { value: "cs", label: t("enum.locale.cs") },
            { value: "en", label: t("enum.locale.en") },
          ]}
        />

        <TextField
          label={t("common.field.name")}
          value={name}
          onChangeText={setName}
          {...(fieldErrors.name !== undefined ? { error: fieldErrors.name } : {})}
          autoComplete="name"
          disabled={busy}
          testID="sign-up-name"
        />

        <TextField
          label={t("common.field.email")}
          value={props.lockedEmail ?? email}
          onChangeText={setEmail}
          {...(fieldErrors.email !== undefined ? { error: fieldErrors.email } : {})}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          disabled={busy || props.lockedEmail !== undefined}
          testID="sign-up-email"
        />

        {method === "password" ? (
          <TextField
            label={t("common.field.password")}
            value={password}
            onChangeText={setPassword}
            {...(fieldErrors.password !== undefined ? { error: fieldErrors.password } : {})}
            supporting={t("auth.signUp.passwordHint")}
            secureTextEntry
            autoComplete="new-password"
            disabled={busy}
            testID="sign-up-password"
          />
        ) : (
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {local({
              cs: "Po potvrzení e-mailu si vytvoříte přístupový klíč.",
              en: "Confirm your email to set up a passkey.",
            })}
          </Text>
        )}

        <SwitchRow
          label={t("auth.signUp.acceptTerms")}
          value={acceptedTerms}
          onChange={setAcceptedTerms}
          disabled={busy}
        />

        <BotProofWidget state={bot.state} onRetry={() => void bot.restart()} />

        <Button
          label={bot.busy ? t("auth.botProof.verifying") : t("auth.signUp.submit")}
          onPress={() => void handleSubmit()}
          busy={busy || bot.busy}
          disabled={bot.state._tag === "Failed"}
          testID="sign-up-submit"
        />
      </Card>

      <View style={styles.footerRow}>
        <Text variant="bodyMedium" color="onSurfaceVariant">
          {t("auth.signUp.haveAccount")}
        </Text>
        <Button
          kind="text"
          label={t("common.action.signIn")}
          onPress={() => navigate({ _tag: "SignIn", ...(returnTo === null ? {} : { returnTo }) })}
          testID="sign-up-to-signin"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
  },
});
