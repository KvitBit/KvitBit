/**
 * Recurring module, Templates part (core-ports 4.8, 5.6, 7.2, 7.3): Invoice Templates, their
 * Recurring Schedules, and the steps RecurringIssuance / RecurringSweep call. Reminders and
 * deliveries live in the Documents module.
 *
 * - `TemplatesLive`: the domain `Templates` tag.
 * - `RecurringIssuanceLive`: core-internal steps (issue, send, run, pauseMissed, due, sweep)
 *   for the workflow and cron defined later; they run only as the System caller of the job.
 * - `decideDue` and friends (./sweep): the pure sweep decisions.
 */
import { Layer } from "effect";
import { FakeDeliveryStatuses } from "./deliveries";
import { RecurringIssuanceLive } from "./issuance";
import { FakeDocumentLinks } from "./links";
import { RecurringRepoMemory } from "./repo";
import { TemplatesLive } from "./service";

export type { DeliveryStatus } from "./deliveries";
export { DeliveryStatusLookup, FakeDeliveryStatuses } from "./deliveries";
export type { IssueOutcome, OccurrenceResult, SendOutcome, SkipReason } from "./issuance";
export {
  makeRecurringIssuance,
  occurrenceKey,
  RecurringIssuance,
  RecurringIssuanceLive,
} from "./issuance";
export type { OccurrenceLink } from "./links";
export { FakeDocumentLinks, RecurringDocumentLink } from "./links";
export type { RunOutcome, RunSend, RunsQuery } from "./repo";
export {
  CadenceUnit,
  dieOnUnique,
  ONE_ATTACHED_PER_TEMPLATE,
  RecurringRepo,
  RecurringRepoMemory,
  RUN_PER_OCCURRENCE,
  RunRow,
  ScheduleRow,
  ScheduleRunsTable,
  SchedulesTable,
  TemplateRow,
  TemplatesTable,
} from "./repo";
export type { TemplatesImpl } from "./service";
export { documentInputOf, makeTemplates, TemplatesLive } from "./service";
export type { DueAction, IssueEligibility, SweepDecision } from "./sweep";
export {
  CATCH_UP_DAYS,
  decideDue,
  firstOccurrenceFrom,
  isMissed,
  issueEligibility,
  occurrenceAfter,
  ruleOf,
  startingOccurrence,
} from "./sweep";
export type { TemplateViewValue } from "./view";
export {
  runView,
  ScheduleViewSchema,
  scheduleView,
  TemplateViewSchema,
  templateView,
} from "./view";

/**
 * `Templates` + `RecurringIssuance` on the in-memory repo, fake delivery statuses and fake
 * document links (also exposed: `FakeDeliveryStatuses`, `FakeDocumentLinks`). Needs `InMemoryPortsLive` (CoreStore,
 * MemoryTables, IdGenerator) and a `Documents` layer (a stub in tests).
 */
export const RecurringTestLayer = Layer.mergeAll(TemplatesLive, RecurringIssuanceLive).pipe(
  Layer.provideMerge(
    Layer.mergeAll(RecurringRepoMemory, FakeDeliveryStatuses.layer, FakeDocumentLinks.layer),
  ),
);
