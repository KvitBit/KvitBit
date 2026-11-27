/**
 * Per-Contact billing overrides (core-ports section 4.2). Source of truth for the schema that
 * http-mcp-contracts 3.5 and ui-port-contracts 8.15 mirror.
 */
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import { NumberingSeriesId } from "./ids";
import { CurrencyCode, DocumentKind, Locale, PaymentMethod } from "./vocabulary";

export const ReminderPolicy = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("inherit") }), // follow the Workspace reminder schedule
  Schema.Struct({ mode: Schema.Literal("disabled") }), // no automatic reminders for this Contact
  Schema.Struct({ mode: Schema.Literal("custom"), offsetsDays: Schema.Array(Schema.Int) }), // days after due
]);
export type ReminderPolicy = typeof ReminderPolicy.Type;

export const ContactDefaults = Schema.Struct({
  currency: Schema.optional(CurrencyCode),
  language: Schema.optional(Locale),
  dueDays: Schema.optional(Schema.Int),
  paymentMethod: Schema.optional(PaymentMethod),
  /** Partial map: any subset of kinds, including none. A kind left out uses the Workspace default series. */
  preferredSeriesByKind: Schema.optional(
    Schema.Record(DocumentKind, Schema.optionalKey(NumberingSeriesId)),
  ),
  defaultNote: Schema.optional(Schema.String),
  reminderPolicy: Schema.optional(ReminderPolicy), // absent behaves as { mode: "inherit" }
});
export type ContactDefaults = typeof ContactDefaults.Type;

/**
 * The override chain for every Contact-overridable field: a value on the Document wins, then
 * the Contact's, then the Workspace default. `undefined` means "not set at this level".
 */
export const resolveDefault: {
  <A>(contact: A | undefined, workspace: A): (document: A | undefined) => A;
  <A>(document: A | undefined, contact: A | undefined, workspace: A): A;
} = Fn.dual(3, <A>(document: A | undefined, contact: A | undefined, workspace: A): A => {
  if (document !== undefined) {
    return document;
  }
  return contact === undefined ? workspace : contact;
});
