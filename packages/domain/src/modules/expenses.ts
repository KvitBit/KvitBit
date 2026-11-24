/** Expenses (core-ports 4.7) and Templates (core-ports 4.8). Interfaces only. */
import type { Effect, Stream } from "effect";
import { Context, Schema, Struct } from "effect";
import { IssueCode } from "../action";
import type { CurrentCaller } from "../caller";
import type { Conflict, CoreError, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import type { AttachmentId, ExpenseId, TemplateId } from "../ids";
import { DeliveryId, DocumentId } from "../ids";
import type { FileDownload, ScheduleRule } from "../shared";
import { OpenStruct } from "../shared";
import type { Page, RequestOptions } from "../vocabulary";
import { IsoDate, PageRequest } from "../vocabulary";
import type { DocumentPatch, DocumentView } from "./documents";
import { DocumentInput } from "./documents";

export const ExpenseStatus = Schema.Literals(["complete", "incomplete"]);
export type ExpenseStatus = typeof ExpenseStatus.Type;

/** Supplier, dates, VAT breakdown, category, tags; `status?: ExpenseStatus` (default "complete"). */
export const ExpenseInput = OpenStruct({
  status: Schema.optional(ExpenseStatus), // default "complete"
});
export type ExpenseInput = typeof ExpenseInput.Type;
/** `status?: ExpenseStatus`; "complete" runs the full validation. */
export const ExpensePatch = OpenStruct({
  status: Schema.optional(ExpenseStatus),
});
export type ExpensePatch = typeof ExpensePatch.Type;
/** Carries `status: ExpenseStatus`. */
export const ExpenseView = OpenStruct({
  status: ExpenseStatus,
  revision: Schema.Int, // edit and remove take expectedRevision (rule C2)
});
export type ExpenseView = typeof ExpenseView.Type;
/** Carries `status: ExpenseStatus`. */
export const ExpenseSummary = OpenStruct({
  status: ExpenseStatus,
});
export type ExpenseSummary = typeof ExpenseSummary.Type;
/** `incomplete?: boolean` plus cursor and limit (PageRequest). */
export const ExpenseQuery = OpenStruct({
  incomplete: Schema.optional(Schema.Boolean), // true lists only incomplete Expenses
  ...PageRequest.fields,
});
export type ExpenseQuery = typeof ExpenseQuery.Type;
export const AttachmentView = Schema.Unknown.pipe(Schema.brand("AttachmentView"));
export type AttachmentView = typeof AttachmentView.Type;

export class Expenses extends Context.Service<
  Expenses,
  {
    /** Supplier is a Contact or an IČO (resolved through Contacts.fromIco). */
    readonly record: (
      input: ExpenseInput,
      opts?: RequestOptions,
    ) => Effect.Effect<
      ExpenseView,
      Invalid | NotFound | Conflict | Unavailable | Forbidden,
      CurrentCaller
    >;
    readonly edit: (
      id: ExpenseId,
      patch: ExpensePatch,
      expectedRevision: number,
    ) => Effect.Effect<
      ExpenseView,
      NotFound | Invalid | Conflict | Unavailable | Forbidden,
      CurrentCaller
    >;
    readonly remove: (
      id: ExpenseId,
      expectedRevision: number,
    ) => Effect.Effect<void, NotFound | Conflict | Unavailable | Forbidden, CurrentCaller>;
    readonly attach: (
      id: ExpenseId,
      file: {
        readonly name: string;
        readonly contentType: string;
        readonly bytes: Stream.Stream<Uint8Array>;
      },
    ) => Effect.Effect<AttachmentView, NotFound | Invalid | Unavailable | Forbidden, CurrentCaller>;
    readonly detach: (
      id: ExpenseId,
      attachment: AttachmentId,
    ) => Effect.Effect<void, NotFound | Unavailable | Forbidden, CurrentCaller>;
    readonly attachment: (
      id: ExpenseId,
      attachment: AttachmentId,
    ) => Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>;
    readonly get: (
      id: ExpenseId,
    ) => Effect.Effect<ExpenseView, NotFound | Unavailable | Forbidden, CurrentCaller>;
    readonly list: (
      q: ExpenseQuery,
    ) => Effect.Effect<Page<ExpenseSummary>, Invalid | Unavailable | Forbidden, CurrentCaller>;
  }
>()("kvitbit/Expenses") {}

/** DocumentInput without issuedOn/taxableSupplyOn plus name and a relative due (inDays). */
export const TemplateInput = Schema.Struct({
  ...Struct.omit(DocumentInput.fields, ["issuedOn", "taxableSupplyOn", "due"]),
  name: Schema.String,
  due: Schema.optional(Schema.Struct({ inDays: Schema.Int })),
});
export type TemplateInput = typeof TemplateInput.Type;
/** Partly specified: revision and schedule.pausedReason (open). */
export const TemplateView = OpenStruct({
  revision: Schema.Int, // save (existing) and schedule take expectedRevision (rule C2)
  /** The Recurring Schedule, null when none is attached. Other schedule fields are open. */
  schedule: Schema.NullOr(
    OpenStruct({
      pausedReason: Schema.NullOr(IssueCode), // set when a failed occurrence paused the schedule
    }),
  ),
});
export type TemplateView = typeof TemplateView.Type;

/** The `schedule` argument: a ScheduleRule plus issueAs and autoSend. */
export interface TemplateSchedule extends ScheduleRule {
  readonly issueAs: "invoice" | "proforma";
  readonly autoSend: boolean;
}

export const RecurringRunView = Schema.Struct({
  occurrence: IsoDate,
  outcome: Schema.Literals(["issued", "failed", "skipped_missed"]), // skipped_missed: paused by the catch-up cap
  at: Schema.String, // when the run finished
  document: Schema.NullOr(Schema.Struct({ id: DocumentId, number: Schema.String })),
  delivery: Schema.NullOr(
    Schema.Struct({
      id: DeliveryId,
      status: Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]),
    }),
  ),
  failure: Schema.NullOr(IssueCode), // why the run paused the schedule
});
export type RecurringRunView = typeof RecurringRunView.Type;

