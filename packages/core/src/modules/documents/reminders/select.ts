/**
 * Automatic payment reminders (rule D16, core-ports 7.2 PaymentReminders) without a stored
 * schedule: `selectDueReminders` resolves each remindable document's effective policy now and
 * picks its latest step due today (dates follow the current due date); `enqueueReminder`
 * re-checks and queues it as a purpose "reminder" delivery keyed by its step (unique
 * `deliveries_reminder_step`), never touching the document's reminder choice (as D14).
 * The DocumentDelivery claim re-checks once more before dispatch.
 */
import type { DeliveryId, DocumentId, IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import { Effect, Option } from "effect";
import { orUnavailable } from "../../../shared/errors";
import { CoreStore } from "../../../store/CoreStore";
import { DeliveriesRepo } from "../deliveries/repo";
import { attachmentOf, queueDelivery, subjectOf } from "../deliveries/send";
import { DocumentContacts, DocumentIssuers } from "../ports";
import type { DocumentRecord } from "../record";
import { DocumentsRepo } from "../repo";
import { now } from "../support";
import { reminderState, stepBlock } from "./eligibility";
import { dueStep } from "./policy";

export interface DueReminder {
  readonly documentId: DocumentId;
  readonly dueOn: IsoDate;
  readonly step: number;
  readonly offsetDays: number;
  readonly date: IsoDate;
  /** The arm the step belongs to (eligibility.ts). */
  readonly armedBy: number;
}

const PAGE = 200;

/** The step `record` owes on `today`, or null (not armed or remindable, nothing due, covered). */
export const dueReminderOf = (workspaceId: WorkspaceId, record: DocumentRecord, today: IsoDate) =>
  Effect.gen(function* () {
    const state = yield* reminderState(workspaceId, record, today);
    if (state.block !== null) return null;
    const step = dueStep(record.dueOn, state.effective, today);
    if (step === null) return null;
    const candidate = { dueOn: record.dueOn, offsetDays: step.offsetDays, armedBy: state.arm };
    if (stepBlock(state, record, candidate, today) !== null) return null;
    return {
      documentId: record.id,
      dueOn: record.dueOn,
      step: step.step,
      offsetDays: step.offsetDays,
      date: step.date,
      armedBy: state.arm,
    } satisfies DueReminder;
  });

/** Every reminder due on `today` in the Workspace (the sweep a PaymentReminders cron runs). */
export const selectDueReminders = (workspaceId: WorkspaceId, today: IsoDate) =>
  Effect.gen(function* () {
    const repo = yield* DocumentsRepo;
    const due: Array<DueReminder> = [];
    let after: readonly [IsoDate, DocumentId] | undefined;
    for (;;) {
      const page = yield* repo.search(
        workspaceId,
        { status: "issued" },
        after === undefined ? { limit: PAGE } : { after, limit: PAGE },
      );
      for (const record of page.rows) {
        const reminder = yield* dueReminderOf(workspaceId, record, today);
        if (reminder !== null) due.push(reminder);
      }
      const last = page.rows.at(-1);
      if (!page.more || last === undefined) return due;
      after = [last.issuedOn, last.id];
    }
  }).pipe(orUnavailable);

/**
 * Queues `reminder` when it is still the step due now (re-checked under the row lock); returns
 * the delivery id, the existing one when that step was already queued, or null when it no
 * longer applies. The job starts after commit.
 */
export const enqueueReminder = (workspaceId: WorkspaceId, reminder: DueReminder) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const deliveries = yield* DeliveriesRepo;
        const record = yield* (yield* DocumentsRepo).lock(workspaceId, reminder.documentId);
        const { today } = yield* now;
        const existing = yield* deliveries.reminderStep(workspaceId, reminder);
        if (Option.isSome(existing)) return existing.value.id as DeliveryId | null;
        const current = yield* dueReminderOf(workspaceId, record, today);
        if (
          current === null ||
          current.dueOn !== reminder.dueOn ||
          current.offsetDays !== reminder.offsetDays ||
          current.armedBy !== reminder.armedBy
        ) {
          return null;
        }
        const issuer = yield* (yield* DocumentIssuers).forDocument(workspaceId, today);
        // Recipients: those the document was last sent to while it had its current buyer, else
        // the current Contact's billing emails (a buyer change never reuses the old buyer's).
        const lastSend = (yield* deliveries.byDocument(workspaceId, record.id))
          .filter((d) => d.purpose === "document")
          .at(-1);
        const to =
          lastSend !== undefined && lastSend.contactId === record.contactId
            ? lastSend.to
            : (yield* (yield* DocumentContacts).forDocument(workspaceId, record.contactId))
                .billingEmails;
        if (to.length === 0) return null;
        const delivery = yield* queueDelivery(
          workspaceId,
          {
            record,
            purpose: "reminder",
            to,
            language: record.language,
            subject: subjectOf("reminder", record.language, record),
            replyTo: issuer.party.email,
            attachment: attachmentOf(record),
          },
          { dueOn: reminder.dueOn, offsetDays: reminder.offsetDays, armedBy: reminder.armedBy },
        );
        return delivery.id as DeliveryId | null;
      }),
    );
  }).pipe(orUnavailable);
