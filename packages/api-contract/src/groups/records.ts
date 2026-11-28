/**
 * Contacts, Price List, payments, Expenses, Templates and reports
 * (http-mcp-contracts section 3.5.4).
 */

import {
  AttachmentId,
  AttachmentView,
  Conflict,
  ContactId,
  ContactInput,
  ContactView,
  CurrencyCode,
  DashboardView,
  DocumentId,
  DocumentPatch,
  DocumentView,
  ExpenseId,
  ExpenseInput,
  ExpensePatch,
  ExpenseSummary,
  ExpenseView,
  ExportId,
  ExportJobView,
  FxRateView,
  Invalid,
  IsoDate,
  Money,
  NotFound,
  Page,
  PaymentId,
  PaymentMethod,
  PaymentView,
  PriceListItemId,
  PriceListItemInput,
  PriceListItemView,
  RecurringRunView,
  ReportKind,
  ReportView,
  ScheduleRule,
  TemplateId,
  TemplateInput,
  TemplateView,
  Unavailable,
} from "@kvitbit/domain/contract";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import { PayloadTooLarge, RateLimited, RevisionedEdgeErrors } from "../edge-errors";
import {
  Accepted,
  AttachmentBytes,
  AttachPayload,
  Created,
  Disposition,
  IdempotencyHeaders,
  IfMatchHeaders,
  NoContent,
  PageQueryFields,
  ReportExportBytes,
  Revisioned,
  ZipBytes,
} from "../http";
import { Authentication, EdgeGuard, WorkspaceMember } from "../security";
import { CoreErrors, WorkspaceParams } from "./shared";

// --- Contacts ----------------------------------------------------------------------------------

export const ContactRole = Schema.Literals(["customer", "supplier"]);
export type ContactRole = typeof ContactRole.Type;
export const FromIcoInput = Schema.Struct({
  ico: Schema.NonEmptyString,
  role: Schema.optionalKey(ContactRole),
});
export type FromIcoInput = typeof FromIcoInput.Type;

const ContactParams = { ...WorkspaceParams, contactId: ContactId };

export class ContactsGroup extends HttpApiGroup.make("contacts")
  .add(
    HttpApiEndpoint.get("search", "/", {
      params: WorkspaceParams,
      query: {
        text: Schema.optional(Schema.String),
        role: Schema.optional(ContactRole),
        ...PageQueryFields,
      },
      success: Page(ContactView),
      error: [Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Search contacts"),
  )
  .add(
    HttpApiEndpoint.get("get", "/:contactId", {
      params: ContactParams,
      success: ContactView,
      error: [Unavailable.schema, NotFound.schema],
    })
      .annotate(OpenApi.Summary, "Get a contact")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("create", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: ContactInput,
      success: Created(ContactView),
      error: [Invalid.schema, Conflict.schema, Unavailable.schema, NotFound.schema],
    })
      .annotate(OpenApi.Summary, "Create a contact")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.put("update", "/:contactId", {
      params: ContactParams,
      headers: IfMatchHeaders,
      payload: ContactInput,
      success: ContactView,
      error: [
        Invalid.schema,
        Conflict.schema,
        Unavailable.schema,
        ...RevisionedEdgeErrors,
        NotFound.schema,
      ],
    })
      .annotate(OpenApi.Summary, "Update a contact")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("fromIco", "/from-ico", {
      params: WorkspaceParams,
      payload: FromIcoInput,
      success: ContactView,
      error: [Invalid.schema, Unavailable.schema, RateLimited.schema, NotFound.schema],
    })
      .annotate(OpenApi.Summary, "Create or refresh a contact from the company registry")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("archive", "/:contactId/archive", {
      params: ContactParams,
      success: NoContent,
      error: [Unavailable.schema, NotFound.schema],
    }).annotate(OpenApi.Summary, "Archive a contact"),
  )
  .prefix("/workspaces/:workspaceId/contacts")
  .middleware(WorkspaceMember)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

// --- Price List --------------------------------------------------------------------------------

const ItemParams = { ...WorkspaceParams, itemId: PriceListItemId };

export class PriceListGroup extends HttpApiGroup.make("priceList")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: WorkspaceParams,
      query: {
        text: Schema.optional(Schema.String),
        includeArchived: Schema.optional(Schema.Boolean),
      },
      success: Schema.Array(PriceListItemView),
      error: Unavailable.schema,
    }).annotate(OpenApi.Summary, "List price list items"),
  )
  .add(
    HttpApiEndpoint.post("create", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: PriceListItemInput,
      success: Created(PriceListItemView),
      error: [Invalid.schema, NotFound.schema, Conflict.schema, Unavailable.schema],
    })
      .annotate(OpenApi.Summary, "Create a price list item")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.put("update", "/:itemId", {
      params: ItemParams,
      headers: IfMatchHeaders,
      payload: PriceListItemInput,
      success: PriceListItemView,
      error: [
        Invalid.schema,
        Conflict.schema,
        Unavailable.schema,
        ...RevisionedEdgeErrors,
        NotFound.schema,
      ],
    })
      .annotate(OpenApi.Summary, "Update a price list item")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("archive", "/:itemId/archive", {
      params: ItemParams,
      success: NoContent,
      error: [Unavailable.schema, NotFound.schema],
    }).annotate(OpenApi.Summary, "Archive a price list item"),
  )
  .prefix("/workspaces/:workspaceId/price-list-items")
  .middleware(WorkspaceMember)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

