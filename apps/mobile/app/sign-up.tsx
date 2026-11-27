import { InvitationToken } from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";
import { useLocalSearchParams } from "expo-router";
import { SignUpScreen } from "../src/features/auth/sign-up-screen";
import { useI18n } from "../src/i18n/i18n-provider";
import { param } from "../src/navigation/routes";
import { useRemote } from "../src/runtime/api-runtime";
import { EmptyState, RemoteView, Screen } from "../src/ui";

function InvitedSignUp({ token }: { readonly token: InvitationToken }) {
  const { t } = useI18n();
  const invite = useRemote((api) => api.invitations.peek({ params: { token } }), [token]);
  return (
    <RemoteView state={invite.state} onRetry={invite.reload}>
      {(value) =>
        value.status === "pending" ? (
          <SignUpScreen invitation={token} lockedEmail={value.email} />
        ) : (
          <Screen title={t("app.name")}>
            <EmptyState title={t(`invitation.landing.${value.status}`)} />
          </Screen>
        )
      }
    </RemoteView>
  );
}

export default function SignUpRoute() {
  const params = useLocalSearchParams<{
    readonly invitation?: string | string[];
  }>();
  const invitation = Schema.decodeUnknownOption(InvitationToken)(param(params.invitation));
  return invitation._tag === "None" ? (
    <SignUpScreen />
  ) : (
    <InvitedSignUp key={invitation.value} token={invitation.value} />
  );
}
