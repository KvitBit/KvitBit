/**
 * The one automatic-reminder check (rule D16) shared by selection, enqueue and the
 * DocumentDelivery claim, so the three cannot disagree:
 * - armed: the last purpose "document" send armed reminders (`remindersOn`), or the due date
 *   changed since that send and its choice was not "off" (a due-date change re-arms and
 *   resolves again, D16; no stored epoch, so the delivery snapshot's `dueOn` stands in);
 * - the CURRENT Contact and Workspace policies still arm the document (`remindable`);
 * - the step belongs to the current due date and offsets, is due, and no live reminder of the
 *   same due date and arm already covers a step on or after its date (watermark: changed
 *   offsets never backfill an earlier reminder);
 * - the step belongs to the current arm: the latest purpose "document" send that turned
 *   reminders on (`arms`). Turning reminders off and on again starts a new arm, so a reminder
 *   queued under the old one is skipped at claim and the new arm queues its own.
 */

import type { DeliveryId, IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import { addDaysWithinRange } from "../../../engines/calendar";
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
  | "reminder_rearmed"
  | "reminder_superseded";

export interface ReminderState {
  readonly effective: EffectiveReminders;
  /** Null when the document is remindable now. */
  readonly block: "document_settled" | "reminders_off" | null;
  /** `sequence` of the send that started the current arm (0: none). */
  readonly arm: number;
  /** Live automatic reminders for the current due date and arm (not released). */
  readonly live: ReadonlyArray<DeliveryRecord>;
}

/**
 * The document is armed: its last purpose "document" send armed reminders, or the due date
 * changed since that send with a choice other than "off" (the re-arm of D16). Used by
 * selection and claim, and by `send` to tell a new arm from a re-send.
 */
export const isArmed: {
  (
    deliveries: ReadonlyArray<DeliveryRecord>,
  ): (record: Pick<DocumentRecord, "remindersOn" | "remindersChoice" | "dueOn">) => boolean;
  (
    record: Pick<DocumentRecord, "remindersOn" | "remindersChoice" | "dueOn">,
    deliveries: ReadonlyArray<DeliveryRecord>,
  ): boolean;
} = Fn.dual(
  2,
  (
    record: Pick<DocumentRecord, "remindersOn" | "remindersChoice" | "dueOn">,
    deliveries: ReadonlyArray<DeliveryRecord>,
  ): boolean => {
    if (record.remindersOn) return true;
    const lastSend = EffectArray.filter(deliveries, (d) => d.purpose === "document").at(-1);
    return (
      lastSend !== undefined && record.remindersChoice !== "off" && lastSend.dueOn !== record.dueOn
    );
  },
);

/** Whether `record` is armed and remindable now, with its live reminders for `dueOn`. */
export const reminderState = Effect.fn("reminderState")(function* (
  workspaceId: WorkspaceId,
  record: DocumentRecord,
  today: IsoDate,
) {
  const effective = yield* effectiveReminders(workspaceId, record, today);
  const deliveries = yield* (yield* DeliveriesRepo).byDocument(workspaceId, record.id);
  const arm = EffectArray.filter(deliveries, (d) => d.arms).at(-1)?.sequence ?? 0;
  const live = EffectArray.filter(
    deliveries,
    (d) =>
      d.reminder !== null &&
      d.reminder.dueOn === record.dueOn &&
      d.reminder.armedBy === arm &&
      !isReleased(d),
  );
  if (!stillOwed(record)) {
    return { effective, arm, block: "document_settled", live } as const;
  }
  const on = remindable({ ...record, remindersOn: isArmed(record, deliveries) }, effective);
  return {
    effective,
    arm,
    block: on ? null : "reminders_off",
    live,
  } as const satisfies ReminderState;
});

/** Why `step` is not (or no longer) the reminder to send on `today`; null when it is. */
export const stepBlock: {
  (
    record: Pick<DocumentRecord, "dueOn">,
    step: { readonly dueOn: IsoDate; readonly offsetDays: number; readonly armedBy: number },
    today: IsoDate,
    self?: DeliveryId | null,
  ): (state: ReminderState) => ReminderBlock | null;
  (
    state: ReminderState,
    record: Pick<DocumentRecord, "dueOn">,
    step: { readonly dueOn: IsoDate; readonly offsetDays: number; readonly armedBy: number },
    today: IsoDate,
    self?: DeliveryId | null,
  ): ReminderBlock | null;
} = Fn.dual(
  (args) => Predicate.hasProperty(args[0], "effective"),
  (
    state: ReminderState,
    record: Pick<DocumentRecord, "dueOn">,
    step: { readonly dueOn: IsoDate; readonly offsetDays: number; readonly armedBy: number },
    today: IsoDate,
    self: DeliveryId | null = null,
  ): ReminderBlock | null => {
    if (state.block !== null) return state.block;
    if (step.armedBy !== state.arm) return "reminder_rearmed";
    const date = addDaysWithinRange(step.dueOn, step.offsetDays);
    if (
      date === null ||
      step.dueOn !== record.dueOn ||
      !state.effective.offsetsDays.includes(step.offsetDays) ||
      date > today
    ) {
      return "reminder_step_stale";
    }
    const covered = EffectArray.some(state.live, (d) => {
      if (d.id === self || d.reminder === null) return false;
      const otherDate = addDaysWithinRange(d.reminder.dueOn, d.reminder.offsetDays);
      return otherDate !== null && otherDate >= date;
    });
    return covered ? "reminder_superseded" : null;
  },
);