// --- Payments ----------------------------------------------------------------------------------

export const PaymentTarget = Schema.Union([
  Schema.Struct({ document: DocumentId }),
  Schema.Struct({ expense: ExpenseId }),
]);
export type PaymentTarget = typeof PaymentTarget.Type;

/** Core `RecordPaymentInput`. */
export const RecordPaymentInput = Schema.Struct({
  target: PaymentTarget,
  amount: Schema.optionalKey(Money), // default: outstanding
  paidOn: Schema.optionalKey(IsoDate), // default: today (Prague)
  method: Schema.optionalKey(PaymentMethod),
  note: Schema.optionalKey(Schema.String),
});
export type RecordPaymentInput = typeof RecordPaymentInput.Type;

export const RecordPaymentResult = Schema.Struct({
  payment: PaymentView,
  settlement: Schema.Literals(["partially_paid", "paid", "overpaid"]),
  issued: Schema.Array(DocumentView), // the auto-issued Payment Tax Document, if any (rule P2)
});
export type RecordPaymentResult = typeof RecordPaymentResult.Type;

/** `Payments.remove(id, reason)`: the reason lands in the audit trail. */
export const RemovePaymentInput = Schema.Struct({ reason: Schema.NonEmptyString });
export type RemovePaymentInput = typeof RemovePaymentInput.Type;

