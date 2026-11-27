import { describeError, type UiError } from "@kvitbit/ui-port/api";
import { router } from "expo-router";
import { KeyRound, Mail } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { safeReturnTo } from "../../navigation/return-to";
import { navigate } from "../../navigation/routes";
import { Banner, Button, Card, Screen, SegmentedChoice, space, Text, TextField } from "../../ui";
import { checkEmailHref } from "./auth-links";
import type { AuthClient } from "./auth-port";
import { BotProofWidget } from "./bot-proof-widget";
import { useAuthClient } from "./use-auth-client";
import { useBotProof } from "./use-bot-proof";

type SignInMode = "password" | "magic_link";

export { safeReturnTo } from "../../navigation/return-to";

const hasIssueCode = (error: UiError, code: string): boolean =>
  error._tag === "Invalid" && error.issues.some((i) => i.code === code);

export function SignInScreen(props: {
  readonly returnTo?: string;
  readonly emailVerified?: boolean;
  readonly authClient?: AuthClient;
}) {
  const { t, text } = useI18n();
  const contextAuth = useAuthClient();
  const auth = props.authClient ?? contextAuth;
  const returnTo = safeReturnTo(props.returnTo);

  const [mode, setMode] = useState<SignInMode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [failures, setFailures] = useState(0);

  const signInBot = useBotProof("sign_in", { initial: "idle" });
  const magicBot = useBotProof("magic_link", { initial: mode === "magic_link" ? "auto" : "idle" });
  const activeBot = mode === "password" ? signInBot : magicBot;

  const afterSignedIn = () => {
    if (returnTo !== null) router.replace(returnTo as never);
    else router.replace("/" as never);
  };

  const handlePasswordSubmit = async () => {
    const trimmed = email.trim();
    if (trimmed.length === 0 || password.length === 0) {
      setErrorBanner(t("error.invalid"));
      return;
    }
    setBusy(true);
    setErrorBanner(null);

    let proof: string | null = signInBot.payload;
    if (signInBot.state._tag !== "NotRequired") {
      const fresh = await signInBot.ensureFresh();
      if (fresh._tag === "Solved") proof = fresh.payload;
      else if (fresh._tag === "Failed") {
        setBusy(false);
        setErrorBanner(t("auth.botProof.failed"));
        return;
      }
    }

    const res = await auth.signInEmail({ email: trimmed, password }, proof);
    setBusy(false);

    if (res._tag === "Ok") {
      afterSignedIn();
      return;
    }
    if (res._tag === "Cancelled") return;

    if (hasIssueCode(res.error, "auth.email_not_verified")) {
      router.push(checkEmailHref(trimmed, returnTo) as never);
      return;
    }
    const nextFailures = failures + 1;
    setFailures(nextFailures);
    if (
      res.error._tag === "InvalidBotProof" ||
      hasIssueCode(res.error, "auth.bot_proof_required") ||
      nextFailures >= 3
    ) {
      void signInBot.restart();
    }
    setErrorBanner(text(describeError(res.error).text));
  };

  const handleMagicLinkSubmit = async () => {
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      setErrorBanner(t("issue.form.email_invalid"));
      return;
    }
    setBusy(true);
    setErrorBanner(null);
    const fresh = await magicBot.ensureFresh();
    if (fresh._tag === "Failed") {
      setBusy(false);
      setErrorBanner(t("auth.botProof.failed"));
      return;
    }
    const proof = fresh._tag === "Solved" ? fresh.payload : null;
    const res = await auth.sendMagicLink(trimmed, proof, returnTo);
    setBusy(false);

    if (res._tag === "Ok") {
      setMagicSent(true);
      return;
    }
    if (res._tag === "Cancelled") return;
    if (res.error._tag === "InvalidBotProof") void magicBot.restart();
    setErrorBanner(text(describeError(res.error).text));
  };

  const handlePasskey = async () => {
    setBusy(true);
    setErrorBanner(null);
    const res = await auth.passkeySignIn();
    setBusy(false);
    if (res._tag === "Ok") {
      afterSignedIn();
      return;
    }
    // Flow 1.5: cancelling the passkey prompt returns quietly with no error banner.
    if (res._tag === "Cancelled") return;
    setErrorBanner(text(describeError(res.error).text));
  };

  return (
    <Screen title={t("auth.signIn.title")}>
      {props.emailVerified === true ? <Banner tone="info" text={t("auth.link.verified")} /> : null}
      {errorBanner === null ? null : <Banner tone="error" text={errorBanner} />}
      {magicSent ? (
        <Banner tone="info" text={t("auth.checkEmail.body", { email: email.trim() })} />
      ) : null}

      <Card>
        <SegmentedChoice<SignInMode>
          value={mode}
          onChange={(next) => {
            setMode(next);
            setErrorBanner(null);
            setMagicSent(false);
            if (next === "magic_link") void magicBot.start();
          }}
          choices={[
            { value: "password", label: t("auth.signIn.methodPassword") },
            { value: "magic_link", label: t("auth.signIn.methodMagicLink") },
          ]}
        />

        <TextField
          label={t("common.field.email")}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          disabled={busy}
          testID="sign-in-email"
        />

        {mode === "password" ? (
          <TextField
            label={t("common.field.password")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            disabled={busy}
            testID="sign-in-password"
          />
        ) : null}

        <BotProofWidget state={activeBot.state} onRetry={() => void activeBot.restart()} />

        <Button
          label={mode === "password" ? t("auth.signIn.submit") : t("auth.signIn.sendLink")}
          onPress={() =>
            void (mode === "password" ? handlePasswordSubmit() : handleMagicLinkSubmit())
          }
          {...(mode === "magic_link" ? { icon: Mail } : {})}
          busy={busy || activeBot.busy}
          disabled={activeBot.state._tag === "Failed"}
          testID="sign-in-submit"
        />

        {mode === "password" ? (
          <Button
            kind="text"
            label={t("auth.signIn.forgotPassword")}
            onPress={() => navigate({ _tag: "ResetPassword" })}
            testID="sign-in-forgot"
          />
        ) : null}
      </Card>

      <View style={styles.dividerRow}>
        <Text variant="bodySmall" color="onSurfaceVariant">
          {t("auth.signIn.or")}
        </Text>
      </View>

      <Button
        kind="tonal"
        icon={KeyRound}
        label={t("auth.signIn.withPasskey")}
        onPress={() => void handlePasskey()}
        busy={busy}
        testID="sign-in-passkey"
      />

      <View style={styles.footerRow}>
        <Text variant="bodyMedium" color="onSurfaceVariant">
          {t("auth.signIn.noAccount")}
        </Text>
        <Button
          kind="text"
          label={t("common.action.signUp")}
          onPress={() => navigate({ _tag: "SignUp" })}
          testID="sign-in-to-signup"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  dividerRow: { alignItems: "center" },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
  },
});
