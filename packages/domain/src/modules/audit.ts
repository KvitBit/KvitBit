/** Audit log entry (core-ports section 4.10). Insert-only; written in the changing transaction. */
import * as Schema from "effect/Schema";
import { Channel, SystemJob } from "../caller";
import { AuditEntryId, UserId } from "../ids";
import { ClientRef, EntityKind } from "../vocabulary";

export const AuditEntry = Schema.Struct({
  id: AuditEntryId,
  at: Schema.String, // ISO instant
  actor: Schema.Union([
    Schema.TaggedStruct("Member", {
      userId: UserId,
      channel: Channel,
      client: Schema.NullOr(ClientRef), // "X via <client.name>"
    }),
    Schema.TaggedStruct("System", { job: SystemJob }),
  ]),
  subject: Schema.Struct({ entity: EntityKind, id: Schema.String }),
  action: Schema.String, // e.g. "document.edit", "document.unlock", "payment.record"
  revision: Schema.NullOr(Schema.Int), // subject revision after the change
  changes: Schema.Array(
    Schema.Struct({ path: Schema.String, before: Schema.Unknown, after: Schema.Unknown }),
  ),
  reason: Schema.NullOr(Schema.String),
});
export type AuditEntry = typeof AuditEntry.Type;