export class PaymentsGroup extends HttpApiGroup.make("payments")
  .add(
    HttpApiEndpoint.post("record", "/payments", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: RecordPaymentInput,
      success: Created(RecordPaymentResult),
      error: CoreErrors,
    }).annotate(OpenApi.Summary, "Record a payment"),
  )
  .add(
    HttpApiEndpoint.post("remove", "/payments/:paymentId/remove", {
      params: { ...WorkspaceParams, paymentId: PaymentId },
      payload: RemovePaymentInput,
      success: NoContent,
      error: [Conflict.schema, NotFound.schema, Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Remove a payment"),
  )
  .add(
    HttpApiEndpoint.get("listForDocument", "/documents/:documentId/payments", {
      params: { ...WorkspaceParams, documentId: DocumentId },
      success: Schema.Array(PaymentView),
      error: [NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "List a document's payments"),
  )
  .add(
    HttpApiEndpoint.get("listForExpense", "/expenses/:expenseId/payments", {
      params: { ...WorkspaceParams, expenseId: ExpenseId },
      success: Schema.Array(PaymentView),
      error: [NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "List an expense's payments"),
  )
  .prefix("/workspaces/:workspaceId")
  .middleware(WorkspaceMember)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

// --- Expenses ----------------------------------------------------------------------------------

/**
 * List filters. Core's `ExpenseQuery` is only partly specified (`incomplete` plus paging), so
 * the wire accepts exactly the specified filter until core fixes the rest.
 */
export const ExpenseListQuery = {
  incomplete: Schema.optional(Schema.Boolean),
  ...PageQueryFields,
};

const ExpenseParams = { ...WorkspaceParams, expenseId: ExpenseId };
const AttachmentParams = { ...ExpenseParams, attachmentId: AttachmentId };

export class ExpensesGroup extends HttpApiGroup.make("expenses")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: WorkspaceParams,
      query: ExpenseListQuery,
      success: Page(ExpenseSummary),
      error: [Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "List expenses"),
  )
  .add(
    HttpApiEndpoint.post("record", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: ExpenseInput,
      success: Created(ExpenseView),
      error: [Invalid.schema, Unavailable.schema, NotFound.schema, Conflict.schema],
    })
      .annotate(OpenApi.Summary, "Record an expense")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.get("get", "/:expenseId", {
      params: ExpenseParams,
      success: ExpenseView,
      error: [Unavailable.schema, NotFound.schema],
    })
      .annotate(OpenApi.Summary, "Get an expense")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.patch("edit", "/:expenseId", {
      params: ExpenseParams,
      headers: IfMatchHeaders,
      payload: ExpensePatch,
      success: ExpenseView,
      error: [
        Invalid.schema,
        Conflict.schema,
        Unavailable.schema,
        ...RevisionedEdgeErrors,
        NotFound.schema,
      ],
    })
      .annotate(OpenApi.Summary, "Edit an expense")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/:expenseId", {
      params: ExpenseParams,
      headers: IfMatchHeaders,
      success: NoContent,
      error: [Conflict.schema, Unavailable.schema, ...RevisionedEdgeErrors, NotFound.schema],
    }).annotate(OpenApi.Summary, "Remove an expense"),
  )
  .add(
    HttpApiEndpoint.post("attach", "/:expenseId/attachments", {
      params: ExpenseParams,
      payload: AttachPayload,
      success: Created(AttachmentView),
      error: [Invalid.schema, PayloadTooLarge.schema, Unavailable.schema, NotFound.schema],
    }).annotate(OpenApi.Summary, "Attach a file to an expense"),
  )
  .add(
    HttpApiEndpoint.get("attachment", "/:expenseId/attachments/:attachmentId", {
      params: AttachmentParams,
      query: { disposition: Schema.optional(Disposition) },
      success: AttachmentBytes,
      error: [Unavailable.schema, NotFound.schema],
    }).annotate(OpenApi.Summary, "Download an expense attachment"),
  )
  .add(
    HttpApiEndpoint.delete("detach", "/:expenseId/attachments/:attachmentId", {
      params: AttachmentParams,
      success: NoContent,
      error: [Unavailable.schema, NotFound.schema],
    }).annotate(OpenApi.Summary, "Remove an expense attachment"),
  )
  .prefix("/workspaces/:workspaceId/expenses")
  .middleware(WorkspaceMember)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

// --- Templates ---------------------------------------------------------------------------------

/** Core `TemplateSchedule`: a `ScheduleRule` plus what to issue and whether to send. */
export const ScheduleInput = Schema.Struct({
  ...ScheduleRule.fields,
  issueAs: Schema.Literals(["invoice", "proforma"]),
  autoSend: Schema.Boolean,
});
export type ScheduleInput = typeof ScheduleInput.Type;

export const UseTemplateInput = Schema.Struct({
  as: Schema.optionalKey(Schema.Literals(["draft", "issued"])),
  patch: Schema.optionalKey(DocumentPatch),
});
export type UseTemplateInput = typeof UseTemplateInput.Type;

const TemplateParams = { ...WorkspaceParams, templateId: TemplateId };

export class TemplatesGroup extends HttpApiGroup.make("templates")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: WorkspaceParams,
      success: Schema.Array(TemplateView),
      error: Unavailable.schema,
    }).annotate(OpenApi.Summary, "List templates"),
  )
  .add(
    HttpApiEndpoint.get("get", "/:templateId", {
      params: TemplateParams,
      success: TemplateView,
      error: [Unavailable.schema, NotFound.schema],
    })
      .annotate(OpenApi.Summary, "Get a template")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("create", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: TemplateInput,
      success: Created(TemplateView),
      error: [Invalid.schema, NotFound.schema, Conflict.schema, Unavailable.schema],
    })
      .annotate(OpenApi.Summary, "Create a template")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.put("update", "/:templateId", {
      params: TemplateParams,
      headers: IfMatchHeaders,
      payload: TemplateInput,
      success: TemplateView,
      error: [
        Invalid.schema,
        Conflict.schema,
        Unavailable.schema,
        ...RevisionedEdgeErrors,
        NotFound.schema,
      ],
    })
      .annotate(OpenApi.Summary, "Update a template")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("archive", "/:templateId/archive", {
      params: TemplateParams,
      success: NoContent,
      error: [Unavailable.schema, NotFound.schema],
    }).annotate(OpenApi.Summary, "Archive a template"),
  )
  .add(
    HttpApiEndpoint.put("setSchedule", "/:templateId/schedule", {
      params: TemplateParams,
      headers: IfMatchHeaders,
      payload: ScheduleInput,
      success: TemplateView,
      error: [
        Invalid.schema,
        Conflict.schema,
        Unavailable.schema,
        ...RevisionedEdgeErrors,
        NotFound.schema,
      ],
    })
      .annotate(OpenApi.Summary, "Set a template's schedule")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.delete("removeSchedule", "/:templateId/schedule", {
      params: TemplateParams,
      headers: IfMatchHeaders,
      success: TemplateView,
      error: [
        Conflict.schema,
        ...RevisionedEdgeErrors,
        Invalid.schema,
        Unavailable.schema,
        NotFound.schema,
      ],
    })
      .annotate(OpenApi.Summary, "Remove a template's schedule")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("resume", "/:templateId/resume", {
      params: TemplateParams,
      success: TemplateView,
      error: [Conflict.schema, Unavailable.schema, NotFound.schema],
    })
      .annotate(OpenApi.Summary, "Resume a paused template schedule")
      .annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.get("runs", "/:templateId/runs", {
      params: TemplateParams,
      query: PageQueryFields,
      success: Page(RecurringRunView),
      error: [Invalid.schema, Unavailable.schema, NotFound.schema],
    }).annotate(OpenApi.Summary, "List a template's scheduled runs"),
  )
  .add(
    HttpApiEndpoint.post("use", "/:templateId/documents", {
      params: TemplateParams,
      headers: IdempotencyHeaders,
      payload: UseTemplateInput,
      success: Created(DocumentView),
      error: CoreErrors,
    })
      .annotate(OpenApi.Summary, "Create a document from a template")
      .annotate(Revisioned, true),
  )
  .prefix("/workspaces/:workspaceId/templates")
  .middleware(WorkspaceMember)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}