/** Owns Invoice Templates and their Recurring Schedules. */
export class Templates extends Context.Service<
  Templates,
  {
    readonly save: (
      input: TemplateInput & { readonly id?: TemplateId; readonly expectedRevision?: number },
      opts?: RequestOptions,
    ) => Effect.Effect<
      TemplateView,
      Invalid | NotFound | Conflict | Unavailable | Forbidden,
      CurrentCaller
    >;
    readonly archive: (
      id: TemplateId,
    ) => Effect.Effect<void, NotFound | Unavailable | Forbidden, CurrentCaller>;
    /** Attach, change, or detach (null) the Recurring Schedule. Durable once this returns. */
    readonly schedule: (
      template: TemplateId,
      schedule: TemplateSchedule | null,
      expectedRevision: number,
    ) => Effect.Effect<
      TemplateView,
      Invalid | NotFound | Conflict | Unavailable | Forbidden,
      CurrentCaller
    >;
    /** Clears a failure pause; the next sweep issues due occurrences. */
    readonly resume: (
      template: TemplateId,
    ) => Effect.Effect<TemplateView, NotFound | Conflict | Unavailable | Forbidden, CurrentCaller>;
    /** Manual use: delegates to Documents.createDraft or Documents.issue with template values as defaults. */
    readonly use: (
      template: TemplateId,
      input?: { readonly as?: "draft" | "issued"; readonly patch?: DocumentPatch },
      opts?: RequestOptions,
    ) => Effect.Effect<DocumentView, CoreError, CurrentCaller>;
    readonly get: (
      id: TemplateId,
    ) => Effect.Effect<TemplateView, NotFound | Unavailable | Forbidden, CurrentCaller>;
    readonly list: Effect.Effect<
      ReadonlyArray<TemplateView>,
      Unavailable | Forbidden,
      CurrentCaller
    >;
    /** Run history of the template's Recurring Schedule, newest occurrence first. */
    readonly runs: (
      template: TemplateId,
      page?: PageRequest,
    ) => Effect.Effect<
      Page<RecurringRunView>,
      Invalid | NotFound | Unavailable | Forbidden,
      CurrentCaller
    >;
  }
>()("kvitbit/Templates") {}
