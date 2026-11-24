/**
 * Document deliveries (core-ports 4.4 send/previewSend, rules D13-D16, J1-J3, 7.2
 * DocumentDelivery steps):
 * - record.ts  `DeliveryRecord` (`deliveries` table, J3 snapshot), `DeliveryStatus`, unique
 *              `deliveries_reminder_step` [documentId, dueOn, offsetDays] for automatic reminders.
 * - repo.ts    `DeliveriesRepo` port + `DeliveriesRepoMemory`; `statuses` backs the recurring
 *              module's `DeliveryStatusLookup` (board #399).
 * - jobs.ts    `DeliveryJobs` (start after commit, J1; integration binds Workflow.execute) +
 *              `DeliveryJobsMemory` / `StartedDeliveries` for tests.
 * - send.ts    send, previewSend, the shared `plan`, `queueDelivery`.
 * - steps.ts   job steps claim / dispatch / giveUp / deliver, `DeliveryRetry`, and
 *              `reconcileStaleDeliveries` (OutboxReconcile for queued/sending rows, J1a).
 * - sender.ts  `DocumentSenderLive` (the `DocumentSender` seam's real layer).
 */

export type { StartedDelivery } from "./jobs";
export { DeliveryJobs, DeliveryJobsMemory, StartedDeliveries } from "./jobs";
export type { DeliveryRecord, DeliveryStatus, ReminderStepRecord } from "./record";
export {
  DeliveriesTable,
  DeliveryStatus as DeliveryStatusSchema,
  DOCUMENT_SEQUENCE,
  isTerminal,
  REMINDER_STEP,
} from "./record";
export { DeliveriesRepo, DeliveriesRepoMemory } from "./repo";
export type { SendPlan } from "./send";
export {
  attachmentOf,
  plan,
  previewOf,
  previewSend,
  queueDelivery,
  SendResultCodec,
  send,
  subjectOf,
} from "./send";
export type { DocumentSenderDeps } from "./sender";
export { DocumentSenderLive } from "./sender";
export {
  claim,
  DeliveryRetry,
  deliver,
  dispatch,
  giveUp,
  reconcileStaleDeliveries,
} from "./steps";
