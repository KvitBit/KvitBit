import type { IdempotencyKey } from "@kvitbit/api-contract";
import type { InvitationId, InvitationView, MemberView } from "@kvitbit/domain/contract";
import { idempotencyHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import { router } from "expo-router";
import { MailPlus, RefreshCw, Trash2, UserMinus } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { useSession } from "../../session/session-provider";
import {
  Badge,
  Banner,
  Button,
  Card,
  RemoteView,
  Section,
  SegmentedChoice,
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import {
  canLeaveWorkspace,
  canManageInvitations,
  canManageMember,
  type InvitationRole,
  invitableRolesFor,
} from "./permissions";
import { mintIdempotencyKey } from "./platform-helpers";
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
    (client) => client.team.listMembers({ params: inWorkspace(workspace.id) }),
    [workspace.id],
  );
  const invitationsRemote = useRemote(
    canInvite
      ? (client) => client.team.listInvitations({ params: inWorkspace(workspace.id) })
      : null,
    [workspace.id, canInvite],
  );

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitationRole>("member");
  const [inviteKey, setInviteKey] = useState<IdempotencyKey | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  const handleInvite = async () => {
    if (!canInvite) return;
    const email = inviteEmail.trim();
    if (email === "") return;
    setInviting(true);
    setErrorState(noFormError);
    const key = inviteKey ?? mintIdempotencyKey();
    setInviteKey(key);
    const result = await api.run((client) =>
      client.team.invite({
        params: inWorkspace(workspace.id),
        headers: idempotencyHeaders(key),
        payload: { email, role: inviteRole },
      }),
    );
    setInviting(false);
    if (result._tag === "Ok") {
      setInviteEmail("");
      setInviteKey(null);
      invitationsRemote.reload();
      overlay.toast(t("settings.team.inviteSent", { email }));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleSetRole = async (member: MemberView, role: InvitationRole) => {
    if (member.role === role) return;
    setBusyId(member.userId);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.team.setRole({
        params: inWorkspace(workspace.id, { userId: member.userId }),
        payload: { role },
      }),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      membersRemote.reload();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleRemoveMember = async (member: MemberView) => {
    const confirmed = await overlay.confirm({
      title: t("settings.team.removeTitle", { name: member.name }),
      body: t("settings.team.removeBody"),
      confirmLabel: t("settings.team.remove"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusyId(member.userId);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.team.removeMember({
        params: inWorkspace(workspace.id, { userId: member.userId }),
      }),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      membersRemote.reload();
      overlay.toast(t("common.toast.deleted"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleResendInvitation = async (inv: InvitationView) => {
    setBusyId(inv.id);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.team.resendInvitation({
        params: inWorkspace(workspace.id, { invitationId: inv.id as InvitationId }),
      }),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      invitationsRemote.reload();
      overlay.toast(t("settings.team.inviteSent", { email: inv.email }));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleRevokeInvitation = async (inv: InvitationView) => {
    setBusyId(inv.id);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.team.revokeInvitation({
        params: inWorkspace(workspace.id, { invitationId: inv.id as InvitationId }),
      }),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      invitationsRemote.reload();
      overlay.toast(t("common.toast.deleted"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleLeave = async () => {
    if (!canLeaveWorkspace(workspace.role)) return;
    const confirmed = await overlay.confirm({
      title: t("settings.team.leaveTitle", { workspace: workspace.name }),
      body: t("settings.team.leaveBody"),
      confirmLabel: t("settings.team.leave"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusyId("leave");
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.team.leave({ params: inWorkspace(workspace.id) }),
    );
    setBusyId(null);
    if (result._tag === "Ok") {
      reloadWorkspaces();
      router.replace("/");
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  return (
    <View style={styles.stack}>
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
              choices={invitableRoles.map((r) => ({ value: r, label: t(`enum.role.${r}`) }))}
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
              disabled={inviteEmail.trim() === ""}
              onPress={() => void handleInvite()}
            />
          </Card>
        </Section>
      ) : null}

      <Section title={t("settings.team.members")}>
        <RemoteView state={membersRemote.state} onRetry={membersRemote.reload}>
          {(members) => (
            <View style={styles.stack}>
              {members.map((member) => {
                const isSelf = currentUserId !== null && member.userId === currentUserId;
                const manageable =
                  !isSelf && canManageMember(workspace.role, member.role, workspace.closed);
                return (
                  <Card key={member.userId}>
                    <View style={styles.headerRow}>
                      <View style={styles.flex}>
                        <Text variant="titleSmall">{member.name}</Text>
                        <Text variant="meta" color="onSurfaceVariant">
                          {member.email}
                        </Text>
                      </View>
                      {isSelf ? <Badge label={t("settings.team.you")} tone="info" /> : null}
                      <Badge label={t(`enum.role.${member.role}`)} tone="neutral" />
                    </View>
                    {manageable ? (
                      <View style={styles.memberControls}>
                        <SegmentedChoice<InvitationRole>
                          label={t("settings.team.changeRole")}
                          value={member.role === "owner" ? null : member.role}
                          choices={invitableRoles.map((r) => ({
                            value: r,
                            label: t(`enum.role.${r}`),
                          }))}
                          onChange={(nextRole) => void handleSetRole(member, nextRole)}
                        />
                        <Button
                          kind="text"
                          icon={UserMinus}
                          label={t("settings.team.remove")}
                          busy={busyId === member.userId}
                          onPress={() => void handleRemoveMember(member)}
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
                <View style={styles.stack}>
                  {invitations.map((inv) => (
                    <Card key={inv.id}>
                      <View style={styles.headerRow}>
                        <View style={styles.flex}>
                          <Text variant="titleSmall">{inv.email}</Text>
                          <Text variant="meta" color="onSurfaceVariant">
                            {t("settings.team.invitedBy", { name: inv.invitedBy.name })} ·{" "}
                            {t("settings.team.expiresOn", { date: inv.expiresAt.slice(0, 10) })}
                          </Text>
                        </View>
                        <Badge label={t(`enum.role.${inv.role}`)} tone="neutral" />
                        <Badge
                          label={t(`enum.invitationStatus.${inv.status}`)}
                          tone={inv.status === "pending" ? "info" : "warning"}
                        />
                      </View>
                      {inv.status === "pending" ? (
                        <View style={styles.row}>
                          <Button
                            kind="outlined"
                            icon={RefreshCw}
                            label={t("settings.team.resend")}
                            busy={busyId === inv.id}
                            onPress={() => void handleResendInvitation(inv)}
                          />
                          <Button
                            kind="text"
                            icon={Trash2}
                            label={t("settings.team.revoke")}
                            busy={busyId === inv.id}
                            onPress={() => void handleRevokeInvitation(inv)}
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
              onPress={() => void handleLeave()}
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

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  memberControls: { gap: space.sm, paddingTop: space.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
});
