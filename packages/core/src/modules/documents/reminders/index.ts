/**
 * Payment reminders (rule D16) resolved at selection time, no stored schedule:
 * - policy.ts  `effectiveReminders` (resolveReminders over the CURRENT Contact and Workspace
 *              policies), `choiceOf`, `stillOwed`, `remindable`, `scheduleOf`, `dueStep`.
 * - select.ts  `selectDueReminders(ws, today)` and `enqueueReminder(ws, due)` (re-checked
 *              under the document lock; the DocumentDelivery claim re-checks again).
 */
export { choiceOf, dueStep, effectiveReminders, remindable, scheduleOf, stillOwed } from "./policy";
export type { DueReminder } from "./select";
export type { ReminderBlock, ReminderState } from "./eligibility";
export { reminderState, stepBlock } from "./eligibility";
export { dueReminderOf, enqueueReminder, selectDueReminders } from "./select";