// --- Reports -----------------------------------------------------------------------------------

export const ReportGroupBy = Schema.Literals(["month", "contact", "currency", "category"]);
export type ReportGroupBy = typeof ReportGroupBy.Type;
const ReportRange = {
  from: IsoDate,
  to: IsoDate,
  groupBy: Schema.optional(ReportGroupBy),
};
export const ExportFormat = Schema.Literals(["csv", "pdf"]);
export type ExportFormat = typeof ExportFormat.Type;

export class ReportsGroup extends HttpApiGroup.make("reports")
  .add(
    HttpApiEndpoint.get("dashboard", "/reports/dashboard", {
      params: WorkspaceParams,
      query: { from: IsoDate, to: IsoDate },
      success: DashboardView,
      error: [Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Get the dashboard"),
  )
  .add(
    HttpApiEndpoint.get("run", "/reports/:report", {
      params: { ...WorkspaceParams, report: ReportKind },
      query: ReportRange,
      success: ReportView,
      error: [Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Run a report"),
  )
  .add(
    HttpApiEndpoint.get("export", "/reports/:report/export", {
      params: { ...WorkspaceParams, report: ReportKind },
      query: { format: ExportFormat, ...ReportRange },
      success: ReportExportBytes,
      error: [Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Export a report"),
  )
  .add(
    HttpApiEndpoint.get("fxRate", "/fx-rates/:currency", {
      params: { ...WorkspaceParams, currency: CurrencyCode },
      query: { on: IsoDate },
      success: FxRateView,
      error: [Invalid.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Get an exchange rate"),
  )
  .add(
    HttpApiEndpoint.post("startExport", "/exports", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      success: Accepted(ExportJobView),
      error: [Conflict.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Start a data export"),
  )
  .add(
    HttpApiEndpoint.get("getExport", "/exports/:exportId", {
      params: { ...WorkspaceParams, exportId: ExportId },
      success: ExportJobView,
      error: [NotFound.schema, Unavailable.schema],
    }).annotate(OpenApi.Summary, "Get a data export's status"),
  )
  .add(
    HttpApiEndpoint.get("exportFile", "/exports/:exportId/file", {
      params: { ...WorkspaceParams, exportId: ExportId },
      success: ZipBytes,
      error: [Conflict.schema, NotFound.schema, Unavailable.schema], // Conflict: still running
    }).annotate(OpenApi.Summary, "Download a data export"),
  )
  .prefix("/workspaces/:workspaceId")
  .middleware(WorkspaceMember)
  .middleware(EdgeGuard)
  .middleware(Authentication) {}
