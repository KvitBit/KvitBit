/**
 * Remote MCP adapter contract (http-mcp-contracts section 6): tool names, argument and result
 * schemas, the scope and actions each tool needs, the two-step preview-then-confirm schemas and
 * the resource catalog. The MCP server runtime lives in apps/server.
 *
 * MCP requires `inputSchema` and `outputSchema` to be JSON Schemas of `type: "object"`, so every
 * argument schema is a struct and array results are wrapped as `{ items }`. Use
 * `toolJsonSchema` to generate them.
 */

import {
  type Action,
  type AttachmentId,
  AuditEntry,
  ContactId,
  ContactInput,
  ContactView,
  CoreError,
  CurrencyCode,
  DocumentId,
  DocumentInput,
  DocumentKind,
  DocumentPatch,
  DocumentQuery,
  DocumentSummary,
  DocumentView,
  ExpenseId,
  ExpenseInput,
  ExpenseSummary,
  ExpenseView,
  FxRateView,
  IsoDate,
  Locale,
  Money,
  NumberingSeriesView,
  Page,
  PaymentMethod,
  PaymentView,
  PdfTemplate,
  PriceListItemView,
  RegistryResult,
  ReportKind,
  ReportView,
  RequestKey,
  type Scope,
  TemplateId,
  TemplateView,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import { Schema, type SchemaAST } from "effect";
import { CorrectionLines, DeliveryQueued, SendInput } from "./groups/documents";
import {
  ContactRole,
  ExpenseListQuery,
  PaymentTarget,
  RecordPaymentInput,
  RecordPaymentResult,
  ReportGroupBy,
} from "./groups/records";
import { IdempotencyKey } from "./http";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
/** Assumed when the `MCP-Protocol-Version` header is absent (transport spec). */
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-03-26";
export const MCP_SERVER_NAME = "kvitbit";
export const MCP_PATH = "/mcp";

// --- Shared argument pieces --------------------------------------------------------------------

export const Revision = Schema.Int.annotate({
  description:
    "The document revision you last read. A stale value fails with Conflict revision_changed.",
});

/** Optional retry key on single-call writes; becomes `mcp:<grantId>:<idempotencyKey>`. */
export const IdempotencyArg = Schema.optional(IdempotencyKey);

/** `mcpc_` plus an opaque base64url secret. Only its hash is stored. */
export const ConfirmationToken = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^mcpc_[A-Za-z0-9_-]{16,128}$/)),
  Schema.brand("ConfirmationToken"),
);
export type ConfirmationToken = typeof ConfirmationToken.Type;

/** Two-step tools: absent on the preview call, both present on the confirm call. */
export const ConfirmArgs = {
  confirm: Schema.optional(Schema.Literal(true)),
  confirmationToken: Schema.optional(ConfirmationToken),
};

/** Args left out of the confirmation `args_hash` (section 6.6 step 3). */
export const CONFIRMATION_HASH_EXCLUDED_ARGS = [
  "confirm",
  "confirmationToken",
  "idempotencyKey",
] as const;

/** The arguments a confirmation token is bound to. */
export const confirmationBoundArgs = (
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(args).filter(
      ([key]) => !(CONFIRMATION_HASH_EXCLUDED_ARGS as ReadonlyArray<string>).includes(key),
    ),
  );

/** Which call of a two-step tool this is; `Invalid{mcp.confirmation_required}` when mixed. */
export type ConfirmStep = "preview" | "confirm" | "malformed";
export const confirmStep = (args: {
  readonly confirm?: true | undefined;
  readonly confirmationToken?: ConfirmationToken | undefined;
}): ConfirmStep => {
  const hasConfirm = args.confirm === true;
  const hasToken = args.confirmationToken !== undefined;
  if (hasConfirm && hasToken) return "confirm";
  if (!hasConfirm && !hasToken) return "preview";
  return "malformed";
};

/** Retry keys (section 6.4). MCP never derives them from JSON-RPC ids. */
export const mcpConfirmRequestKey = (confirmationId: string): RequestKey =>
  RequestKey.make(`mcp-confirm:${confirmationId}`);
