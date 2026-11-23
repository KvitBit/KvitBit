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
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
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
import { Authentication, WorkspaceMember } from "../security";
import { CoreErrors, WorkspaceParams } from "./shared";

// --- Contacts ----------------------------------------------------------------------------------

export const ContactRole = Schema.Literals(["customer", "supplier"]);
export type ContactRole = typeof ContactRole.Type;
export const FromIcoInput = Schema.Struct({
  ico: Schema.NonEmptyString,
  role: Schema.optional(ContactRole),
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
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/:contactId", {
      params: ContactParams,
      success: ContactView,
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("create", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: ContactInput,
      success: Created(ContactView),
      error: [Invalid.schema, Conflict.schema],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.put("update", "/:contactId", {
      params: ContactParams,
      headers: IfMatchHeaders,
      payload: ContactInput,
      success: ContactView,
      error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("fromIco", "/from-ico", {
      params: WorkspaceParams,
      payload: FromIcoInput,
      success: ContactView,
      error: [Invalid.schema, Unavailable.schema, RateLimited.schema],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("archive", "/:contactId/archive", {
      params: ContactParams,
      success: NoContent,
    }),
  )
  .prefix("/workspaces/:workspaceId/contacts")
  .middleware(Authentication)
  .middleware(WorkspaceMember) {}

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
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: PriceListItemInput,
      success: Created(PriceListItemView),
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/:itemId", {
      params: ItemParams,
      headers: IfMatchHeaders,
      payload: PriceListItemInput,
      success: PriceListItemView,
      error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("archive", "/:itemId/archive", { params: ItemParams, success: NoContent }),
  )
  .prefix("/workspaces/:workspaceId/price-list-items")
  .middleware(Authentication)
  .middleware(WorkspaceMember) {}

// --- Payments ----------------------------------------------------------------------------------

export const PaymentTarget = Schema.Union([
  Schema.Struct({ document: DocumentId }),
  Schema.Struct({ expense: ExpenseId }),
]);
export type PaymentTarget = typeof PaymentTarget.Type;

/** Core `RecordPaymentInput`. */
export const RecordPaymentInput = Schema.Struct({
  target: PaymentTarget,
  amount: Schema.optional(Money), // default: outstanding
  paidOn: Schema.optional(IsoDate), // default: today (Prague)
  method: Schema.optional(PaymentMethod),
  note: Schema.optional(Schema.String),
});
export type RecordPaymentInput = typeof RecordPaymentInput.Type;

export const RecordPaymentResult = Schema.Struct({
  payment: PaymentView,
  settlement: Schema.Literals(["partially_paid", "paid", "overpaid"]),
  issued: Schema.Array(DocumentView), // the auto-issued Payment Tax Document, if any (rule P2)
});
export type RecordPaymentResult = typeof RecordPaymentResult.Type;

export class PaymentsGroup extends HttpApiGroup.make("payments")
  .add(
    HttpApiEndpoint.post("record", "/payments", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: RecordPaymentInput,
      success: Created(RecordPaymentResult),
      error: CoreErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("remove", "/payments/:paymentId/remove", {
      params: { ...WorkspaceParams, paymentId: PaymentId },
      success: NoContent,
      error: Conflict.schema,
    }),
  )
  .add(
    HttpApiEndpoint.get("listForDocument", "/documents/:documentId/payments", {
      params: { ...WorkspaceParams, documentId: DocumentId },
      success: Schema.Array(PaymentView),
    }),
  )
  .add(
    HttpApiEndpoint.get("listForExpense", "/expenses/:expenseId/payments", {
      params: { ...WorkspaceParams, expenseId: ExpenseId },
      success: Schema.Array(PaymentView),
    }),
  )
  .prefix("/workspaces/:workspaceId")
  .middleware(Authentication)
  .middleware(WorkspaceMember) {}

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
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.post("record", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: ExpenseInput,
      success: Created(ExpenseView),
      error: [Invalid.schema, Unavailable.schema],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.get("get", "/:expenseId", {
      params: ExpenseParams,
      success: ExpenseView,
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.patch("edit", "/:expenseId", {
      params: ExpenseParams,
      headers: IfMatchHeaders,
      payload: ExpensePatch,
      success: ExpenseView,
      error: [Invalid.schema, Conflict.schema, Unavailable.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/:expenseId", {
      params: ExpenseParams,
      headers: IfMatchHeaders,
      success: NoContent,
      error: [Conflict.schema, ...RevisionedEdgeErrors],
    }),
  )
  .add(
    HttpApiEndpoint.post("attach", "/:expenseId/attachments", {
      params: ExpenseParams,
      payload: AttachPayload,
      success: Created(AttachmentView),
      error: [Invalid.schema, PayloadTooLarge.schema, Unavailable.schema],
    }),
  )
  .add(
    HttpApiEndpoint.get("attachment", "/:expenseId/attachments/:attachmentId", {
      params: AttachmentParams,
      query: { disposition: Schema.optional(Disposition) },
      success: AttachmentBytes,
      error: Unavailable.schema,
    }),
  )
  .add(
    HttpApiEndpoint.delete("detach", "/:expenseId/attachments/:attachmentId", {
      params: AttachmentParams,
      success: NoContent,
    }),
  )
  .prefix("/workspaces/:workspaceId/expenses")
  .middleware(Authentication)
  .middleware(WorkspaceMember) {}

// --- Templates ---------------------------------------------------------------------------------

/** Core `TemplateSchedule`: a `ScheduleRule` plus what to issue and whether to send. */
export const ScheduleInput = Schema.Struct({
  ...ScheduleRule.fields,
  issueAs: Schema.Literals(["invoice", "proforma"]),
  autoSend: Schema.Boolean,
});
export type ScheduleInput = typeof ScheduleInput.Type;

export const UseTemplateInput = Schema.Struct({
  as: Schema.optional(Schema.Literals(["draft", "issued"])),
  patch: Schema.optional(DocumentPatch),
});
export type UseTemplateInput = typeof UseTemplateInput.Type;

const TemplateParams = { ...WorkspaceParams, templateId: TemplateId };

export class TemplatesGroup extends HttpApiGroup.make("templates")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: WorkspaceParams,
      success: Schema.Array(TemplateView),
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/:templateId", {
      params: TemplateParams,
      success: TemplateView,
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("create", "/", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      payload: TemplateInput,
      success: Created(TemplateView),
      error: Invalid.schema,
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.put("update", "/:templateId", {
      params: TemplateParams,
      headers: IfMatchHeaders,
      payload: TemplateInput,
      success: TemplateView,
      error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("archive", "/:templateId/archive", {
      params: TemplateParams,
      success: NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.put("setSchedule", "/:templateId/schedule", {
      params: TemplateParams,
      headers: IfMatchHeaders,
      payload: ScheduleInput,
      success: TemplateView,
      error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.delete("removeSchedule", "/:templateId/schedule", {
      params: TemplateParams,
      headers: IfMatchHeaders,
      success: TemplateView,
      error: [Conflict.schema, ...RevisionedEdgeErrors],
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.post("resume", "/:templateId/resume", {
      params: TemplateParams,
      success: TemplateView,
      error: Conflict.schema,
    }).annotate(Revisioned, true),
  )
  .add(
    HttpApiEndpoint.get("runs", "/:templateId/runs", {
      params: TemplateParams,
      query: PageQueryFields,
      success: Page(RecurringRunView),
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.post("use", "/:templateId/documents", {
      params: TemplateParams,
      headers: IdempotencyHeaders,
      payload: UseTemplateInput,
      success: Created(DocumentView),
      error: CoreErrors,
    }).annotate(Revisioned, true),
  )
  .prefix("/workspaces/:workspaceId/templates")
  .middleware(Authentication)
  .middleware(WorkspaceMember) {}

// --- Reports -----------------------------------------------------------------------------------

export const ReportGroupBy = Schema.Literals(["month", "contact", "currency", "category"]);
export type ReportGroupBy = typeof ReportGroupBy.Type;
export const ReportRange = {
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
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.get("run", "/reports/:report", {
      params: { ...WorkspaceParams, report: ReportKind },
      query: ReportRange,
      success: ReportView,
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.get("export", "/reports/:report/export", {
      params: { ...WorkspaceParams, report: ReportKind },
      query: { format: ExportFormat, ...ReportRange },
      success: ReportExportBytes,
      error: Invalid.schema,
    }),
  )
  .add(
    HttpApiEndpoint.get("fxRate", "/fx-rates/:currency", {
      params: { ...WorkspaceParams, currency: CurrencyCode },
      query: { on: IsoDate },
      success: FxRateView,
      error: [Invalid.schema, Unavailable.schema],
    }),
  )
  .add(
    HttpApiEndpoint.post("startExport", "/exports", {
      params: WorkspaceParams,
      headers: IdempotencyHeaders,
      success: Accepted(ExportJobView),
    }),
  )
  .add(
    HttpApiEndpoint.get("getExport", "/exports/:exportId", {
      params: { ...WorkspaceParams, exportId: ExportId },
      success: ExportJobView,
    }),
  )
  .add(
    HttpApiEndpoint.get("exportFile", "/exports/:exportId/file", {
      params: { ...WorkspaceParams, exportId: ExportId },
      success: ZipBytes,
      error: Conflict.schema, // illegal_transition while running
    }),
  )
  .prefix("/workspaces/:workspaceId")
  .middleware(Authentication)
  .middleware(WorkspaceMember) {}
