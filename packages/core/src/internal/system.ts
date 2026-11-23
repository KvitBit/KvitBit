/**
 * The runtime half of the System caller seal (core-ports 2.1). Only callers created by
 * `systemCaller` pass `isSealedSystem`, so a decoded or spread object is rejected by the policy.
 * Never re-exported from an entry point.
 */
import type { SystemCaller, SystemJob, WorkspaceId } from "@kvitbit/domain/contract";

const sealed = new WeakSet<object>();

/** Builds the caller a workflow or cron acts as (rule R4). Core-internal. */
export const systemCaller = (workspaceId: WorkspaceId, job: SystemJob): SystemCaller => {
  const caller = Object.freeze({ _tag: "System" as const, workspaceId, job });
  sealed.add(caller);
  return caller as unknown as SystemCaller;
};

export const isSealedSystem = (caller: object): boolean => sealed.has(caller);