export const mcpRequestKey = (grantId: string, idempotencyKey: IdempotencyKey): RequestKey =>
  RequestKey.make(`mcp:${grantId}:${idempotencyKey}`);

// --- Two-step results --------------------------------------------------------------------------

/** Statutory and display money as decimal strings, so agents read them without rounding. */
const DecimalString = Schema.String.pipe(Schema.check(Schema.isPattern(/^-?\d+(\.\d+)?$/)));

export const ConfirmationDocumentSummary = Schema.Struct({
  kind: DocumentKind,
  contact: Schema.String,
  currency: CurrencyCode,
  total: DecimalString,
  vat: Schema.Array(
    Schema.Struct({ rate: DecimalString, base: DecimalString, vat: DecimalString }),
  ),
  dueOn: Schema.optional(IsoDate),
  number: Schema.optional(Schema.String), // known only when the preview reads an issued source
  /** True while core's dry-run previews (G12) are missing and amounts are the adapter's estimate. */
  estimated: Schema.optional(Schema.Boolean),
});
export type ConfirmationDocumentSummary = typeof ConfirmationDocumentSummary.Type;

export const ConfirmationSendSummary = Schema.Struct({
  to: Schema.Array(Schema.String),
  language: Locale,
  subject: Schema.optional(Schema.String),
});

/** First call of a two-step tool: nothing was written; show `summary.text` to the user. */
export const ConfirmationRequired = Schema.TaggedStruct("ConfirmationRequired", {
  confirmationToken: ConfirmationToken,
  expiresAt: Schema.String, // ISO-8601 UTC, 10 minutes after the preview
  action: Schema.String, // the tool name
  summary: Schema.Struct({
    text: Schema.NonEmptyString,
    document: Schema.optional(ConfirmationDocumentSummary),
    send: Schema.optional(ConfirmationSendSummary),
  }),
  /** Warning codes; core does not enumerate them yet (spec example: no_bank_account_for_currency). */
  warnings: Schema.Array(Schema.String),
  next: Schema.String,
});
export type ConfirmationRequired = typeof ConfirmationRequired.Type;

export const CONFIRMATION_TTL_SECONDS = 10 * 60;

/** Second call of a two-step tool: core ran with `requestKey = mcp-confirm:<id>`. */
export const Confirmed = <S extends Schema.Top>(result: S) =>
  Schema.TaggedStruct("Confirmed", { result });

export const twoStepOutput = <S extends Schema.Top>(result: S) =>
  Schema.Union([ConfirmationRequired, Confirmed(result)]);

/** `structuredContent` of a tool result with `isError: true` (section 6.8). */
export const McpToolError = Schema.Struct({ error: CoreError });
export type McpToolError = typeof McpToolError.Type;

const Items = <S extends Schema.Top>(item: S) => Schema.Struct({ items: Schema.Array(item) });

// --- Tool arguments ----------------------------------------------------------------------------

const DocumentArg = { documentId: DocumentId };
const PageArgs = {
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
};

/** No arguments: a JSON object with no properties (an empty Struct would accept any non-null). */
export const NoArgs = Schema.Record(Schema.String, Schema.Never);
export const DocumentIdArgs = Schema.Struct(DocumentArg);
export const ListDocumentsArgs = Schema.Struct({ ...DocumentQuery.fields, ...PageArgs });
export const GetDocumentPdfArgs = Schema.Struct({
  ...DocumentArg,
  template: Schema.optional(PdfTemplate),
  language: Schema.optional(Locale),
});
export const ListPaymentsArgs = Schema.Struct({ target: PaymentTarget });
/**
 * Closed on purpose and equal to the HTTP list query (`ExpenseListQuery`): `incomplete` plus
 * paging, nothing else. Core's `ExpenseQuery` is an open struct, so supplier or contact filters
 * (the UI's contact history) wait until core closes it; widen both surfaces together then.
 */
