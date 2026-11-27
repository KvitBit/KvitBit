import { describeError } from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import { Redirect, router } from "expo-router";
import { useState } from "react";
import { useAuthClient } from "../src/features/auth/use-auth-client";
import { forkFeatureEffect } from "../src/features/ui-effect";
import { useI18n } from "../src/i18n/i18n-provider";
import { hrefOf } from "../src/navigation/routes";
import { useSession } from "../src/session/session-provider";
import { Banner, Button, Card, Screen, Text } from "../src/ui";

export default function PasskeySetupRoute() {
  const auth = useAuthClient();
  const { state: session } = useSession();
  const { t, text } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.status !== "signed-in" || !session.user.emailVerified) {
    return <Redirect href={hrefOf({ _tag: "SignIn", returnTo: "/passkey-setup" })} />;
  }

  const addPasskey = () => {
    if (busy === true) return;
    setBusy(true);
    setError(null);
    forkFeatureEffect(
      Effect.map(
        Effect.promise(() => auth.passkeyAdd(t("app.name"))),
        (result) => {
          setBusy(false);
          if (result._tag === "Ok") router.replace("/");
          else if (result._tag === "Err") setError(text(describeError(result.error).text));
        },
      ),
    );
  };

  return (
    <Screen title={t("account.security.addPasskey")}>
      {error === null ? null : <Banner tone="error" text={error} />}
      <Card>
        <Text variant="bodyMedium">{session.user.email}</Text>
        <Text variant="bodyMedium">{t("auth.passkey.prompt")}</Text>
        <Button label={t("account.security.addPasskey")} onPress={addPasskey} busy={busy} />
      </Card>
    </Screen>
  );
}
