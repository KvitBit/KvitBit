import { describeError } from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/i18n-provider";
import { safeReturnTo } from "../../navigation/return-to";
import { navigate } from "../../navigation/routes";
import { Banner, Button, EmptyState, Loading, Screen } from "../../ui";
import { forkFeatureEffect } from "../ui-effect";
import { verifiedSignInHref } from "./auth-links";
import type { AuthClient } from "./auth-port";
import { useAuthClient } from "./use-auth-client";

export type AuthLinkKind = "verify" | "magic" | "reset";

export function AuthLinkScreen(props: {
  readonly kind: AuthLinkKind;
  readonly token: string;
  readonly returnTo?: string;
  readonly authClient?: AuthClient;
}) {
  const { t, text } = useI18n();
  const contextAuth = useAuthClient();
  const auth = props.authClient ?? contextAuth;
  const returnTo = safeReturnTo(props.returnTo);

  const [status, setStatus] = useState<"verifying" | "expired" | "error">("verifying");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { kind, token } = props;
  useEffect(() => {
    if (kind === "reset") {
      navigate({ _tag: "ResetPassword", token }, { replace: true });
      return;
    }
    if (token.length === 0) {
      setStatus("expired");
      return;
    }
    let live = true;
    forkFeatureEffect(
      Effect.map(
        Effect.promise(() => auth.verifyLink(kind, token)),
        (res) => {
          if (!live) return;
          if (res._tag === "Ok") {
            router.replace(res.value === null ? verifiedSignInHref(returnTo) : (returnTo ?? "/"));
            return;
          }
          if (res._tag === "Err" && res.error._tag === "NotFound") {
            setStatus("expired");
            return;
          }
          if (res._tag === "Err") {
            setStatus("error");
            setErrorMessage(text(describeError(res.error).text));
          }
        },
      ),
    );
    return () => {
      live = false;
    };
  }, [auth, kind, token, returnTo, text]);

  if (status === "verifying") {
    return (
      <Screen title={t("auth.link.verifying")}>
        <Loading label={t("auth.link.verifying")} />
      </Screen>
    );
  }

  if (status === "expired") {
    return (
      <Screen title={t("auth.link.expired.title")}>
        <EmptyState
          title={t("auth.link.expired.title")}
          body={t("auth.link.expired.body")}
          action={{
            label: t("auth.link.sendNew"),
            onPress: () => navigate({ _tag: "SignIn" }, { replace: true }),
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen title={t("common.state.error")}>
      <Banner tone="error" text={errorMessage ?? t("auth.genericError")} />
      <Button
        label={t("common.action.signIn")}
        onPress={() => navigate({ _tag: "SignIn" }, { replace: true })}
      />
    </Screen>
  );
}
