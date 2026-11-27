/**
 * `Documents.send` and `Documents.previewSend` (core-ports 4.4, rules D13-D16, C3, J1, J3).
 * Both run the same `plan` (rule D15): state checks, recipients, language, subject,
 * attachment and the reminder resolution; `send` then stores the reminder choice (purpose
 * "document"), queues the delivery with its snapshot, audits, and starts the job after commit.
 */

import type {
  AuditEntry,
  DeliveryPurpose,
  DocumentId,
  DocumentKind,
  Locale,
  RequestOptions,
  SendOptions,
  SendPreview,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  DeliveryId as DeliveryIdSchema,
  DeliveryPurpose as DeliveryPurposeSchema,
  DocumentId as DocumentIdSchema,
  Invalid,
  Locale as LocaleSchema,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { authorizeInWorkspace } from "../../../policy/Policy";
import { appendAudit } from "../../../shared/audit";
import { orUnavailable } from "../../../shared/errors";
import { fxDryRun } from "../../../shared/fx";
import { withIdempotency } from "../../../shared/idempotency";
import { newId } from "../../../shared/ids";
import { CoreStore } from "../../../store/CoreStore";
import { DocumentContacts, DocumentIssuers } from "../ports";
import type { DocumentRecord } from "../record";
import { isArmed } from "../reminders/eligibility";
import { choiceOf, effectiveReminders, stillOwed } from "../reminders/policy";
import { DocumentsRepo } from "../repo";
import { now, viewOf } from "../support";
import { guard } from "../transitions";
import { DeliveryJobs } from "./jobs";
import type { DeliveryRecord, ReminderStepRecord } from "./record";
import { REMINDER_STEP } from "./record";
import { DeliveriesRepo } from "./repo";

const KIND_TITLE: Readonly<Record<Locale, Readonly<Record<DocumentKind, string>>>> = {
  cs: {
    invoice: "Faktura",
    proforma: "Zálohová faktura",
    payment_tax_document: "Daňový doklad k přijaté platbě",
    credit_note: "Opravný daňový doklad",
  },
  en: {
    invoice: "Invoice",
    proforma: "Proforma invoice",
    payment_tax_document: "Tax document for a received payment",
    credit_note: "Credit note",
  },
};
const REMINDER_PREFIX: Readonly<Record<Locale, string>> = {
  cs: "Upomínka",
  en: "Payment reminder",
};

/** Subject line: "[Reminder: ]<Kind> <number> – <issuer>". */
export const subjectOf: {
  (
    language: Locale,
    record: Pick<DocumentRecord, "kind" | "number" | "issuer">,
  ): (purpose: DeliveryPurpose) => string;
  (
    purpose: DeliveryPurpose,
    language: Locale,
    record: Pick<DocumentRecord, "kind" | "number" | "issuer">,
  ): string;
} = Fn.dual(
  3,
  (
    purpose: DeliveryPurpose,
    language: Locale,
    record: Pick<DocumentRecord, "kind" | "number" | "issuer">,
  ): string => {
    const title = EffectString.trim(`${KIND_TITLE[language][record.kind]} ${record.number ?? ""}`);
    const base = `${title} – ${record.issuer.name}`;
    return purpose === "reminder" ? `${REMINDER_PREFIX[language]}: ${base}` : base;
  },
);

/** The PDF attachment's name and type; rendered at dispatch from the snapshot. */
export const attachmentOf = (record: Pick<DocumentRecord, "number" | "id">) => ({
  filename: `${EffectString.replace(/[^\p{L}\p{N}._-]+/gu, "_")(record.number ?? record.id)}.pdf`,
  contentType: "application/pdf",
  template: "classic" as const,
});

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const malformed = (path: ReadonlyArray<string | number>, reason: string) =>
  Invalid.make({ issues: [{ path: [...path], code: "request.malformed", params: { reason } }] });

/** Explicit recipients, else the Contact's billing emails; trimmed, deduped, validated. */
const recipientsOf = Effect.fn("recipientsOf")(function* (
  workspaceId: WorkspaceId,
  record: DocumentRecord,
  to: SendOptions["to"],
) {
  const given =
    to ??
    (yield* (yield* DocumentContacts).forDocument(workspaceId, record.contactId)).billingEmails;
  const recipients = [...new Set(EffectArray.map(given, (email) => EffectString.trim(email)))];
  if (recipients.length === 0) return yield* malformed(["to"], "recipients_required");
  const bad = Option.getOrElse(
    EffectArray.findFirstIndex(recipients, (email) => !EMAIL.test(email)),
    () => -1,
  );
  if (bad >= 0) return yield* malformed(["to", bad], "email_invalid");
  return recipients;
});

/** What a send would do now; shared by send and previewSend (D15). */
export interface SendPlan {
  readonly record: DocumentRecord;
  readonly purpose: DeliveryPurpose;
  readonly to: ReadonlyArray<string>;
  readonly language: Locale;
  readonly subject: string;
  readonly replyTo: string | null;
  readonly attachment: ReturnType<typeof attachmentOf>;
  /** The choice a purpose "document" send stores; null for a reminder (D14 ignores it). */
  readonly choice: ReturnType<typeof choiceOf> | null;
  readonly armsReminders: boolean;
}

export const plan = Effect.fn("plan")(function* (
  workspaceId: WorkspaceId,
  record: DocumentRecord,
  input: SendOptions = {},
) {
  // D13: drafts and cancelled documents are not sent.
  yield* guard(record, "send");
  const purpose = input.purpose ?? "document";
  // D14: a manual reminder needs an owed Invoice or Proforma.
  if (purpose === "reminder" && !stillOwed(record)) {
    return yield* Conflict.make({
      reason: "illegal_transition",
      detail: "reminder.document_settled",
    });
  }
  const to = yield* recipientsOf(workspaceId, record, input.to);
  const language = input.language ?? record.language;
  const { today } = yield* now;
  const issuer = yield* (yield* DocumentIssuers).forDocument(workspaceId, today);
  const choice = purpose === "document" ? choiceOf(input.reminders) : null;
  const armsReminders =
    choice === null
      ? false
      : record.kind === "invoice" || record.kind === "proforma"
        ? (yield* effectiveReminders(workspaceId, record, today, choice)).arms
        : false;
  return {
    record,
    purpose,
    to,
    language,
    subject: subjectOf(purpose, language, record),
    replyTo: issuer.party.email,
    attachment: attachmentOf(record),
    choice,
    armsReminders,
  } satisfies SendPlan;
});

export const previewOf = (p: SendPlan): SendPreview => ({
  purpose: p.purpose,
  to: p.to,
  language: p.language,
  subject: p.subject,
  attachments: [{ filename: p.attachment.filename, contentType: p.attachment.contentType }],
  armsReminders: p.armsReminders,
});

/**
 * Inserts the queued delivery with its J3 snapshot (the view as of `record`), audits
 * `document.send` on the Document, and starts the job after the outermost commit (J1).
 * Shared by `send` and the automatic reminder enqueue.
 */
export const queueDelivery = Effect.fn("queueDelivery")(function* (
  workspaceId: WorkspaceId,
  p: Omit<SendPlan, "choice" | "armsReminders">,
  reminder: ReminderStepRecord | null,
  extraChanges: AuditEntry["changes"] = [],
  arms = false,
) {
  const { at } = yield* now;
  const id = yield* newId(DeliveryIdSchema.make);
  const row: DeliveryRecord = {
    id,
    workspaceId,
    revision: 1,
    documentId: p.record.id,
    // Per-document order, assigned under the document row lock the caller holds.
    sequence: (yield* (yield* DeliveriesRepo).byDocument(workspaceId, p.record.id)).length + 1,
    documentRevision: p.record.revision,
    contactId: p.record.contactId,
    arms,
    dueOn: p.record.dueOn,
    purpose: p.purpose,
    status: "queued",
    to: p.to,
    replyTo: p.replyTo,
    language: p.language,
    subject: p.subject,
    // The view in the delivery's language (statutory notes, labels), as the PDF prints it.
    view: yield* viewOf(p.record, { language: p.language }),
    attachment: p.attachment,
    reminder,
    attempts: 0,
    lastOutcome: null,
    failure: null,
    provider: null,
    providerMessageId: null,
    createdAt: at,
    updatedAt: at,
  };
  const repo = yield* DeliveriesRepo;
  const store = yield* CoreStore;
  // The insert runs as a savepoint, so a reminder step queued concurrently (unique
  // `deliveries_reminder_step`) returns that delivery without aborting the caller's
  // transaction or auditing twice. Other ids are fresh.
  const taken = yield* store.transaction(repo.insert(row)).pipe(
    Effect.as(null),
    Effect.catchTag("UniqueViolation", (e) =>
      reminder === null || e.constraint !== REMINDER_STEP
        ? Effect.die(e)
        : Effect.flatMap(
            repo.reminderStep(workspaceId, { documentId: p.record.id, ...reminder }),
            (existing) =>
              Option.isSome(existing) ? Effect.succeed(existing.value) : Effect.die(e),
          ),
    ),
  );
  if (taken !== null) return taken;
  yield* appendAudit({
    workspaceId,
    subject: { entity: "Document", id: p.record.id },
    action: "document.send",
    revision: p.record.revision,
    changes: [
      { path: "delivery", before: null, after: row.id },
      { path: "purpose", before: null, after: p.purpose },
      { path: "to", before: null, after: EffectArray.join(p.to, ", ") },
      ...extraChanges,
      ...(reminder === null
        ? []
        : [{ path: "reminder", before: null, after: `${reminder.dueOn}+${reminder.offsetDays}` }]),
    ],
  });
  const jobs = yield* DeliveryJobs;
  yield* (yield* CoreStore).afterCommit(jobs.start(workspaceId, row.id));
  return row;
});

const SendPayload = Schema.Struct({
  id: DocumentIdSchema,
  input: Schema.optional(
    Schema.Struct({
      to: Schema.String.pipe(Schema.Array, Schema.optional),
      language: Schema.optional(LocaleSchema),
      reminders: Schema.optional(Schema.Boolean),
      purpose: Schema.optional(DeliveryPurposeSchema),
    }),
  ),
});

export const SendResultCodec = Schema.Struct({
  deliveryId: DeliveryIdSchema,
  status: Schema.Literal("queued"),
});

/**
 * Queue email delivery (never fails on provider outage: dispatch is the job's). Runs nested
 * in a caller's transaction as a savepoint (issue with send, recurring issuance as System,
 * board #399); a `requestKey` makes it replay-safe (C3) when it is the outermost call.
 */
export const send = Effect.fn("send")(
  function* (id: DocumentId, input?: SendOptions, opts?: RequestOptions) {
    const { workspaceId } = yield* authorizeInWorkspace("document.send");
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Documents.send",
        payload: {
          schema: SendPayload,
          value: input === undefined ? { id } : { id, input },
        },
        result: SendResultCodec,
      },
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const locked = yield* repo.lock(workspaceId, id);
        const p = yield* plan(workspaceId, locked, input);
        let record = locked;
        const changes: Array<AuditEntry["changes"][number]> = [];
        if (p.choice !== null) {
          // D16: the Document's own choice and the arm outcome resolved now (Credit Notes and
          // PTDs never arm). Selection, enqueue and claim re-check the current policy.
          // (the effective policy is resolved again at selection and claim time).
          const remindersOn = p.armsReminders;
          if (record.remindersChoice !== p.choice || record.remindersOn !== remindersOn) {
            changes.push(
              { path: "remindersChoice", before: record.remindersChoice, after: p.choice },
              { path: "remindersOn", before: record.remindersOn, after: remindersOn },
            );
            const { at } = yield* now;
            record = yield* repo
              .update(
                { ...record, remindersChoice: p.choice, remindersOn, updatedAt: at },
                record.revision,
              )
              // The row is locked (revision cannot move) and no unique key changes.
              .pipe(Effect.catchTag(["Conflict", "UniqueViolation"], (e) => Effect.die(e)));
          }
        }
        // A new arm (D16) starts only when reminders were effectively off.
        let newArm = false;
        if (p.armsReminders) {
          const deliveryRepo = yield* DeliveriesRepo;
          const previous = yield* deliveryRepo.byDocument(workspaceId, locked.id);
          newArm = !isArmed(locked, previous);
        }
        const delivery = yield* queueDelivery(workspaceId, { ...p, record }, null, changes, newArm);
        return { deliveryId: delivery.id, status: "queued" as const };
      }),
    );
  },
  (_) => orUnavailable(_),
);

/** Dry run of `send` (D15): same policy check and plan, nothing stored. */
export const previewSend = Effect.fn("previewSend")(
  function* (id: DocumentId, input?: SendOptions) {
    const { workspaceId } = yield* authorizeInWorkspace("document.send");
    const record = yield* (yield* DocumentsRepo).get(workspaceId, id);
    const value_1 = yield* plan(workspaceId, record, input);
    return previewOf(value_1);
  },
  (_) => fxDryRun(_),
  (_) => orUnavailable(_),
);
