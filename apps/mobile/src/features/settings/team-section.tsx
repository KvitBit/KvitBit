import type { InvitationView, MemberView } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { idempotencyHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { router } from "expo-router";
import { MailPlus, RefreshCw, Trash2, UserMinus } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { runRequestIntent } from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";
import {
  Badge,
  Banner,
  Button,
  Card,
  RemoteView,
  Section,
  SegmentedChoice,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { requestOwner } from "../request-owner";
import { forkFeatureEffect } from "../ui-effect";
import {
  canLeaveWorkspace,
  canManageInvitations,
  canManageMember,
  type InvitationRole,
  invitableRolesFor,
} from "./permissions";
import {
  type FormErrorState,
  fieldErrorText,
  formErrorFrom,
  noFormError,
} from "./settings-feedback";

/** Settings -> Team (flows 2.4, 2.6, 2.7): members, role changes, invitations, leave workspace. */
export function TeamSection() {
  const { workspace, reload: reloadWorkspaces } = useWorkspace();
  const session = useSession();
  const api = useApi();
  const i18n = useI18n();
  const { t } = i18n;
  const overlay = useOverlay();

  const currentUserId = session.state.status === "signed-in" ? session.state.user.id : null;
  const canInvite = canManageInvitations(workspace.role, workspace.closed);
  const invitableRoles = invitableRolesFor(workspace.role);

  const membersRemote = useRemote(
    useCallback(
      (client: KvitbitApiClient) => client.team.listMembers({ params: inWorkspace(workspace.id) }),
      [workspace.id],
    ),
  );
  const invitationsRemote = useRemote(
    useMemo(
      () =>
        canInvite
          ? (client: KvitbitApiClient) =>
              client.team.listInvitations({ params: inWorkspace(workspace.id) })
          : null,
      [workspace.id, canInvite],
    ),
  );

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole>("member");
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  const handleInvite = Effect.fn("team-section.handleInvite")(function* () {
    if (!canInvite || currentUserId === null || inviting === true) return;
    const email = Str.trim(inviteEmail);
    if (email === "") return;
    const owner = requestOwner([api.origin, currentUserId, workspace.id]);
    if (owner === null) return;
    setInviting(true);
    setErrorState(noFormError);
    const payload = { email, role: inviteRole };
    const result = yield* Effect.promise(() =>
      runRequestIntent(owner, "workspace/invite", payload, (key) =>
        api.run((client) =>
          client.team.invite({
            params: inWorkspace(workspace.id),
            headers: idempotencyHeaders(key),
            payload,
          }),
        ),
      ),
    );
    setInviting(false);
    if (result._tag === "Ok") {
      setInviteEmail("");
      invitationsRemote.reload();
      overlay.toast(t("settings.team.inviteSent", { email }));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  const handleSetRole = Effect.fn("team-section.handleSetRole")(function* (
    member: MemberView,
    role: InvitationRole,
  ) {
    if (member.role === role) return;
    setBusyId(member.userId);
    setErrorState(noFormError);
    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.team.setRole({
          params: inWorkspace(workspace.id, { userId: member.userId }),
          payload: { role },
        }),
      ),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      membersRemote.reload();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  const handleRemoveMember = Effect.fn("team-section.handleRemoveMember")(function* (
    member: MemberView,
  ) {
    const confirmed = yield* Effect.promise(() =>
      overlay.confirm({
        title: t("settings.team.removeTitle", { name: member.name }),
        body: t("settings.team.removeBody"),
        confirmLabel: t("settings.team.remove"),
        cancelLabel: t("common.action.cancel"),
        destructive: true,
      }),
    );
    if (!confirmed) return;
    setBusyId(member.userId);
    setErrorState(noFormError);
    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.team.removeMember({
          params: inWorkspace(workspace.id, { userId: member.userId }),
        }),
      ),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      membersRemote.reload();
      overlay.toast(t("common.toast.deleted"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  const handleResendInvitation = Effect.fn("team-section.handleResendInvitation")(function* (
    inv: InvitationView,
  ) {
    setBusyId(inv.id);
    setErrorState(noFormError);
    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.team.resendInvitation({
          params: inWorkspace(workspace.id, { invitationId: inv.id }),
        }),
      ),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      invitationsRemote.reload();
      overlay.toast(t("settings.team.inviteSent", { email: inv.email }));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  const handleRevokeInvitation = Effect.fn("team-section.handleRevokeInvitation")(function* (
    inv: InvitationView,
  ) {
    setBusyId(inv.id);
    setErrorState(noFormError);
    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.team.revokeInvitation({
          params: inWorkspace(workspace.id, { invitationId: inv.id }),
        }),
      ),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      invitationsRemote.reload();
      overlay.toast(t("common.toast.deleted"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  const handleLeave = Effect.fn("team-section.handleLeave")(function* () {
    if (!canLeaveWorkspace(workspace.role)) return;
    const confirmed = yield* Effect.promise(() =>
      overlay.confirm({
        title: t("settings.team.leaveTitle", { workspace: workspace.name }),
        body: t("settings.team.leaveBody"),
        confirmLabel: t("settings.team.leave"),
        cancelLabel: t("common.action.cancel"),
        destructive: true,
      }),
    );
    if (!confirmed) return;
    setBusyId("leave");
    setErrorState(noFormError);
    const result = yield* Effect.promise(() =>
      api.run((client) => client.team.leave({ params: inWorkspace(workspace.id) })),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      reloadWorkspaces();
      router.replace("/");
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  return (
    <View className="gap-4">
      {canInvite ? null : <Banner text={t("settings.readOnly")} tone="info" />}
      {errorState.banner === null ? null : <Banner text={errorState.banner} tone="error" />}

      {canInvite ? (
        <Section title={t("settings.team.invite")}>
          <Card>
            <TextField
              label={t("settings.team.inviteEmail")}
              value={inviteEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              error={fieldErrorText(errorState, ["email"], i18n)}
              onChangeText={setInviteEmail}
            />
            <SegmentedChoice<InvitationRole>
              label={t("settings.team.inviteRole")}
              value={inviteRole}
              choices={Arr.map(invitableRoles, (r) => ({ value: r, label: t(`enum.role.${r}`) }))}
              onChange={setInviteRole}
            />
            <Text variant="meta" color="onSurfaceVariant">
              {t(`enum.roleHint.${inviteRole}`)}
            </Text>
            <Button
              testID="team-invite-submit"
              kind="filled"
              icon={MailPlus}
              label={t("settings.team.invite")}
              busy={inviting}
              disabled={Str.trim(inviteEmail) === ""}
              onPress={() => forkFeatureEffect(handleInvite())}
            />
          </Card>
        </Section>
      ) : null}

      <Section title={t("settings.team.members")}>
        <RemoteView state={membersRemote.state} onRetry={membersRemote.reload}>
          {(members) => (
            <View className="gap-4">
              {Arr.map(members, (member) => {
                const isSelf = currentUserId !== null && member.userId === currentUserId;
                const manageable =
                  !isSelf && canManageMember(workspace.role, member.role, workspace.closed);
                return (
                  <Card key={member.userId}>
                    <View className="flex-row flex-wrap items-center gap-2">
                      <View className="flex-1">
                        <Text variant="titleSmall">{member.name}</Text>
                        <Text variant="meta" color="onSurfaceVariant">
                          {member.email}
                        </Text>
                      </View>
                      {isSelf ? <Badge label={t("settings.team.you")} tone="info" /> : null}
                      <Badge label={t(`enum.role.${member.role}`)} tone="neutral" />
                    </View>
                    {manageable ? (
                      <View className="gap-2 pt-1">
                        <SegmentedChoice<InvitationRole>
                          label={t("settings.team.changeRole")}
                          value={member.role === "owner" ? null : member.role}
                          choices={Arr.map(invitableRoles, (r) => ({
                            value: r,
                            label: t(`enum.role.${r}`),
                          }))}
                          onChange={(nextRole) =>
                            forkFeatureEffect(handleSetRole(member, nextRole))
                          }
                        />
                        <Button
                          kind="text"
                          icon={UserMinus}
                          label={t("settings.team.remove")}
                          busy={busyId === member.userId}
                          onPress={() => forkFeatureEffect(handleRemoveMember(member))}
                        />
                      </View>
                    ) : null}
                  </Card>
                );
              })}
            </View>
          )}
        </RemoteView>
      </Section>

      {canInvite ? (
        <Section title={t("settings.team.invitations")}>
          <RemoteView state={invitationsRemote.state} onRetry={invitationsRemote.reload}>
            {(invitations) =>
              invitations.length === 0 ? (
                <Card>
                  <Text variant="meta" color="onSurfaceVariant">
                    {t("common.state.empty")}
                  </Text>
                </Card>
              ) : (
                <View className="gap-4">
                  {Arr.map(invitations, (inv) => (
                    <Card key={inv.id}>
                      <View className="flex-row flex-wrap items-center gap-2">
                        <View className="flex-1">
                          <Text variant="titleSmall">{inv.email}</Text>
                          <Text variant="meta" color="onSurfaceVariant">
                            {t("settings.team.invitedBy", { name: inv.invitedBy.name })} ·{" "}
                            {t("settings.team.expiresOn", {
                              date: Str.slice(0, 10)(inv.expiresAt),
                            })}
                          </Text>
                        </View>
                        <Badge label={t(`enum.role.${inv.role}`)} tone="neutral" />
                        <Badge
                          label={t(`enum.invitationStatus.${inv.status}`)}
                          tone={inv.status === "pending" ? "info" : "warning"}
                        />
                      </View>
                      {inv.status === "pending" ? (
                        <View className="flex-row flex-wrap items-center gap-2">
                          <Button
                            kind="outlined"
                            icon={RefreshCw}
                            label={t("settings.team.resend")}
                            busy={busyId === inv.id}
                            onPress={() => forkFeatureEffect(handleResendInvitation(inv))}
                          />
                          <Button
                            kind="text"
                            icon={Trash2}
                            label={t("settings.team.revoke")}
                            busy={busyId === inv.id}
                            onPress={() => forkFeatureEffect(handleRevokeInvitation(inv))}
                          />
                        </View>
                      ) : null}
                    </Card>
                  ))}
                </View>
              )
            }
          </RemoteView>
        </Section>
      ) : null}

      <Section title={t("settings.team.leave")}>
        <Card>
          {canLeaveWorkspace(workspace.role) ? (
            <Button
              testID="team-leave-button"
              kind="danger"
              label={t("settings.team.leave")}
              busy={busyId === "leave"}
              onPress={() => forkFeatureEffect(handleLeave())}
            />
          ) : (
            <Text variant="meta" color="onSurfaceVariant">
              {t("settings.team.lastOwner")}
            </Text>
          )}
        </Card>
      </Section>
    </View>
  );
}
