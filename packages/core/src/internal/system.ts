/**
 * The runtime half of the System caller seal (core-ports 2.1). Only callers created by
 * `systemCaller` pass `isSealedSystem`, so a decoded or spread object is rejected by the policy.
 * Never re-exported from an entry point.
 */

import type { SystemCaller, SystemJob, WorkspaceId } from "@kvitbit/domain/contract";
import * as Fn from "effect/Function";

type SystemCallerData = Pick<SystemCaller, "_tag" | "workspaceId" | "job">;

const sealed = new WeakSet<SystemCallerData>();

function markSealed(caller: SystemCallerData): asserts caller is SystemCaller {
  sealed.add(caller);
}

/** Builds the caller a workflow or cron acts as (rule R4). Core-internal. */
export const systemCaller: {
  (job: SystemJob): (workspaceId: WorkspaceId) => SystemCaller;
  (workspaceId: WorkspaceId, job: SystemJob): SystemCaller;
} = Fn.dual(2, (workspaceId: WorkspaceId, job: SystemJob): SystemCaller => {
  // Copy and freeze the job too, so a caller's permissions cannot change after it is sealed.
  const caller = Object.freeze({
    _tag: "System" as const,
    workspaceId,
    job: Object.freeze({ ...job }),
  });
  markSealed(caller);
  return caller;
});

export const isSealedSystem = (caller: SystemCallerData): boolean => sealed.has(caller);
