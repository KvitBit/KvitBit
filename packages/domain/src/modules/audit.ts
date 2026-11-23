/** Audit log entry (core-ports section 4.10). Insert-only; written in the changing transaction. */
import type { Channel, SystemCaller } from "../caller";
import type { AuditEntryId, UserId } from "../ids";
import type { ClientRef, EntityKind } from "../vocabulary";

export interface AuditEntry {
  readonly id: AuditEntryId;
  readonly at: string; // ISO instant
  readonly actor:
    | {
        readonly _tag: "Member";
        readonly userId: UserId;
        readonly channel: Channel;
        readonly client: ClientRef | null; // "X via <client.name>"
      }
    | { readonly _tag: "System"; readonly job: SystemCaller["job"] };
  readonly subject: { readonly entity: EntityKind; readonly id: string };
  readonly action: string; // e.g. "document.edit", "document.unlock", "payment.record"
  readonly revision: number | null; // subject revision after the change
  readonly changes: ReadonlyArray<{
    readonly path: string;
    readonly before: unknown;
    readonly after: unknown;
  }>;
  readonly reason: string | null;
}
