/**
 * The stored delivery (`deliveries` table): the intent row of rule J1 and the immutable
 * snapshot of rule J3 (recipients, language, subject and the document view at the revision
 * current when it was queued), plus its status and dispatch outcome.
 */
import {
  ContactId,
  DeliveryId,
  DeliveryPurpose,
  DocumentId,
  IsoDate,
  Locale,
  PdfTemplate,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";
import { defineCollection } from "../../../store/tables";
import { DocumentViewCodec } from "../view";

export const DeliveryStatus = Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]);
export type DeliveryStatus = typeof DeliveryStatus.Type;

/** An automatic reminder's step: the due date it was computed from and its offset (D16). */
export const ReminderStepRecord = Schema.Struct({
  dueOn: IsoDate,
  offsetDays: Schema.Int,
  /** `sequence` of the send that armed the reminders this step belongs to (0: none). */
  armedBy: Schema.Int,
});
export type ReminderStepRecord = typeof ReminderStepRecord.Type;

export const DeliveryRecord = Schema.Struct({
  id: DeliveryId,
  workspaceId: WorkspaceId,
  revision: Schema.Number,
  documentId: DocumentId,
  /** 1, 2, ... per document in queueing order (unique `deliveries_document_sequence`). */
  sequence: Schema.Int,
  /** The document revision the snapshot was taken at (J3). */
  documentRevision: Schema.Number,
  purpose: DeliveryPurpose,
  status: DeliveryStatus,
  to: Schema.Array(Schema.String),
  replyTo: Schema.NullOr(Schema.String),
  language: Locale,
  subject: Schema.String,
  /** The document as queued (J3); the PDF attachment is rendered from it. */
  view: DocumentViewCodec,
  attachment: Schema.Struct({
    filename: Schema.String,
    contentType: Schema.String,
    template: PdfTemplate,
  }),
  /** The document's Contact when queued (recipients are reused only for the same buyer). */
  contactId: ContactId,
  /** This purpose "document" send armed reminders that were off (a new arm, D16). */
  arms: Schema.Boolean,
  /** The document's due date when queued (a later change re-arms reminders, D16). */
  dueOn: IsoDate,
  /** Set for an automatic reminder (selection, reminders/); null for a send (manual or not). */
  reminder: Schema.NullOr(ReminderStepRecord),
  /** Dispatch attempts that reached the EmailSender. */
  attempts: Schema.Int,
  /** The last retryable dispatch outcome; `outcome_unknown` means the provider may have it. */
  lastOutcome: Schema.NullOr(Schema.Literals(["not_accepted", "outcome_unknown"])),
  /** Why the delivery failed or was skipped. */
  failure: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  providerMessageId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type DeliveryRecord = typeof DeliveryRecord.Type;

/** One automatic reminder per document, due date and offset (no stored schedule, D16). */
export const REMINDER_STEP = "deliveries_reminder_step";
export const DOCUMENT_SEQUENCE = "deliveries_document_sequence";

export const DeliveriesTable = defineCollection<DeliveryRecord>({
  name: "deliveries",
  // EntityKind has no Delivery; a delivery is part of its Document.
  entity: "Document",
  schema: DeliveryRecord as unknown as Schema.Codec<DeliveryRecord, unknown>,
  unique: [
    {
      name: DOCUMENT_SEQUENCE,
      scope: "workspace",
      key: (row) => [row.documentId, row.sequence],
    },
    {
      name: REMINDER_STEP,
      scope: "workspace",
      // A step skipped before any attempt is released, so it can be queued again (D16).
      key: (row) =>
        row.reminder === null || isReleased(row)
          ? null
          : [row.documentId, row.reminder.dueOn, row.reminder.offsetDays, row.reminder.armedBy],
    },
  ],
});

/**
 * Skipped before any dispatch attempt could reach the provider: its reminder step no longer
 * counts as taken. A row skipped after `claim` (a restarted job) carries `outcome_unknown`,
 * because the job may have died after the provider accepted it, so its step stays taken.
 */
export const isReleased = (
  row: Pick<DeliveryRecord, "status" | "attempts" | "lastOutcome">,
): boolean => row.status === "skipped" && row.attempts === 0 && row.lastOutcome === null;

/** Statuses no job step changes again. */
export const isTerminal = (status: DeliveryStatus): boolean =>
  status === "sent" || status === "failed" || status === "skipped";
