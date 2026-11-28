/**
 * Internal enforcement of the policy table. Every module method starts with one of these, before
 * anything else, including the request-log replay of rule C3 (rule R1a).
 */
import type { Action, Caller, MemberCaller, SystemCaller } from "@kvitbit/domain/contract";
import { Forbidden } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import { can } from "./can";

/** A caller that acts inside one Workspace. */
export type WorkspaceCaller = MemberCaller | SystemCaller;

/** Fails with `Forbidden{action}` unless `caller` may perform `action`. */
export const authorize = Effect.fnUntraced(function* (caller: Caller, action: Action) {
  if (!can(caller, action)) return yield* Forbidden.make({ action });
  return caller;
});

/**
 * `authorize` for Workspace-scoped methods: returns the Member or System caller and the
 * Workspace every read and write must be scoped to (rules R2, S7).
 */
export const authorizeInWorkspace = Effect.fnUntraced(function* (caller: Caller, action: Action) {
  const allowed = yield* authorize(caller, action);
  if (allowed._tag !== "Member" && allowed._tag !== "System") {
    return yield* Forbidden.make({ action });
  }
  return {
    caller: allowed,
    workspaceId: allowed.workspaceId,
  };
});
