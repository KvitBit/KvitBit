/**
 * Audit append (rules C1, C5; core-ports 4.10). Call inside the transaction of the change.
 * The actor comes from `caller`: Members and System callers produce entries; Account,
 * share visitor and invitation callers produce none unless `actor` is given explicitly.
 */
import type { AuditEntry, Caller, WorkspaceId } from "@kvitbit/domain/contract";
import { AuditEntryId } from "@kvitbit/domain/contract";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { CoreStore } from "../store/CoreStore";
import { IdGenerator } from "./ids";

export interface AuditInput {
  readonly workspaceId: WorkspaceId;
  readonly subject: AuditEntry["subject"];
  readonly action: string;
  readonly revision: number | null;
  readonly changes?: AuditEntry["changes"];
  readonly reason?: string | null;
  /** Overrides the actor derived from the caller (e.g. the new owner on `Workspaces.create`). */
  readonly actor?: AuditEntry["actor"];
}

export const appendAudit = Effect.fnUntraced(function* (caller: Caller, input: AuditInput) {
  const actor: AuditEntry["actor"] | null =
    input.actor ??
    (caller._tag === "Member"
      ? { _tag: "Member", userId: caller.userId, channel: caller.channel, client: caller.client }
      : caller._tag === "System"
        ? { _tag: "System", job: caller.job }
        : null);
  if (actor === null) return null;
  const ids = yield* IdGenerator;
  const id = yield* ids.next;
  const now = yield* DateTime.now;
  const entry: AuditEntry = {
    id: AuditEntryId.make(id),
    at: DateTime.formatIso(now),
    actor,
    subject: input.subject,
    action: input.action,
    revision: input.revision,
    changes: input.changes ?? [],
    reason: input.reason ?? null,
  };
  const store = yield* CoreStore;
  yield* store.audit.append(input.workspaceId, entry);
  return entry;
});
