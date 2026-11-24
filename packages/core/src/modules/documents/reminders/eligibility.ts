/**
 * The one automatic-reminder check (rule D16) shared by selection, enqueue and the
 * DocumentDelivery claim, so the three cannot disagree:
 * - armed: the last purpose "document" send armed reminders (`remindersOn`), or the due date
 *   changed since that send and its choice was not "off" (a due-date change re-arms and
 *   resolves again, D16; no stored epoch, so the delivery snapshot's `dueOn` stands in);
 * - the CURRENT Contact and Workspace policies still arm the document (`remindable`);
 * - the step belongs to the current due date and offsets, is due, and no live reminder of the
 *   same due date already covers a step on or after its date (watermark: changed offsets
 *   never backfill an earlier reminder).
 */
import type { DeliveryId, IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { addDays } from "../../../engines/calendar";
import type { EffectiveReminders } from "../../../shared/overrides";
import type { DeliveryRecord } from "../deliveries/record";
import { isReleased } from "../deliveries/record";
import { DeliveriesRepo } from "../deliveries/repo";
import type { DocumentRecord } from "../record";
import { effectiveReminders, remindable, stillOwed } from "./policy";

export type ReminderBlock =
  | "document_settled"
  | "reminders_off"
  | "reminder_step_stale"
  | "reminder_superseded";

export interface ReminderState {
  readonly effective: EffectiveReminders;
  /** Null when the document is remindable now. */
  readonly block: "document_settled" | "reminders_off" | null;
  /** Live automatic reminders for the current due date (not released). */
  readonly live: ReadonlyArray<DeliveryRecord>;
}

/** Whether `record` is armed and remindable now, with its live reminders for `dueOn`. */
export const reminderState = (workspaceId: WorkspaceId, record: DocumentRecord, today: IsoDate) =>
  Effect.gen(function* () {
    const effective = yield* effectiveReminders(workspaceId, record, today);
    const deliveries = yield* (yield* DeliveriesRepo).byDocument(workspaceId, record.id);
    const live = deliveries.filter(
      (d) => d.reminder !== null && d.reminder.dueOn === record.dueOn && !isReleased(d),
    );
    if (!stillOwed(record)) return { effective, block: "document_settled", live } as const;
    const lastSend = deliveries.filter((d) => d.purpose === "document").at(-1);
    const armed =
      record.remindersOn ||
      (lastSend !== undefined &&
        record.remindersChoice !== "off" &&
        lastSend.dueOn !== record.dueOn);
    const on = remindable({ ...record, remindersOn: armed }, effective);
    return { effective, block: on ? null : "reminders_off", live } as const satisfies ReminderState;
  });

/** Why `step` is not (or no longer) the reminder to send on `today`; null when it is. */
export const stepBlock = (
  state: ReminderState,
  record: Pick<DocumentRecord, "dueOn">,
  step: { readonly dueOn: IsoDate; readonly offsetDays: number },
  today: IsoDate,
  self: DeliveryId | null = null,
): ReminderBlock | null => {
  if (state.block !== null) return state.block;
  const date = addDays(step.dueOn, step.offsetDays);
  if (
    step.dueOn !== record.dueOn ||
    !state.effective.offsetsDays.includes(step.offsetDays) ||
    date > today
  ) {
    return "reminder_step_stale";
  }
  const covered = state.live.some(
    (d) =>
      d.id !== self &&
      d.reminder !== null &&
      addDays(d.reminder.dueOn, d.reminder.offsetDays) >= date,
  );
  return covered ? "reminder_superseded" : null;
};
