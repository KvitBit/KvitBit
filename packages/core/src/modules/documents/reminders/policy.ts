/**
 * Rule D16 at selection time. The document stores only the choice a `send` gave
 * (`remindersChoice`) and whether a send armed reminders (`remindersOn`); the effective policy
 * is resolved Document -> Contact -> Workspace from the CURRENT Contact and Workspace policies
 * whenever reminders are previewed, selected or claimed, and reminder dates follow the current
 * due date. Nothing derived (offsets, dates) is stored.
 */

import type { IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import { type ReminderStep, Reminders } from "../../../engines/schedules";
import type { EffectiveReminders, RemindersChoice } from "../../../shared/overrides";
import { resolveReminders } from "../../../shared/overrides";
import { DocumentContacts, DocumentIssuers } from "../ports";
import type { DocumentRecord } from "../record";
import { hasFinalInvoice } from "../transitions";

/** The effective reminders for `record` with `choice` (default: the stored one). */
export const effectiveReminders = Effect.fn("effectiveReminders")(function* (
  workspaceId: WorkspaceId,
  record: Pick<DocumentRecord, "kind" | "contactId" | "remindersChoice">,
  today: IsoDate,
  choice: RemindersChoice = record.remindersChoice,
) {
  const contact = yield* (yield* DocumentContacts).forDocument(workspaceId, record.contactId);
  const issuer = yield* (yield* DocumentIssuers).forDocument(workspaceId, today);
  return resolveReminders({
    kind: record.kind,
    choice,
    contact: contact.defaults.reminderPolicy,
    workspace: issuer.reminders,
  });
});

/** The choice a `send` with purpose "document" stores (D16). */
export const choiceOf = (reminders: boolean | undefined): RemindersChoice =>
  reminders === undefined ? "inherit" : reminders ? "on" : "off";

/**
 * Something is still owed on an issued Invoice or Proforma (any reminder, D14 and the
 * DocumentDelivery claim): not cancelled, unpaid or partially paid, and not a Proforma whose
 * Final Invoice now carries the debt.
 */
export const stillOwed = (
  record: Pick<DocumentRecord, "kind" | "status" | "settlement" | "links">,
): boolean =>
  (record.kind === "invoice" || record.kind === "proforma") &&
  record.status === "issued" &&
  (record.settlement === "unpaid" || record.settlement === "partially_paid") &&
  !hasFinalInvoice(record);

/** Automatic reminders apply: owed, armed by a send and not turned off, policy arms now. */
export const remindable: {
  (
    effective: EffectiveReminders,
  ): (
    record: Pick<DocumentRecord, "kind" | "status" | "settlement" | "links" | "remindersOn">,
  ) => boolean;
  (
    record: Pick<DocumentRecord, "kind" | "status" | "settlement" | "links" | "remindersOn">,
    effective: EffectiveReminders,
  ): boolean;
} = Fn.dual(
  2,
  (
    record: Pick<DocumentRecord, "kind" | "status" | "settlement" | "links" | "remindersOn">,
    effective: EffectiveReminders,
  ): boolean => stillOwed(record) && record.remindersOn && effective.arms,
);

/** The reminder steps for the current due date (dates move with `dueOn`). */
export const scheduleOf: {
  (effective: EffectiveReminders): (dueOn: IsoDate) => ReadonlyArray<ReminderStep>;
  (dueOn: IsoDate, effective: EffectiveReminders): ReadonlyArray<ReminderStep>;
} = Fn.dual(
  2,
  (dueOn: IsoDate, effective: EffectiveReminders): ReadonlyArray<ReminderStep> =>
    Reminders.reminderSteps(dueOn, effective.offsetsDays),
);

/** The latest step due on `today`, if any; earlier missed steps are superseded by it. */
export const dueStep: {
  (effective: EffectiveReminders, today: IsoDate): (dueOn: IsoDate) => ReminderStep | null;
  (dueOn: IsoDate, effective: EffectiveReminders, today: IsoDate): ReminderStep | null;
} = Fn.dual(
  3,
  (dueOn: IsoDate, effective: EffectiveReminders, today: IsoDate): ReminderStep | null => {
    let latest: ReminderStep | null = null;
    for (const step of scheduleOf(dueOn, effective)) {
      if (step.date <= today && (latest === null || step.date >= latest.date)) latest = step;
    }
    return latest;
  },
);
