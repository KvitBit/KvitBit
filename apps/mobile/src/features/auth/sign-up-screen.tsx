import { InvitationToken } from "@kvitbit/domain/contract";
import { describeError, UiError } from "@kvitbit/ui-port/api";
import type { Locale } from "@kvitbit/ui-port/i18n";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { passkeyBridge } from "../../platform/passkeys/passkey-bridge";
import { useSession } from "../../session/session-provider";
import { tokenStore } from "../../session/token-store";
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
import { lastWorkspace } from "../../workspace/last-workspace";
import { forkFeatureEffect, runFeatureEffect } from "../ui-effect";
import { acceptInvitedSignup } from "./accept-invited-signup";
import { checkEmailHref, inviteReturnTo } from "./auth-links";
import type { AuthClient, AuthSession } from "./auth-port";
import { BotProofWidget } from "./bot-proof-widget";
import { CheckEmailScreen } from "./check-email-screen";
import { useAuthClient } from "./use-auth-client";
import { useBotProof } from "./use-bot-proof";

const MIN_PASSWORD_LENGTH = 10;
type SignupMethod = "password" | "passkey";

type SignUpErrors = Partial<Record<"name" | "email" | "password" | "terms", string>>;

export function SignUpScreen(props: {
  readonly invitation?: string;
  readonly lockedEmail?: string;
  readonly authClient?: AuthClient;
}) {
  const { t, text, locale, setLocale, local } = useI18n();
  const contextAuth = useAuthClient();
  const auth = props.authClient ?? contextAuth;
  const { origin } = useSession();

  const [name, setName] = useState("");
  const [email, setEmail] = useState(props.lockedEmail ?? "");
  const [password, setPassword] = useState("");
  const [method, setMethod] = useState<SignupMethod>("password");
  const [passkeyEmail, setPasskeyEmail] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [fieldErrors, setFieldErrors] = useState<SignUpErrors>({});
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [invitedAccount, setInvitedAccount] = useState<AuthSession | null>(null);

  const scope =
    props.invitation !== undefined
      ? "invitation_accept"
      : method === "passkey"
        ? "magic_link"
        : "sign_up";
  const bot = useBotProof({ scope, initial: "auto" });
  const returnTo = inviteReturnTo(props.invitation);

  const joinInvitation = Effect.fn("joinInvitation")(function* (
    rawToken: string,
    account: AuthSession,
  ) {
    setBusy(true);
    setErrorBanner(null);
    const token = Schema.decodeOption(InvitationToken)(rawToken);
    if (token._tag === "None") {
      setErrorBanner(t("auth.genericError"));
      setBusy(false);
      return;
    }
    yield* Effect.gen(function* () {
      const joined = yield* Effect.promise(() =>
        acceptInvitedSignup({
          origin,
          locale,
          token: token.value,
          bearer: tokenStore.usesBearer ? account.token : null,
        }),
      );
      if (joined._tag === "Err") {
        setErrorBanner(text(describeError(joined.error).text));
        return;
      }
      yield* Effect.promise(() => lastWorkspace.write(joined.value.slug));
      navigate({ _tag: "Dashboard", ws: joined.value.slug }, { replace: true });
    }).pipe(
      Effect.catchCause(() => Effect.sync(() => setErrorBanner(t("auth.genericError")))),
      Effect.ensuring(Effect.sync(() => setBusy(false))),
    );
  });

  const sendPasskeyLink = (address: string) =>
    runFeatureEffect(
      Effect.gen(function* () {
        const fresh = yield* Effect.promise(() => bot.ensureFresh());
        if (fresh._tag === "Failed") return { _tag: "Err" as const, error: fresh.error };
        if (fresh._tag !== "Solved" && fresh._tag !== "NotRequired")
          return { _tag: "Err" as const, error: UiError.offline };
        const result = yield* Effect.promise(() =>
          auth.sendMagicLink(
            address,
            fresh._tag === "Solved" ? fresh.payload : null,
            "/passkey-setup",
            { name: Str.trim(name), locale },
          ),
        );
        if (
          result._tag === "Ok" ||
          (result._tag === "Err" && result.error._tag === "InvalidBotProof")
        )
          bot.restart();
        return result;
      }),
    );

  const handleSubmit = () =>
    runFeatureEffect(
      Effect.gen(function* () {
        if (busy) return;
        const trimmedEmail = Str.trim(props.lockedEmail ?? email);
        const trimmedName = Str.trim(name);
        const nextErrors: SignUpErrors = {};

        if (trimmedName.length === 0) nextErrors.name = t("issue.form.required");
        if (!Str.includes("@")(trimmedEmail)) nextErrors.email = t("issue.form.email_invalid");
        if (method === "password" && password.length < MIN_PASSWORD_LENGTH) {
          nextErrors.password = t("issue.form.password_too_short", { min: MIN_PASSWORD_LENGTH });
        }
        if (!acceptedTerms) nextErrors.terms = t("issue.form.terms_required");

        if (!Rec.isEmptyReadonlyRecord<string, string | undefined>(nextErrors)) {
          setFieldErrors(nextErrors);
          setErrorBanner(nextErrors.terms ?? null);
          return;
        }

        setFieldErrors({});
        setErrorBanner(null);
        setBusy(true);

        if (method === "passkey") {
          if ((yield* Effect.promise(() => passkeyBridge.availability())) === "unavailable") {
            setBusy(false);
            setErrorBanner(t("auth.passkey.unsupported"));
            return;
          }
          const res = yield* Effect.promise(() => sendPasskeyLink(trimmedEmail));
          setBusy(false);
          if (res._tag === "Ok") setPasskeyEmail(trimmedEmail);
          else if (res._tag === "Err") setErrorBanner(text(describeError(res.error).text));
          return;
        }
        const fresh = yield* Effect.promise(() => bot.ensureFresh());
        if (fresh._tag === "Failed") {
          setBusy(false);
          setErrorBanner(t("auth.botProof.failed"));
          return;
        }
        const proof = fresh._tag === "Solved" ? fresh.payload : null;
        const res = yield* Effect.promise(() =>
          auth.signUpEmail(
            {
              email: trimmedEmail,
              password,
              name: trimmedName,
              locale,
              invitation: props.invitation,
            },
            proof,
          ),
        );
        setBusy(false);

        if (res._tag === "Ok") {
          const { invitation } = props;
          if (invitation !== undefined) {
            const account = res.value;
            if (account === null) {
              setErrorBanner(t("auth.genericError"));
              return;
            }
            setInvitedAccount(account);
            yield* joinInvitation(invitation, account);
            return;
          }
          router.push(checkEmailHref(trimmedEmail, returnTo));
          return;
        }
        if (res._tag === "Cancelled") return;

        if (res.error._tag === "InvalidBotProof") bot.restart();
        const described = describeError(res.error);
        setErrorBanner(text(described.text));
      }),
    );

  if (props.invitation !== undefined && invitedAccount !== null) {
    const invitation = props.invitation;
    return (
      <Screen title={t("app.name")}>
        {errorBanner === null ? null : <Banner tone="error" text={errorBanner} />}
        <Button
          label={t("invitation.landing.accept")}
          onPress={() => {
            forkFeatureEffect(joinInvitation(invitation, invitedAccount));
          }}
          busy={busy}
          testID="invited-signup-join"
        />
      </Screen>
    );
  }

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
          error={fieldErrors.name ?? null}
          autoComplete="name"
          disabled={busy}
          testID="sign-up-name"
        />

        <TextField
          label={t("common.field.email")}
          value={props.lockedEmail ?? email}
          onChangeText={setEmail}
          error={fieldErrors.email ?? null}
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
            error={fieldErrors.password ?? null}
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

        <BotProofWidget
          state={bot.state}
          onRetry={() => {
            bot.restart();
          }}
        />

        <Button
          label={bot.busy ? t("auth.botProof.verifying") : t("auth.signUp.submit")}
          onPress={() => {
            handleSubmit();
          }}
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
          onPress={() =>
            navigate(returnTo === null ? { _tag: "SignIn" } : { _tag: "SignIn", returnTo })
          }
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
