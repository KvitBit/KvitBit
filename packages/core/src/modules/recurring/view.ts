/**
 * The concrete `TemplateView` and `RecurringRunView` this module returns. The domain
 * `TemplateView` is an open struct (revision and schedule.pausedReason specified); this schema
 * fixes the rest, so request-log replays (C3) round-trip the template's decimals.
 */
import type { IsoDate, RecurringRunView, TemplateView } from "@kvitbit/domain/contract";
import {
  IsoDate as IsoDateSchema,
  IssueCode,
  ScheduleId,
  TemplateId,
  TemplateInput,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";
import type { DeliveryStatus } from "./deliveries";
import type { RunRow, ScheduleRow, TemplateRow } from "./repo";
import { ruleOf } from "./sweep";

export const ScheduleViewSchema = Schema.Struct({
  id: ScheduleId,
  every: Schema.Union([
    Schema.Struct({ weeks: Schema.Int }),
    Schema.Struct({ months: Schema.Int }),
    Schema.Struct({ years: Schema.Int }),
  ]),
  startOn: IsoDateSchema,
  endOn: Schema.NullOr(IsoDateSchema),
  issueAs: Schema.Literals(["invoice", "proforma"]),
  autoSend: Schema.Boolean,
  /** The occurrence the next sweep issues; null when the schedule has ended. */
  nextOccurrence: Schema.NullOr(IsoDateSchema),
  paused: Schema.Boolean,
  pausedReason: Schema.NullOr(IssueCode),
});

export const TemplateViewSchema = Schema.Struct({
  id: TemplateId,
  name: Schema.String,
  revision: Schema.Int,
  archived: Schema.Boolean,
  input: TemplateInput,
  schedule: Schema.NullOr(ScheduleViewSchema),
});
export type TemplateViewValue = typeof TemplateViewSchema.Type;

/** The schema as the domain's open `TemplateView` codec (for `withIdempotency`). */
export const TemplateViewCodec = TemplateViewSchema as unknown as Schema.Codec<
  TemplateView,
  unknown
>;

export const scheduleView = (row: ScheduleRow): typeof ScheduleViewSchema.Type => {
  const rule = ruleOf(row);
  return {
    id: row.id,
    every: rule.every,
    startOn: row.startOn,
    endOn: row.endOn,
    issueAs: row.issueAs,
    autoSend: row.autoSend,
    nextOccurrence: row.nextOccurrence,
    paused: row.pausedAt !== null,
    pausedReason: row.pausedReason,
  };
};

export const templateView = (row: TemplateRow, schedule: ScheduleRow | null): TemplateView => {
  const view: TemplateViewValue = {
    id: row.id,
    name: row.name,
    revision: row.revision,
    archived: row.archivedAt !== null,
    input: row.input,
    schedule: schedule === null ? null : scheduleView(schedule),
  };
  return view as unknown as TemplateView;
};

export const runView = (
  row: RunRow,
  deliveries: ReadonlyMap<string, DeliveryStatus>,
): RecurringRunView => ({
  occurrence: row.occurrence as IsoDate,
  outcome: row.outcome,
  at: row.at,
  document:
    row.documentId === null ? null : { id: row.documentId, number: row.documentNumber ?? "" },
  delivery:
    row.deliveryId === null
      ? null
      : { id: row.deliveryId, status: deliveries.get(row.deliveryId) ?? "queued" },
  failure: row.failure,
});