export const ListExpensesArgs = Schema.Struct(ExpenseListQuery);
export const GetExpenseArgs = Schema.Struct({ expenseId: ExpenseId });
export const ListContactsArgs = Schema.Struct({
  text: Schema.optional(Schema.String),
  role: Schema.optional(ContactRole),
  ...PageArgs,
});
export const LookupAresArgs = Schema.Struct({ ico: Schema.NonEmptyString });
export const ListPriceListItemsArgs = Schema.Struct({
  text: Schema.optional(Schema.String),
  includeArchived: Schema.optional(Schema.Boolean),
});

/** Flow names accepted by `get_report`; `vat` is an alias of `vat_summary` (section 6.5). */
export const McpReportName = Schema.Union([ReportKind, Schema.Literal("vat")]);
export type McpReportName = typeof McpReportName.Type;
export const reportKindFromMcp = (name: McpReportName): ReportKind =>
  name === "vat" ? "vat_summary" : name;
export const GetReportArgs = Schema.Struct({
  report: McpReportName,
  from: IsoDate,
  to: IsoDate,
  groupBy: Schema.optional(ReportGroupBy),
});
export const GetFxRateArgs = Schema.Struct({ currency: CurrencyCode, on: IsoDate });

export const CreateDraftArgs = Schema.Struct({
  ...DocumentInput.fields,
  idempotencyKey: IdempotencyArg,
});
export const UpdateDraftArgs = Schema.Struct({
  ...DocumentArg,
  revision: Revision,
  patch: DocumentPatch,
});
const ContactRevision = Schema.Int.annotate({
  description:
    "The Contact revision you last read; only together with contactId. A stale value fails with Conflict revision_changed.",
});

const UPSERT_CONTACT_FORMS =
  "Exactly one of three forms: { ico, role? } creates a Contact from ARES (Contacts.fromIco); " +
  "{ contact } creates one from the given fields; { contactId, revision, contact } updates that " +
  "Contact at that revision (Contacts.save). idempotencyKey may accompany any form.";

/**
 * `upsert_contact` arguments: one flat struct, so the tool's `inputSchema` stays a plain object,
 * with the valid forms (see `UPSERT_CONTACT_FORMS`) enforced by a check on decode.
 */
export const UpsertContactArgs = Schema.Struct({
  ico: Schema.optional(Schema.NonEmptyString).annotateKey({
    description: "IČO to look up in ARES. Not with contact, contactId or revision.",
  }),
  role: Schema.optional(ContactRole).annotateKey({ description: "Only together with ico." }),
  contactId: Schema.optional(ContactId).annotateKey({
    description: "Contact to update. Requires revision and contact.",
  }),
  revision: Schema.optional(ContactRevision),
  contact: Schema.optional(ContactInput).annotateKey({
    description: "Contact fields to create, or to save over contactId. Not with ico.",
  }),
  idempotencyKey: IdempotencyArg,
})
  .annotate({ description: UPSERT_CONTACT_FORMS })
  .pipe(
    Schema.check(
      Schema.makeFilter(
        (args) => {
          if (args.ico === undefined && args.contact === undefined) return "give ico or contact";
          if (args.ico !== undefined && args.contact !== undefined) {
            return "give ico or contact, not both";
          }
          if ((args.contactId === undefined) !== (args.revision === undefined)) {
            return "contactId and revision go together";
          }
          if (args.contactId !== undefined && args.contact === undefined) {
            return "contactId needs contact";
          }
          if (args.role !== undefined && args.ico === undefined) return "role needs ico";
          return true;
        },
        { expected: UPSERT_CONTACT_FORMS },
      ),
    ),
  );
