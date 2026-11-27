/**
 * Internal enforcement of the policy table. Every module method starts with one of these, before
 * anything else, including the request-log replay of rule C3 (rule R1a).
 */
import type {
  Action,
  Caller,
  MemberCaller,
  SystemCaller,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrentCaller, Forbidden } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import { can } from "./can";

/** A caller that acts inside one Workspace. */
export type WorkspaceCaller = MemberCaller | SystemCaller;

/** Fails with `Forbidden{action}` unless the current caller may perform `action`. */
export const authorize = (action: Action): Effect.Effect<Caller, Forbidden, CurrentCaller> =>
  Effect.filterOrFail(
    CurrentCaller,
    (caller) => can(caller, action),
    () => Forbidden.make({ action }),
  );

/**
 * `authorize` for Workspace-scoped methods: returns the Member or System caller and the
 * Workspace every read and write must be scoped to (rules R2, S7).
 */
export const authorizeInWorkspace = (
  action: Action,
): Effect.Effect<
  { readonly caller: WorkspaceCaller; readonly workspaceId: WorkspaceId },
  Forbidden,
  CurrentCaller
> =>
  Effect.flatMap(authorize(action), (caller) =>
    caller._tag === "Member" || caller._tag === "System"
      ? Effect.succeed({ caller, workspaceId: caller.workspaceId })
      : Effect.fail(Forbidden.make({ action })),
  );
