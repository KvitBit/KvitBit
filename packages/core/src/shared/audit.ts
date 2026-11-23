/**
 * Audit append (rules C1, C5; core-ports 4.10). Call inside the transaction of the change.
 * The actor comes from the current caller: Members and System callers produce entries; Account,
 * share visitor and invitation callers produce none unless `actor` is given explicitly.
 */
import type { AuditEntry, AuditEntryId, WorkspaceId } from "@kvitbit/domain/contract";
import { CurrentCaller } from "@kvitbit/domain/contract";
import { Clock, Effect } from "effect";
import type { StoreUnavailable } from "../store/CoreStore";
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

export const appendAudit = (
  input: AuditInput,
): Effect.Effect<AuditEntry | null, StoreUnavailable, CoreStore | CurrentCaller | IdGenerator> =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller;
    const actor: AuditEntry["actor"] | null =
      input.actor ??
      (caller._tag === "Member"
        ? { _tag: "Member", userId: caller.userId, channel: caller.channel, client: caller.client }
        : caller._tag === "System"
          ? { _tag: "System", job: caller.job }
          : null);
    if (actor === null) return null;
    const ids = yield* IdGenerator;
    const entry: AuditEntry = {
      id: (yield* ids.next) as AuditEntryId,
      at: new Date(yield* Clock.currentTimeMillis).toISOString(),
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