export const RecordExpenseArgs = Schema.Struct({
  expense: ExpenseInput,
  idempotencyKey: IdempotencyArg,
});
export const RecordPaymentArgs = Schema.Struct({
  ...RecordPaymentInput.fields,
  idempotencyKey: IdempotencyArg,
});
export const SettleProformaArgs = Schema.Struct({
  proformaId: DocumentId,
  amount: Schema.optional(Money),
  paidOn: Schema.optional(IsoDate),
  method: Schema.optional(PaymentMethod),
  idempotencyKey: IdempotencyArg,
});
export const LockDocumentArgs = DocumentIdArgs;
export const CreateFromTemplateArgs = Schema.Struct({
  templateId: TemplateId,
  as: Schema.optional(Schema.Literals(["draft", "issued"])),
  patch: Schema.optional(DocumentPatch),
  idempotencyKey: IdempotencyArg,
  ...ConfirmArgs,
});
export const IssueDocumentArgs = Schema.Struct({
  from: Schema.Union([
    Schema.Struct({ draft: DocumentId, revision: Revision }),
    Schema.Struct({ input: DocumentInput }),
  ]),
  send: Schema.optional(SendInput),
  ...ConfirmArgs,
});
const { purpose: _purpose, ...SendDocumentFields } = SendInput.fields;
export const SendDocumentArgs = Schema.Struct({
  ...DocumentArg,
  ...SendDocumentFields,
  ...ConfirmArgs,
});
export const SendReminderArgs = Schema.Struct({
  ...DocumentArg,
  to: Schema.optional(Schema.Array(Schema.String)),
  ...ConfirmArgs,
});
export const CreateFinalInvoiceArgs = Schema.Struct({
  proformaId: DocumentId,
  patch: Schema.optional(DocumentPatch),
  ...ConfirmArgs,
});
export const CreateCreditNoteArgs = Schema.Struct({
  ...DocumentArg,
  reason: Schema.NonEmptyString,
  lines: CorrectionLines,
  correctedOn: Schema.optional(IsoDate),
  ...ConfirmArgs,
});

// --- Tool results ------------------------------------------------------------------------------

export const GetWorkspaceResult = Schema.Struct({
  workspace: WorkspaceView,
  series: Schema.Array(NumberingSeriesView),
});
export const DocumentResult = Schema.Struct({ document: DocumentView });
/** A `resource_link` to `kvitbit://documents/{id}/pdf`; embedded as a blob when under 1 MB. */
export const DocumentPdfResult = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.Literal("application/pdf"),
  filename: Schema.String,
  embedded: Schema.Boolean,
});
export const ShareLinkResult = Schema.Struct({
  documentId: DocumentId,
  share: DocumentView.fields.share,
});
export const ReportResult = Schema.Struct({
  report: ReportKind,
  from: IsoDate,
  to: IsoDate,
  data: ReportView,
});
export const ContactResult = Schema.Struct({ contact: ContactView });
export const ExpenseResult = Schema.Struct({ expense: ExpenseView });

// --- Catalog -----------------------------------------------------------------------------------

/** "single" is one call; "two_step" previews then confirms; "two_step_when_issued" only for `as: "issued"`. */
export type ToolMode = "single" | "two_step" | "two_step_when_issued";

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpToolDefinition {
  readonly name: string;
  /** user-flows.md flows the tool serves. */
  readonly flows: ReadonlyArray<string>;
  /** Every action the tool can need; `tools/list` offers it only when all hold (rule 6.9 step 3). */
  readonly actions: ReadonlyArray<Action>;
  /** The scope that gates it: `<area>:read` for reads, `<area>:write` for writes. */
  readonly scope: Scope;
  readonly mode: ToolMode;
  readonly annotations: ToolAnnotations;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  /**
   * Arguments outside `input` are an error, not ignored: decode with `toolInputParseOptions` and
   * advertise `toolInputJsonSchema`. Set where a dropped argument would silently widen a result.
   */
  readonly closedInput: boolean;
}

const hints = (flags: ReadonlyArray<"RO" | "D" | "I" | "O">): ToolAnnotations => ({
  readOnlyHint: flags.includes("RO"),
  destructiveHint: flags.includes("D"),
  idempotentHint: flags.includes("I"),
  openWorldHint: flags.includes("O"),
});

