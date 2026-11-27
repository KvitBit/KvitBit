/**
 * Membership change guard for the Workspaces module (rules R1c and R3). Pure: it judges one
 * change against the actor's permissions and the target's current role.
 */

import type { Caller, Role } from "@kvitbit/domain/contract";
import { Conflict, Forbidden } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import { can, scopesAllow } from "./can";

export type MembershipChange =
  /** Invite a new Member with `role`. */
  | { readonly _tag: "Invite"; readonly role: Role }
  /** Change the role of a Member currently holding `targetRole`. */
  | { readonly _tag: "SetRole"; readonly targetRole: Role; readonly role: Role }
  /** Remove a Member currently holding `targetRole`. */
  | { readonly _tag: "Remove"; readonly targetRole: Role }
  /** The caller leaves the Workspace. */
  | { readonly _tag: "Leave" };

const illegal = (detail?: "member.owner_cannot_leave") =>
  Effect.fail(
    Conflict.make(
      detail === undefined
        ? { reason: "illegal_transition" }
        : { reason: "illegal_transition", detail },
    ),
  );

const forbidden = (
  action: "member.invite" | "member.setRole" | "member.leave" | "member.manageAdmins",
) => Effect.fail(Forbidden.make({ action }));

/**
 * - Invite needs `member.invite`; SetRole and Remove need `member.setRole`.
 * - The owner is never removed or demoted, nobody is invited as or promoted to owner
 *   (`Conflict{illegal_transition}`); ownership moves only through `transferOwnership`.
 * - Leave: a scoped token without `members:write` is `Forbidden{member.leave}` first; then the
 *   owner cannot leave (`Conflict{illegal_transition, member.owner_cannot_leave}`, R3). The
 *   owner never holds `member.leave`, so `Workspaces.leave` authorizes through this guard, not
 *   through a preceding `authorize("member.leave")`.
 * - Any change that makes or touches an `admin` also needs `member.manageAdmins` (R1c).
 */
export const checkMembershipChange: {
  (change: MembershipChange): (caller: Caller) => Effect.Effect<void, Forbidden | Conflict>;
  (caller: Caller, change: MembershipChange): Effect.Effect<void, Forbidden | Conflict>;
} = Fn.dual(
  2,
  (caller: Caller, change: MembershipChange): Effect.Effect<void, Forbidden | Conflict> => {
    switch (change._tag) {
      case "Leave":
        if (caller._tag === "Member" && caller.role === "owner") {
          return scopesAllow(caller, "members", "write")
            ? illegal("member.owner_cannot_leave")
            : forbidden("member.leave");
        }
        return can(caller, "member.leave") ? Effect.void : forbidden("member.leave");
      case "Invite":
        if (!can(caller, "member.invite")) return forbidden("member.invite");
        if (change.role === "owner") return illegal();
        if (change.role === "admin" && !can(caller, "member.manageAdmins")) {
          return forbidden("member.manageAdmins");
        }
        return Effect.void;
      case "SetRole":
      case "Remove": {
        if (!can(caller, "member.setRole")) return forbidden("member.setRole");
        const next = change._tag === "SetRole" ? change.role : undefined;
        if (change.targetRole === "owner" || next === "owner") return illegal();
        if (
          (change.targetRole === "admin" || next === "admin") &&
          !can(caller, "member.manageAdmins")
        ) {
          return forbidden("member.manageAdmins");
        }
        return Effect.void;
      }
    }
  },
);
