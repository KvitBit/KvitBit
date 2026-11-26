import { describeError } from "@kvitbit/ui-port/api";
import { MailCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { safeReturnTo } from "../../navigation/return-to";
import { navigate } from "../../navigation/routes";
import { Banner, Button, Card, Icon, Screen, space, Text, useOverlay } from "../../ui";
import type { AuthClient, AuthResult } from "./auth-port";
import { useAuthClient } from "./use-auth-client";

const RESEND_COOLDOWN_SECONDS = 60;

export function CheckEmailScreen(props: {
  readonly email: string;
  readonly initialCooldown?: number;
  readonly returnTo?: string;
  readonly resend?: () => Promise<AuthResult<void>>;
  readonly onWrongEmail?: () => void;
  readonly authClient?: AuthClient;
}) {
  const { t, text } = useI18n();
  const overlay = useOverlay();
  const contextAuth = useAuthClient();
  const auth = props.authClient ?? contextAuth;

  const [cooldown, setCooldown] = useState(props.initialCooldown ?? RESEND_COOLDOWN_SECONDS);
  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleResend = async () => {
    if (cooldown > 0 || props.email.length === 0) return;
    setBusy(true);
    setErrorBanner(null);
    const res = props.resend
      ? await props.resend()
      : await auth.resendVerification(props.email, safeReturnTo(props.returnTo));
    setBusy(false);

    if (res._tag === "Ok") {
      setCooldown(RESEND_COOLDOWN_SECONDS);
      overlay.toast(t("auth.checkEmail.resent"));
      return;
    }
    if (res._tag === "Cancelled") return;
    setErrorBanner(text(describeError(res.error).text));
  };

  return (
    <Screen title={t("auth.checkEmail.title")} back>
      {errorBanner === null ? null : <Banner tone="error" text={errorBanner} />}
      <Card>
        <View style={styles.iconRow}>
          <Icon icon={MailCheck} size={32} color="primary" />
        </View>
        <Text variant="bodyLarge" align="center">
          {t("auth.checkEmail.body", { email: props.email })}
        </Text>
        <Button
          label={
            cooldown > 0
              ? t("auth.checkEmail.resendIn", { seconds: cooldown })
              : t("auth.checkEmail.resend")
          }
          onPress={() => void handleResend()}
          disabled={cooldown > 0 || props.email.length === 0}
          busy={busy}
          testID="check-email-resend"
        />
        <Button
          kind="text"
          label={t("auth.checkEmail.wrongEmail")}
          onPress={props.onWrongEmail ?? (() => navigate({ _tag: "SignIn" }, { replace: true }))}
          testID="check-email-back"
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconRow: { alignItems: "center", paddingVertical: space.sm },
});