const tool = <const Name extends string>(
  name: Name,
  definition: Omit<McpToolDefinition, "name" | "annotations" | "closedInput"> & {
    readonly hints: ReadonlyArray<"RO" | "D" | "I" | "O">;
    readonly closedInput?: true;
  },
): McpToolDefinition & { readonly name: Name } => {
  const { hints: flags, closedInput, ...rest } = definition;
  return { name, ...rest, annotations: hints(flags), closedInput: closedInput === true };
};

/** The 28 curated tools of section 6.5, in table order. */
export const MCP_TOOLS = [
  tool("get_workspace", {
    flows: ["2.3", "10.1"],
    actions: ["workspace.read"],
    scope: "workspace:read",
    mode: "single",
    hints: ["RO"],
    input: NoArgs,
    output: GetWorkspaceResult,
  }),
  tool("list_documents", {
    flows: ["3.6"],
    actions: ["document.read"],
    scope: "documents:read",
    mode: "single",
    hints: ["RO"],
    input: ListDocumentsArgs,
    output: Page(DocumentSummary),
  }),
  tool("get_document", {
    flows: ["3.6"],
    actions: ["document.read"],
    scope: "documents:read",
    mode: "single",
    hints: ["RO"],
    input: DocumentIdArgs,
    output: DocumentResult,
  }),
  tool("get_document_history", {
    flows: ["3.6", "8.6"],
    actions: ["document.history"],
    scope: "documents:read",
    mode: "single",
    hints: ["RO"],
    input: DocumentIdArgs,
    output: Items(AuditEntry),
  }),
  tool("get_document_pdf", {
    flows: ["3.10"],
    actions: ["document.pdf"],
    scope: "documents:read",
    mode: "single",
    hints: ["RO"],
    input: GetDocumentPdfArgs,
    output: DocumentPdfResult,
  }),
  tool("list_payments", {
    flows: ["7.1"],
    actions: ["payment.read"],
    scope: "payments:read",
    mode: "single",
    hints: ["RO"],
    input: ListPaymentsArgs,
    output: Items(PaymentView),
  }),
  tool("list_invoice_templates", {
    flows: ["4.2"],
    actions: ["template.read"],
    scope: "templates:read",
    mode: "single",
    hints: ["RO"],
    input: NoArgs,
    output: Items(TemplateView),
  }),
  tool("list_expenses", {
    flows: ["5.5"],
    actions: ["expense.read"],
    scope: "expenses:read",
    mode: "single",
    hints: ["RO"],
    input: ListExpensesArgs,
    closedInput: true,
    output: Page(ExpenseSummary),
  }),
  tool("get_expense", {
    flows: ["5.5"],
    actions: ["expense.read"],
    scope: "expenses:read",
    mode: "single",
    hints: ["RO"],
    input: GetExpenseArgs,
    output: ExpenseResult,
  }),
  tool("list_contacts", {
    flows: ["6.3"],
    actions: ["contact.read"],
    scope: "contacts:read",
    mode: "single",
    hints: ["RO"],
    input: ListContactsArgs,
    output: Page(ContactView),
  }),
  tool("lookup_ares", {
    flows: ["6.1"],
    actions: ["contact.read"],
    scope: "contacts:read",
    mode: "single",
    hints: ["RO", "O"],
    input: LookupAresArgs,
    output: RegistryResult,
  }),
  tool("list_price_list_items", {
    flows: ["6.4"],
    actions: ["priceList.read"],
    scope: "catalog:read",
    mode: "single",
    hints: ["RO"],
    input: ListPriceListItemsArgs,
    output: Items(PriceListItemView),
  }),
  tool("get_share_link", {
    flows: ["8.1"],
    actions: ["share.read"],
    scope: "share:read",
    mode: "single",
    hints: ["RO"],
    input: DocumentIdArgs,
    output: ShareLinkResult,
  }),
  tool("get_report", {
    flows: ["9.2", "9.3", "9.4", "9.5", "9.6"],
    actions: ["report.run"],
    scope: "reports:read",
    mode: "single",
    hints: ["RO"],
    input: GetReportArgs,
    output: ReportResult,
  }),
  tool("get_fx_rate", {
    flows: ["3.11"],
    actions: ["report.run"],
    scope: "reports:read",
    mode: "single",
    hints: ["RO", "O"],
    input: GetFxRateArgs,
    output: FxRateView,
  }),
  tool("create_draft", {
    flows: ["3.1"],
    actions: ["document.draft"],
    scope: "documents:write",
    mode: "single",
    hints: [],
    input: CreateDraftArgs,
    output: DocumentResult,
  }),
  tool("update_draft", {
    flows: ["3.1"],
    actions: ["document.edit"],
    scope: "documents:write",
    mode: "single",
    hints: ["I"],
    input: UpdateDraftArgs,
    output: DocumentResult,
  }),
  tool("upsert_contact", {
    flows: ["6.1", "6.2"],
    actions: ["contact.write"],
    scope: "contacts:write",
    mode: "single",
    hints: ["I", "O"],
    input: UpsertContactArgs,
    output: ContactResult,
  }),
  tool("record_expense", {
    flows: ["5.1"],
    actions: ["expense.write"],
    scope: "expenses:write",
    mode: "single",
    hints: [],
    input: RecordExpenseArgs,
    output: ExpenseResult,
  }),
  tool("record_payment", {
    flows: ["7.1", "5.4"],
    actions: ["payment.write"],
    scope: "payments:write",
    mode: "single",
    hints: [],
    input: RecordPaymentArgs,
    output: RecordPaymentResult,
  }),
  tool("settle_proforma", {
    flows: ["3.8"],
    actions: ["payment.write"],
    scope: "payments:write",
    mode: "single",
    hints: [],
    input: SettleProformaArgs,
    output: RecordPaymentResult,
  }),
  tool("lock_document", {
    flows: ["3.5"],
    actions: ["document.lock"],
    scope: "documents:write",
    mode: "single",
    hints: ["I"],
    input: LockDocumentArgs,
    output: DocumentResult,
  }),
  tool("create_from_template", {
    flows: ["4.2"],
    actions: ["document.draft", "document.issue"],
    scope: "documents:write",
    mode: "two_step_when_issued",
    hints: [],
    input: CreateFromTemplateArgs,
    output: Schema.Union([DocumentResult, ConfirmationRequired, Confirmed(DocumentResult)]),
  }),
  tool("issue_document", {
    flows: ["3.2"],
    actions: ["document.issue", "document.send"],
    scope: "documents:write",
    mode: "two_step",
    hints: ["D"],
    input: IssueDocumentArgs,
    output: twoStepOutput(DocumentResult),
  }),
  tool("send_document", {
    flows: ["3.3"],
    actions: ["document.send"],
    scope: "documents:write",
    mode: "two_step",
    hints: ["O"],
    input: SendDocumentArgs,
    output: twoStepOutput(DeliveryQueued),
  }),
  tool("send_reminder", {
    flows: ["7.4"],
    actions: ["document.send"],
    scope: "documents:write",
    mode: "two_step",
    hints: ["O"],
    input: SendReminderArgs,
    output: twoStepOutput(DeliveryQueued),
  }),
  tool("create_final_invoice", {
    flows: ["3.8"],
    actions: ["document.finalInvoice"],
    scope: "documents:write",
    mode: "two_step",
    hints: ["D"],
    input: CreateFinalInvoiceArgs,
    output: twoStepOutput(DocumentResult),
  }),
  tool("create_credit_note", {
    flows: ["3.9"],
    actions: ["document.correct"],
    scope: "documents:write",
    mode: "two_step",
    hints: ["D"],
    input: CreateCreditNoteArgs,
    output: twoStepOutput(DocumentResult),
  }),
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];
export const McpToolName = Schema.Literals(MCP_TOOLS.map((t) => t.name));

