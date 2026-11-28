import { InvitationToken } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { describeError } from "@kvitbit/ui-port/api";
import { enumText } from "@kvitbit/ui-port/i18n";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { useMemo, useState } from "react";
import { useI18n } from "../../i18n/i18n-provider";
import { hrefOf, navigate } from "../../navigation/routes";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { useSession } from "../../session/session-provider";
import { Banner, Button, Card, EmptyState, RemoteView, Screen, Text } from "../../ui";
import { lastWorkspace } from "../../workspace/last-workspace";
import { runFeatureEffect } from "../ui-effect";
import type { AuthClient } from "./auth-port";
import { useAuthClient } from "./use-auth-client";

export function InviteScreen(props: { readonly token: string; readonly authClient?: AuthClient }) {
  const { t, text } = useI18n();
  const session = useSession();
  const api = useApi();
  const contextAuth = useAuthClient();
  const auth = props.authClient ?? contextAuth;

  const token = Schema.decodeOption(InvitationToken)(props.token).pipe(Option.getOrNull);
  const invitation = useRemote(
    useMemo(
      () =>
        token !== null
          ? (client: KvitbitApiClient) => client.invitations.peek({ params: { token } })
          : null,
      [token],
    ),
  );

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (token === null) {
    return (
      <Screen title={t("invitation.landing.notFound")}>
        <EmptyState
          title={t("invitation.landing.notFound")}
          action={{
            label: t("common.action.goHome"),
            onPress: () => navigate({ _tag: "SignIn" }, { replace: true }),
          }}
        />
      </Screen>
    );
  }

  const handleAccept = () =>
    runFeatureEffect(
      Effect.gen(function* () {
        setBusy(true);
        setActionError(null);
        const res = yield* Effect.promise(() =>
          api.run((client) => client.invitations.accept({ params: { token } })),
        );
        setBusy(false);
        if (res._tag === "Ok") {
          yield* Effect.promise(() => lastWorkspace.write(res.value.slug));
          navigate({ _tag: "Dashboard", ws: res.value.slug }, { replace: true });
          return;
        }
        setActionError(text(describeError(res.error).text));
      }),
    );

  const handleSignOutAndContinue = () =>
    runFeatureEffect(
      Effect.gen(function* () {
        setBusy(true);
        yield* Effect.promise(() => auth.signOut());
        setBusy(false);
      }),
    );

  return (
    <Screen title={t("app.name")}>
      <RemoteView state={invitation.state} onRetry={invitation.reload}>
        {(peek) => {
          if (peek.status === "expired") {
            return <EmptyState title={t("invitation.landing.expired")} />;
          }
          if (peek.status === "revoked") {
            return <EmptyState title={t("invitation.landing.revoked")} />;
          }
          if (peek.status === "accepted") {
            return (
              <EmptyState
                title={t("invitation.landing.accepted")}
                action={{
                  label: t("invitation.landing.open"),
                  onPress: () => navigate({ _tag: "SignIn" }, { replace: true }),
                }}
              />
            );
          }

          const signedInUser = session.state.status === "signed-in" ? session.state.user : null;
          const emailMatches =
            signedInUser !== null &&
            Str.toLowerCase(signedInUser.email) === Str.toLowerCase(peek.email);
          const roleLabel = text(enumText({ name: "role", value: peek.role }));

          return (
            <Card>
              <Text variant="titleLarge">
                {t("invitation.landing.title", { workspace: peek.workspaceName })}
              </Text>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                {t("invitation.landing.body", {
                  inviter: peek.inviterName,
                  workspace: peek.workspaceName,
                  role: roleLabel,
                })}
              </Text>

              {actionError === null ? null : <Banner tone="error" text={actionError} />}

              {signedInUser === null ? (
                <>
                  <Button
                    label={t("invitation.landing.signUpToAccept")}
                    onPress={() => navigate({ _tag: "SignUp", invitation: props.token })}
                    testID="invite-signup"
                  />
                  <Button
                    kind="tonal"
                    label={t("invitation.landing.signInToAccept")}
                    onPress={() =>
                      navigate({
                        _tag: "SignIn",
                        returnTo: hrefOf({ _tag: "Invitation", token: props.token }),
                      })
                    }
                    testID="invite-signin"
                  />
                </>
              ) : emailMatches ? (
                <Button
                  label={t("invitation.landing.accept")}
                  onPress={() => {
                    handleAccept();
                  }}
                  busy={busy}
                  testID="invite-accept"
                />
              ) : (
                <>
                  <Banner
                    tone="warning"
                    text={t("invitation.landing.wrongAccount", { email: peek.email })}
                  />
                  <Button
                    kind="tonal"
                    label={t("common.action.signOut")}
                    onPress={() => {
                      handleSignOutAndContinue();
                    }}
                    busy={busy}
                    testID="invite-signout"
                  />
                </>
              )}
            </Card>
          );
        }}
      </RemoteView>
    </Screen>
  );
}
