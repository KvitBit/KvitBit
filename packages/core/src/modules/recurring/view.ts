/**
 * The concrete `TemplateView` and `RecurringRunView` this module returns. The domain
 * `TemplateView` is an open struct (revision and schedule.pausedReason specified); this schema
 * fixes the rest, so request-log replays (C3) round-trip the template's decimals.
 */

import type { RecurringRunView, TemplateView } from "@kvitbit/domain/contract";
import {
  IsoDate as IsoDateSchema,
  IssueCode,
  ScheduleId,
  TemplateId,
  TemplateInput,
} from "@kvitbit/domain/contract";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  /** Set when no IssueCode names the pausing error, e.g. `NotFound:Contact`. */
  pausedError: Schema.NullOr(Schema.String),
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
    pausedError: row.pausedError,
  };
};

export const templateView: {
  (schedule: ScheduleRow | null): (row: TemplateRow) => TemplateView;
  (row: TemplateRow, schedule: ScheduleRow | null): TemplateView;
} = Fn.dual(2, (row: TemplateRow, schedule: ScheduleRow | null): TemplateView => {
  const view: TemplateViewValue = {
    id: row.id,
    name: row.name,
    revision: row.revision,
    archived: row.archivedAt !== null,
    input: row.input,
    schedule: schedule === null ? null : scheduleView(schedule),
  };
  return view;
});

/** A run's delivery always exists (FK `schedule_runs_delivery_fk`); a missing one is a bug. */
class MissingRunDelivery extends Schema.TaggedError<
  MissingRunDelivery,
  { readonly brand: unique symbol }
>()("MissingRunDelivery", {
  id: Schema.String,
}) {
  override get message(): string {
    return `schedule run delivery ${this.id} has no status`;
  }
}

const statusOf = (deliveries: ReadonlyMap<string, DeliveryStatus>, id: string): DeliveryStatus =>
  Option.fromUndefinedOr(deliveries.get(id)).pipe(
    Option.getOrThrowWith(() => MissingRunDelivery.make({ id })),
  );

/** Throws (a defect inside Effect) when a run's delivery has no status. */
export const runView: {
  (deliveries: ReadonlyMap<string, DeliveryStatus>): (row: RunRow) => RecurringRunView;
  (row: RunRow, deliveries: ReadonlyMap<string, DeliveryStatus>): RecurringRunView;
} = Fn.dual(
  2,
  (row: RunRow, deliveries: ReadonlyMap<string, DeliveryStatus>): RecurringRunView => ({
    occurrence: row.occurrence,
    outcome: row.outcome,
    at: row.at,
    document:
      row.documentId === null ? null : { id: row.documentId, number: row.documentNumber ?? "" },
    delivery:
      row.deliveryId === null
        ? null
        : { id: row.deliveryId, status: statusOf(deliveries, row.deliveryId) },
    failure: row.failure,
  }),
);