/**
 * Actions a call actually needs, for the preview's up-front `can` check (section 6.6 step 1):
 * `issue_document` adds `document.send` only with `send`, `create_from_template` adds
 * `document.issue` only for `as: "issued"`.
 */
export const requiredActions = (
  name: McpToolName,
  args: { readonly send?: unknown; readonly as?: "draft" | "issued" },
): ReadonlyArray<Action> => {
  switch (name) {
    case "issue_document":
      return args.send === undefined ? ["document.issue"] : ["document.issue", "document.send"];
    case "create_from_template":
      return args.as === "issued" ? ["document.draft", "document.issue"] : ["document.draft"];
    default:
      return MCP_TOOLS.find((t) => t.name === name)?.actions ?? [];
  }
};

/**
 * JSON Schema for a tool's `inputSchema` or `outputSchema`. MCP needs `type: "object"` at the
 * top, which a union of structs (`anyOf`) lacks, so it is added there.
 */
export const toolJsonSchema = (
  schema: Schema.Top,
  options?: { readonly onExcessProperty?: "ignore" | "error" },
): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema, options);
  const root: Record<string, unknown> = { ...document.schema };
  if (Object.keys(document.definitions).length > 0) root.$defs = document.definitions;
  if (root.type === undefined && root.anyOf !== undefined) root.type = "object";
  return root;
};

