import { describeError } from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { useState } from "react";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { Banner, Button, Card, EmptyState, Screen, Text, TextField } from "../../ui";
import { runFeatureEffect } from "../ui-effect";
import type { AuthClient } from "./auth-port";
import { BotProofWidget } from "./bot-proof-widget";
import { useAuthClient } from "./use-auth-client";
import { useBotProof } from "./use-bot-proof";

const MIN_PASSWORD_LENGTH = 10;

export function ResetPasswordScreen(props: {
  readonly token?: string;
  readonly authClient?: AuthClient;
}) {
  const { t, text } = useI18n();
  const contextAuth = useAuthClient();
  const auth = props.authClient ?? contextAuth;
  const hasToken = props.token !== undefined && props.token.length > 0;

  // Request mode state
  const [email, setEmail] = useState("");
  const [requested, setRequested] = useState(false);

  // Confirm mode state
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [done, setDone] = useState(false);
  const [expired, setExpired] = useState(false);

  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const bot = useBotProof({ scope: "password_reset", initial: hasToken ? "idle" : "auto" });

  const handleRequest = () =>
    runFeatureEffect(
      Effect.gen(function* () {
        const trimmed = Str.trim(email);
        if (!Str.includes("@")(trimmed)) {
          setFieldError(t("issue.form.email_invalid"));
          return;
        }
        setFieldError(null);
        setErrorBanner(null);
        setBusy(true);
        const fresh = yield* Effect.promise(() => bot.ensureFresh());
        if (fresh._tag === "Failed") {
          setBusy(false);
          setErrorBanner(t("auth.botProof.failed"));
          return;
        }
        const proof = fresh._tag === "Solved" ? fresh.payload : null;
        const res = yield* Effect.promise(() => auth.requestPasswordReset(trimmed, proof));
        setBusy(false);
        if (res._tag === "Ok") {
          setRequested(true);
          return;
        }
        if (res._tag === "Cancelled") return;
        if (res.error._tag === "InvalidBotProof") bot.restart();
        setErrorBanner(text(describeError(res.error).text));
      }),
    );

  const handleReset = () =>
    runFeatureEffect(
      Effect.gen(function* () {
        if (password.length < MIN_PASSWORD_LENGTH) {
          setFieldError(t("issue.form.password_too_short", { min: MIN_PASSWORD_LENGTH }));
          return;
        }
        if (password !== confirmPassword) {
          setFieldError(t("issue.form.password_mismatch"));
          return;
        }
        setFieldError(null);
        setErrorBanner(null);
        setBusy(true);
        const res = yield* Effect.promise(() => auth.resetPassword(props.token ?? "", password));
        setBusy(false);

        if (res._tag === "Ok") {
          setDone(true);
          return;
        }
        if (res._tag === "Cancelled") return;
        if (res.error._tag === "NotFound") {
          setExpired(true);
          return;
        }
        setErrorBanner(text(describeError(res.error).text));
      }),
    );

  if (expired === true) {
    return (
      <Screen title={t("auth.resetPassword.title")} back>
        <EmptyState
          title={t("auth.link.expired.title")}
          body={t("auth.link.expired.body")}
          action={{
            label: t("auth.link.sendNew"),
            onPress: () => navigate({ _tag: "ResetPassword" }, { replace: true }),
          }}
        />
      </Screen>
    );
  }

  if (done === true) {
    return (
      <Screen title={t("auth.resetPassword.title")}>
        <Banner tone="info" text={t("auth.resetPassword.done")} />
        <Button
          label={t("common.action.signIn")}
          onPress={() => navigate({ _tag: "SignIn" }, { replace: true })}
          testID="reset-password-to-signin"
        />
      </Screen>
    );
  }

  return (
    <Screen title={t("auth.resetPassword.title")} back>
      {errorBanner === null ? null : <Banner tone="error" text={errorBanner} />}
      {hasToken ? (
        <Card>
          <TextField
            label={t("auth.resetPassword.newPassword")}
            value={password}
            onChangeText={setPassword}
            supporting={t("auth.signUp.passwordHint")}
            secureTextEntry
            disabled={busy}
            testID="reset-password-new"
          />
          <TextField
            label={t("auth.resetPassword.confirmPassword")}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            error={fieldError}
            secureTextEntry
            disabled={busy}
            testID="reset-password-confirm"
          />
          <Button
            label={t("auth.resetPassword.submit")}
            onPress={() => {
              handleReset();
            }}
            busy={busy}
            testID="reset-password-submit"
          />
        </Card>
      ) : requested === true ? (
        <Card>
          <Banner tone="info" text={t("auth.checkEmail.body", { email: Str.trim(email) })} />
          <Button
            kind="tonal"
            label={t("common.action.signIn")}
            onPress={() => navigate({ _tag: "SignIn" }, { replace: true })}
          />
        </Card>
      ) : (
        <Card>
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {t("auth.resetPassword.requestBody")}
          </Text>
          <TextField
            label={t("common.field.email")}
            value={email}
            onChangeText={setEmail}
            error={fieldError}
            keyboardType="email-address"
            autoCapitalize="none"
            disabled={busy}
            testID="reset-password-email"
          />
          <BotProofWidget
            state={bot.state}
            onRetry={() => {
              bot.restart();
            }}
          />
          <Button
            label={t("auth.resetPassword.send")}
            onPress={() => {
              handleRequest();
            }}
            busy={busy === true || bot.busy}
            disabled={bot.state._tag === "Failed"}
            testID="reset-password-send"
          />
        </Card>
      )}
    </Screen>
  );
}
