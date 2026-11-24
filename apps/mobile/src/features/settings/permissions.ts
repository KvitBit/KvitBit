import type { Role, UserId } from "@kvitbit/domain/contract";

export type InvitationRole = Exclude<Role, "owner">;

/**
 * Role permission checks for Workspace Settings (docs/design/user-flows.md §4).
 * A closed workspace is read-only for every role (flow 2.9).
 */
export const canEditWorkspaceSettings = (role: Role, closed: boolean): boolean =>
  !closed && (role === "owner" || role === "admin");

export const canManageApiKeys = (role: Role, closed: boolean): boolean =>
  !closed && (role === "owner" || role === "admin");

export const canManageInvitations = (role: Role, closed: boolean): boolean =>
  !closed && (role === "owner" || role === "admin");

/** Owner can invite admin/member/accountant; admin can invite member/accountant only. */
export const invitableRolesFor = (role: Role): ReadonlyArray<InvitationRole> =>
  role === "owner" ? ["admin", "member", "accountant"] : ["member", "accountant"];

/** Owner can change/remove anyone except owner; admin can change/remove members and accountants. */
export const canManageMember = (actorRole: Role, targetRole: Role, closed: boolean): boolean => {
  if (closed || targetRole === "owner") return false;
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return targetRole === "member" || targetRole === "accountant";
  return false;
};

/** Owner/admin can revoke any grant in the workspace; members/accountants can revoke their own. */
export const canRevokeConnectedApp = (
  actorRole: Role,
  grantMemberId: UserId,
  currentUserId: string | null,
  closed: boolean,
): boolean => {
  if (closed) return false;
  if (actorRole === "owner" || actorRole === "admin") return true;
  return currentUserId !== null && grantMemberId === currentUserId;
};

export const canLeaveWorkspace = (role: Role): boolean => role !== "owner";

export const canTransferOwnership = (role: Role, closed: boolean): boolean =>
  !closed && role === "owner";

export const canCloseWorkspace = (role: Role, closed: boolean): boolean =>
  !closed && role === "owner";