/** Decoder options for a tool's arguments: closed inputs reject unmodeled properties. */
export const toolInputParseOptions = (tool: McpToolDefinition): SchemaAST.ParseOptions => ({
  onExcessProperty: tool.closedInput ? "error" : "ignore",
});

/** A tool's `inputSchema`; closed inputs advertise `additionalProperties: false`. */
export const toolInputJsonSchema = (tool: McpToolDefinition): Record<string, unknown> =>
  toolJsonSchema(tool.input, { onExcessProperty: tool.closedInput ? "error" : "ignore" });

// --- Resources (section 6.7) -------------------------------------------------------------------

export interface McpResourceDefinition {
  readonly kind: "static" | "template";
  /** URI for static resources, RFC 6570 template for templates. */
  readonly uri: string;
  readonly mimeType: string;
  readonly action: Action | null;
}

export const MCP_RESOURCES: ReadonlyArray<McpResourceDefinition> = [
  {
    kind: "static",
    uri: "kvitbit://workspace",
    mimeType: "application/json",
    action: "workspace.read",
  },
  {
    kind: "static",
    uri: "kvitbit://templates",
    mimeType: "application/json",
    action: "template.read",
  },
  {
    kind: "static",
    uri: "kvitbit://price-list",
    mimeType: "application/json",
    action: "priceList.read",
  },
  { kind: "static", uri: "kvitbit://guide", mimeType: "text/markdown", action: null },
  {
    kind: "template",
    uri: "kvitbit://documents/{documentId}",
    mimeType: "application/json",
    action: "document.read",
  },
  {
    kind: "template",
    uri: "kvitbit://documents/{documentId}/pdf{?template,language}",
    mimeType: "application/pdf",
    action: "document.pdf",
  },
  {
    kind: "template",
    uri: "kvitbit://contacts/{contactId}",
    mimeType: "application/json",
    action: "contact.read",
  },
  {
    kind: "template",
    uri: "kvitbit://expenses/{expenseId}",
    mimeType: "application/json",
    action: "expense.read",
  },
  {
    kind: "template",
    uri: "kvitbit://expenses/{expenseId}/attachments/{attachmentId}",
    mimeType: "application/octet-stream", // the stored type, served as a blob
    action: "expense.attachment.read",
  },
];

/** Embedded PDF blobs stop at 1 MB; resource blobs over 5 MB are refused. */
export const MCP_EMBEDDED_PDF_MAX_BYTES = 1024 * 1024;
export const MCP_RESOURCE_BLOB_MAX_BYTES = 5 * 1024 * 1024;

export const documentPdfUri = (documentId: DocumentId): string =>
  `kvitbit://documents/${documentId}/pdf`;
export const attachmentUri = (expenseId: ExpenseId, attachmentId: AttachmentId): string =>
  `kvitbit://expenses/${expenseId}/attachments/${attachmentId}`;
