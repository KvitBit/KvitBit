import type { Role, UserId } from "@kvitbit/domain/contract";
import * as Fn from "effect/Function";

export type InvitationRole = Exclude<Role, "owner">;

/**
 * Role permission checks for Workspace Settings (docs/design/user-flows.md §4).
 * A closed workspace is read-only for every role (flow 2.9).
 */
export const canEditWorkspaceSettings: {
  (closed: boolean): (role: Role) => boolean;
  (role: Role, closed: boolean): boolean;
} = Fn.dual(
  2,
  (role: Role, closed: boolean): boolean => !closed && (role === "owner" || role === "admin"),
);

export const canManageApiKeys: {
  (closed: boolean): (role: Role) => boolean;
  (role: Role, closed: boolean): boolean;
} = Fn.dual(
  2,
  (role: Role, closed: boolean): boolean => !closed && (role === "owner" || role === "admin"),
);

export const canManageInvitations: {
  (closed: boolean): (role: Role) => boolean;
  (role: Role, closed: boolean): boolean;
} = Fn.dual(
  2,
  (role: Role, closed: boolean): boolean => !closed && (role === "owner" || role === "admin"),
);

/** Owner can invite admin/member/accountant; admin can invite member/accountant only. */
export const invitableRolesFor = (role: Role): ReadonlyArray<InvitationRole> =>
  role === "owner" ? ["admin", "member", "accountant"] : ["member", "accountant"];

/** Owner can change/remove anyone except owner; admin can change/remove members and accountants. */
export const canManageMember: {
  (targetRole: Role, closed: boolean): (actorRole: Role) => boolean;
  (actorRole: Role, targetRole: Role, closed: boolean): boolean;
} = Fn.dual(3, (actorRole: Role, targetRole: Role, closed: boolean): boolean => {
  if (closed || targetRole === "owner") return false;
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return targetRole === "member" || targetRole === "accountant";
  return false;
});

/** Owner/admin can revoke any grant in the workspace; members/accountants can revoke their own. */
export const canRevokeConnectedApp: {
  (
    grantMemberId: UserId,
    currentUserId: string | null,
    closed: boolean,
  ): (actorRole: Role) => boolean;
  (actorRole: Role, grantMemberId: UserId, currentUserId: string | null, closed: boolean): boolean;
} = Fn.dual(
  4,
  (
    actorRole: Role,
    grantMemberId: UserId,
    currentUserId: string | null,
    closed: boolean,
  ): boolean => {
    if (closed) return false;
    if (actorRole === "owner" || actorRole === "admin") return true;
    return currentUserId !== null && grantMemberId === currentUserId;
  },
);

export const canLeaveWorkspace = (role: Role): boolean => role !== "owner";

export const canTransferOwnership: {
  (closed: boolean): (role: Role) => boolean;
  (role: Role, closed: boolean): boolean;
} = Fn.dual(2, (role: Role, closed: boolean): boolean => !closed && role === "owner");

export const canCloseWorkspace: {
  (closed: boolean): (role: Role) => boolean;
  (role: Role, closed: boolean): boolean;
} = Fn.dual(2, (role: Role, closed: boolean): boolean => !closed && role === "owner");
