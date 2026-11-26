/**
 * All 28 MCP tools (http-mcp-contracts sections 6.5, 6.6, 6.8, 6.9):
 * - Exact tool names, input/output JSON Schemas, and annotations from `@kvitbit/api-contract`.
 * - Read-only filtering on `tools/list` via `can(caller, action)`.
 * - Durable approvals for two-step tools, replayed through the core request log.
 */
import {
  type ConfirmationDocumentSummary,
  type ConfirmationRequired,
  type ConfirmationSendSummary,
  type ConfirmationToken,
  CreateCreditNoteArgs,
  CreateDraftArgs,
  CreateFinalInvoiceArgs,
  CreateFromTemplateArgs,
  confirmStep,
  DocumentIdArgs,
  documentPdfUri,
  GetDocumentPdfArgs,
  GetExpenseArgs,
  GetFxRateArgs,
  GetReportArgs,
  IssueDocumentArgs,
  ListContactsArgs,
  ListDocumentsArgs,
  ListExpensesArgs,
  ListPaymentsArgs,
  ListPriceListItemsArgs,
  LockDocumentArgs,
  LookupAresArgs,
  MCP_EMBEDDED_PDF_MAX_BYTES,
  MCP_TOOLS,
  type McpToolName,
  mcpRequestKey,
  NoArgs,
  RecordExpenseArgs,
  RecordPaymentArgs,
  reportKindFromMcp,
  requiredActions,
  SendDocumentArgs,
  SendReminderArgs,
  SettleProformaArgs,
  toolJsonSchema,
  UpdateDraftArgs,
  UpsertContactArgs,
} from "@kvitbit/api-contract";
import { can, makeRequestOutcome } from "@kvitbit/core";
import {
  Conflict,
  Contacts,
  type CoreError,
  type CurrentCaller,
  type DocumentPatch,
  Documents,
  type DocumentView,
  Expenses,
  Forbidden,
  type MemberCaller,
  Payments,
  PriceList,
  Reports,
  type RequestKey,
  TemplateInput,
  Templates,
  type TemplateView,
  Workspaces,
} from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import { BigDecimal, Data, Effect, Schema, SchemaIssue, Stream } from "effect";
import type { AuthenticatedMcpCaller } from "./caller";
import {
  type ConfirmationSubject,
  confirmationRequiredError,
  McpConfirmations,
} from "./confirmation";
import { coreErrorToolResult, type McpToolCallResult } from "./errors";

export class ToolInvalidParams extends Data.TaggedError("ToolInvalidParams")<{
  readonly message: string;
  readonly issues?: ReadonlyArray<unknown>;
}> {}

export interface McpToolListEntry {
  readonly name: McpToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

const TWO_STEP_NOTE =
  " Two-step tool: first call without confirm/confirmationToken to get a preview and confirmationToken; " +
  "show summary.text to the user, then call again with identical arguments plus confirm: true and confirmationToken.";

const TOOL_DESCRIPTIONS: Readonly<Record<McpToolName, string>> = {
  get_workspace:
    "Return the active Workspace (Issuing Entity, Tax Regime, bank accounts, defaults) and its numbering series.",
  list_documents: "List documents in the active Workspace with optional filters and cursor paging.",
  get_document: "Fetch a single document by documentId, including lines, totals, and revision.",
  get_document_history: "Return the audit trail for a document.",
  get_document_pdf:
    "Render a document as PDF. Returns a resource_link and embeds the PDF base64 blob when under 1 MB.",
  list_payments: "List all payments recorded against a document or an expense.",
  list_invoice_templates: "List all Invoice Templates and their Recurring Schedules.",
  list_expenses:
    "List expenses in the active Workspace with optional incomplete filter and paging.",
  get_expense: "Fetch a single expense by expenseId.",
  list_contacts: "Search or list contacts in the active Workspace.",
  lookup_ares: "Look up a Czech company by IČO in the ARES registry without saving it.",
  list_price_list_items: "List Price List Items in the active Workspace.",
  get_share_link: "Return the active public share link information for a document.",
  get_report:
    "Run a financial report (revenue, expenses, receivables, vat / vat_summary, cashflow) for a date range.",
  get_fx_rate: "Fetch the CNB FX rate for a foreign currency on a given date.",
  create_draft: "Create a new unnumbered draft document. Pass idempotencyKey to make retries safe.",
  update_draft:
    "Update an existing draft document at the given revision. Refuses issued documents with Conflict{illegal_transition}.",
  upsert_contact:
    "Create a contact from ARES ({ ico, role? }), create from fields ({ contact }), or update an existing contact ({ contactId, revision, contact }).",
  record_expense: "Record a new expense in the active Workspace.",
  record_payment:
    "Record a payment against a document or expense. Automatically issues a Payment Tax Document when a VAT payer receives payment on a Proforma.",
  settle_proforma:
    "Record a payment on a Proforma (defaults to full outstanding amount and today). Auto-issues a Payment Tax Document for VAT payers.",
  lock_document: "Lock an issued document so it can no longer be edited or cancelled.",
  create_from_template:
    'Create a draft or issued document from an Invoice Template. Draft mode is single-call; as: "issued" requires two-step confirmation.' +
    TWO_STEP_NOTE,
  issue_document:
    "Assign a gapless document number and issue a document from an existing draft or directly from input, with optional email send." +
    TWO_STEP_NOTE,
  send_document: `Queue an email delivery of an issued document.${TWO_STEP_NOTE}`,
  send_reminder: `Queue a manual payment reminder email for an issued document.${TWO_STEP_NOTE}`,
  create_final_invoice:
    "Issue the Final Invoice for a paid Proforma, deducting paid advances under §37a." +
    TWO_STEP_NOTE,
  create_credit_note:
    "Issue a Credit Note (full or partial correction) against an issued Invoice or Payment Tax Document." +
    TWO_STEP_NOTE,
};

/** Pre-computed JSON Schemas for every tool in `MCP_TOOLS`. */
const TOOL_SCHEMAS = new Map<
  McpToolName,
  {
    readonly inputSchema: Record<string, unknown>;
    readonly outputSchema: Record<string, unknown>;
  }
>(
  MCP_TOOLS.map((def) => [
    def.name,
    {
      inputSchema: toolJsonSchema(def.input),
      outputSchema: toolJsonSchema(def.output),
    },
  ]),
);

const TOOL_BY_NAME = new Map<string, (typeof MCP_TOOLS)[number]>(
  MCP_TOOLS.map((def) => [def.name, def]),
);

/**
 * `tools/list` (section 6.9 step 3): offers only tools where `can(caller, action)` holds for
 * every action the tool can need.
 */
export const listTools = (caller: MemberCaller): ReadonlyArray<McpToolListEntry> =>
  MCP_TOOLS.filter((def) => def.actions.every((action) => can(caller, action))).map((def) => {
    const schemas = TOOL_SCHEMAS.get(def.name) ?? { inputSchema: {}, outputSchema: {} };
    return {
      name: def.name,
      description: TOOL_DESCRIPTIONS[def.name],
      inputSchema: schemas.inputSchema,
      outputSchema: schemas.outputSchema,
      annotations: { ...def.annotations },
    };
  });

const formatSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const decodeArgs = <S extends Schema.Top>(schema: S, raw: unknown) =>
  Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(raw).pipe(
    Effect.mapError((err) => {
      const formatted = formatSchemaIssues(err.issue);
      const summary = formatted.issues
        .map((i) => {
          const path = (i.path ?? [])
            .map((p) =>
              typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p),
            )
            .join(".");
          return path ? `${path}: ${i.message}` : i.message;
        })
        .join("; ");
      return new ToolInvalidParams({
        message: summary || "Invalid tool arguments",
        issues: formatted.issues,
      });
    }),
  );

const okResult = (
  text: string,
  structured: unknown,
  extraContent: McpToolCallResult["content"] = [],
): McpToolCallResult => ({
  isError: false,
  content: [{ type: "text", text }, ...extraContent],
  structuredContent: structured as Record<string, unknown>,
});

const formatDecimal = (value: BigDecimal.BigDecimal): string =>
  BigDecimal.format(BigDecimal.normalize(value));

// The request log restores decimal values from text, which can change their in-memory scale.
const normalizeConfirmedValue = (value: unknown): unknown => {
  if (BigDecimal.isBigDecimal(value)) return BigDecimal.normalize(value);
  if (Array.isArray(value)) return value.map(normalizeConfirmedValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeConfirmedValue(entry)]),
  );
};

const confirmedDocument = (text: string, document: DocumentView): McpToolCallResult =>
  okResult(text, {
    _tag: "Confirmed",
    result: { document: normalizeConfirmedValue(document) },
  });

type ConfirmationSendSummaryType = typeof ConfirmationSendSummary.Type;

const compact = <T extends object>(
  value: T,
): { readonly [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    readonly [K in keyof T]?: Exclude<T[K], undefined>;
  };

const contactNameOf = (contact: unknown): string =>
  typeof contact === "object" &&
  contact !== null &&
  "name" in contact &&
  typeof (contact as { readonly name?: unknown }).name === "string"
    ? (contact as { readonly name: string }).name
    : "";

const documentSummaryOf = (
  doc: DocumentView,
  estimated?: boolean,
): ConfirmationDocumentSummary => ({
  kind: doc.kind,
  contact: contactNameOf(doc.contact),
  currency: doc.totals.gross.currency,
  total: formatDecimal(doc.totals.gross.amount),
  vat: doc.totals.buckets.map((b) => ({
    rate: formatDecimal(b.ratePercent),
    base: formatDecimal(b.base),
    vat: formatDecimal(b.vat),
  })),
  ...(doc.dates.dueOn !== null ? { dueOn: doc.dates.dueOn } : {}),
  ...(doc.number !== null ? { number: doc.number } : {}),
  ...(estimated === true ? { estimated: true } : {}),
});

const documentWarnings = (doc: DocumentView): ReadonlyArray<string> => {
  const { issuer } = doc;
  return doc.paymentMethod === "bank_transfer" &&
    issuer !== null &&
    typeof issuer === "object" &&
    "bankAccount" in issuer &&
    issuer.bankAccount === null
    ? ["document.no_bank_account_for_currency"]
    : [];
};

const templatePreviewInput = (template: TemplateView, patch: DocumentPatch | undefined) =>
  Effect.gen(function* () {
    const { number, refreshParties, fx, ...fields } = patch ?? {};
    if (template.archived === true || number !== undefined || refreshParties !== undefined) {
      return yield* new Conflict({ reason: "illegal_transition" });
    }
    const {
      name: _name,
      fx: templateFx,
      ...defaults
    } = yield* Schema.decodeUnknownEffect(Schema.toType(TemplateInput))(template.input).pipe(
      Effect.orDie,
    );
    const resolvedFx = fx === undefined ? templateFx : fx;
    return {
      ...defaults,
      ...fields,
      contact: fields.contact ?? defaults.contact,
      lines: fields.lines ?? defaults.lines,
      ...(resolvedFx != null ? { fx: resolvedFx } : {}),
    };
  });

const buildConfirmationRequired = (params: {
  readonly action: McpToolName;
  readonly token: ConfirmationToken;
  readonly expiresAt: string;
  readonly text: string;
  readonly document?: ConfirmationDocumentSummary;
  readonly send?: ConfirmationSendSummaryType;
  readonly warnings?: ReadonlyArray<string>;
}): ConfirmationRequired => ({
  _tag: "ConfirmationRequired",
  confirmationToken: params.token,
  expiresAt: params.expiresAt,
  action: params.action,
  summary: {
    text: params.text,
    ...(params.document !== undefined ? { document: params.document } : {}),
    ...(params.send !== undefined ? { send: params.send } : {}),
  },
  warnings: params.warnings ? [...params.warnings] : [],
  next: `Show this summary to the user. Only after they approve, call ${params.action} again with the same arguments plus confirm: true and this confirmationToken.`,
});

const requireActions = (
  caller: MemberCaller,
  actions: ReadonlyArray<Parameters<typeof can>[1]>,
): Effect.Effect<void, Forbidden> =>
  Effect.gen(function* () {
    for (const action of actions) {
      if (!can(caller, action)) {
        return yield* new Forbidden({ action });
      }
    }
  });

const collectAllBytes = (stream: Stream.Stream<Uint8Array>): Effect.Effect<Uint8Array> =>
  Effect.map(Stream.runCollect(stream), (chunks) => {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  });

export type McpToolServices =
  | Workspaces
  | Documents
  | Payments
  | Expenses
  | Contacts
  | PriceList
  | Templates
  | Reports
  | McpConfirmations;

export const callTool = (
  name: string,
  rawArgs: unknown,
  auth: AuthenticatedMcpCaller,
): Effect.Effect<McpToolCallResult, ToolInvalidParams, McpToolServices | CurrentCaller> =>
  Effect.gen(function* () {
    const def = TOOL_BY_NAME.get(name);
    if (def === undefined) {
      return yield* new ToolInvalidParams({ message: `Unknown tool: ${name}` });
    }
    const normalizedInput = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (typeof normalizedInput !== "object" || Array.isArray(normalizedInput)) {
      return yield* new ToolInvalidParams({ message: "Tool arguments must be a JSON object" });
    }

    const { caller, grant, principal } = auth;
    const confirmations = yield* McpConfirmations;
    const boundArgs = normalizedInput as Record<string, unknown>;
    const confirmationContext = (tool: McpToolName) => ({
      workspaceId: grant.workspaceId,
      grantId: grant.grantId,
      userId: principal.userId,
      tool,
    });
    const mint = (tool: McpToolName, revision: number | null) =>
      confirmations.mint(confirmationContext(tool), boundArgs, revision);
    const confirm = <A, R>(
      tool: McpToolName,
      token: ConfirmationToken | undefined,
      subject: ConfirmationSubject | undefined,
      execute: (requestKey: RequestKey) => Effect.Effect<A, CoreError, R>,
    ) =>
      token === undefined
        ? Effect.fail(confirmationRequiredError())
        : confirmations.confirm(confirmationContext(tool), boundArgs, token, subject, execute);
    const singleOutcome = yield* makeRequestOutcome;

    const executeTool = (): Effect.Effect<
      McpToolCallResult,
      ToolInvalidParams | CoreError,
      McpToolServices | CurrentCaller | RequestOutcome
    > => {
      switch (def.name) {
        case "get_workspace":
          return Effect.gen(function* () {
            yield* decodeArgs(NoArgs, normalizedInput);
            const ws = yield* Workspaces;
            const workspace = yield* ws.current;
            const series = yield* ws.listSeries;
            return okResult(`Workspace ${workspace.name} (${series.length} numbering series).`, {
              workspace,
              series,
            });
          });

        case "list_documents":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(ListDocumentsArgs, normalizedInput);
            const documents = yield* Documents;
            const page = yield* documents.list(args);
            return okResult(`Listed ${page.items.length} document(s).`, page);
          });

        case "get_document":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(DocumentIdArgs, normalizedInput);
            const documents = yield* Documents;
            const document = yield* documents.get(args.documentId);
            return okResult(
              `Document ${document.number ?? document.id} (${document.kind}, ${document.status}).`,
              { document },
            );
          });

        case "get_document_history":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(DocumentIdArgs, normalizedInput);
            const documents = yield* Documents;
            const items = yield* documents.history(args.documentId);
            return okResult(`Document history (${items.length} entries).`, { items });
          });

        case "get_document_pdf":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(GetDocumentPdfArgs, normalizedInput);
            const documents = yield* Documents;
            const download = yield* documents.pdf(args.documentId, {
              ...(args.template !== undefined ? { template: args.template } : {}),
              ...(args.language !== undefined ? { language: args.language } : {}),
            });
            const bytes = yield* collectAllBytes(download.bytes);
            const uri = documentPdfUri(args.documentId);
            const embedded = bytes.byteLength <= MCP_EMBEDDED_PDF_MAX_BYTES;
            const extra: Array<McpToolCallResult["content"][number]> = [
              {
                type: "resource_link",
                uri,
                name: download.filename,
                mimeType: "application/pdf",
              },
            ];
            if (embedded) {
              extra.push({
                type: "resource",
                resource: {
                  uri,
                  mimeType: "application/pdf",
                  blob: Buffer.from(bytes).toString("base64"),
                },
              });
            }
            return okResult(
              `PDF ${download.filename} (${bytes.byteLength} bytes, ${embedded ? "embedded" : "link only"}).`,
              {
                uri,
                mimeType: "application/pdf",
                filename: download.filename,
                embedded,
              },
              extra,
            );
          });

        case "list_payments":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(ListPaymentsArgs, normalizedInput);
            const payments = yield* Payments;
            const items = yield* payments.listFor(args.target);
            return okResult(`Listed ${items.length} payment(s).`, { items });
          });

        case "list_invoice_templates":
          return Effect.gen(function* () {
            yield* decodeArgs(NoArgs, normalizedInput);
            const templates = yield* Templates;
            const items = yield* templates.list;
            return okResult(`Listed ${items.length} invoice template(s).`, { items });
          });

        case "list_expenses":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(ListExpensesArgs, normalizedInput);
            const expenses = yield* Expenses;
            const page = yield* expenses.list(args);
            return okResult(`Listed ${page.items.length} expense(s).`, page);
          });

        case "get_expense":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(GetExpenseArgs, normalizedInput);
            const expenses = yield* Expenses;
            const expense = yield* expenses.get(args.expenseId);
            return okResult(`Expense ${args.expenseId} (${expense.status}).`, { expense });
          });

        case "list_contacts":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(ListContactsArgs, normalizedInput);
            const contacts = yield* Contacts;
            const page = yield* contacts.search(compact(args));
            return okResult(`Listed ${page.items.length} contact(s).`, page);
          });

        case "lookup_ares":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(LookupAresArgs, normalizedInput);
            yield* requireActions(caller, ["contact.read"]);
            const ws = yield* Workspaces;
            const result = yield* ws.lookupCompany(args.ico);
            return okResult(`ARES lookup for IČO ${args.ico} completed.`, result);
          });

        case "list_price_list_items":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(ListPriceListItemsArgs, normalizedInput);
            const priceList = yield* PriceList;
            const items = yield* priceList.list(compact(args));
            return okResult(`Listed ${items.length} price list item(s).`, { items });
          });

        case "get_share_link":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(DocumentIdArgs, normalizedInput);
            yield* requireActions(caller, ["share.read"]);
            const documents = yield* Documents;
            const doc = yield* documents.get(args.documentId);
            return okResult(
              doc.share
                ? `Active share link: ${doc.share.url}`
                : "Document has no active share link.",
              { documentId: args.documentId, share: doc.share },
            );
          });

        case "get_report":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(GetReportArgs, normalizedInput);
            const reports = yield* Reports;
            const report = reportKindFromMcp(args.report);
            const data = yield* reports.run({
              report,
              period: { from: args.from, to: args.to },
              ...(args.groupBy !== undefined ? { groupBy: args.groupBy } : {}),
            });
            return okResult(`Report ${report} (${args.from} to ${args.to}).`, {
              report,
              from: args.from,
              to: args.to,
              data,
            });
          });

        case "get_fx_rate":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(GetFxRateArgs, normalizedInput);
            const reports = yield* Reports;
            const fx = yield* reports.fxRate({ currency: args.currency, on: args.on });
            return okResult(`FX rate for ${args.currency} on ${args.on}.`, fx);
          });

        case "create_draft":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(CreateDraftArgs, normalizedInput);
            const { idempotencyKey, ...input } = args;
            const documents = yield* Documents;
            const document = yield* documents.createDraft(
              input,
              idempotencyKey !== undefined
                ? { requestKey: mcpRequestKey(grant.grantId, idempotencyKey) }
                : undefined,
            );
            return okResult(`Created draft ${document.id} (rev ${document.revision}).`, {
              document,
            });
          });

        case "update_draft":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(UpdateDraftArgs, normalizedInput);
            yield* requireActions(caller, ["document.edit"]);
            const documents = yield* Documents;
            const existing = yield* documents.get(args.documentId);
            if (existing.status !== "draft") {
              return yield* new Conflict({ reason: "illegal_transition" });
            }
            const document = yield* documents.edit(args.documentId, args.patch, args.revision);
            return okResult(`Updated draft ${document.id} (rev ${document.revision}).`, {
              document,
            });
          });

        case "upsert_contact":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(UpsertContactArgs, normalizedInput);
            const contacts = yield* Contacts;
            const contact =
              args.ico !== undefined
                ? yield* contacts.fromIco(
                    args.ico,
                    args.role !== undefined ? { role: args.role } : undefined,
                  )
                : yield* contacts.save(
                    {
                      ...(args.contact ?? ({} as NonNullable<typeof args.contact>)),
                      ...(args.contactId !== undefined && args.revision !== undefined
                        ? { id: args.contactId, expectedRevision: args.revision }
                        : {}),
                    },
                    args.idempotencyKey !== undefined
                      ? { requestKey: mcpRequestKey(grant.grantId, args.idempotencyKey) }
                      : undefined,
                  );
            return okResult(`Saved contact (rev ${contact.revision}).`, { contact });
          });

        case "record_expense":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(RecordExpenseArgs, normalizedInput);
            const expenses = yield* Expenses;
            const expense = yield* expenses.record(
              args.expense,
              args.idempotencyKey !== undefined
                ? { requestKey: mcpRequestKey(grant.grantId, args.idempotencyKey) }
                : undefined,
            );
            return okResult(`Recorded expense (${expense.status}, rev ${expense.revision}).`, {
              expense,
            });
          });

        case "record_payment":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(RecordPaymentArgs, normalizedInput);
            const { idempotencyKey, ...input } = args;
            const payments = yield* Payments;
            const result = yield* payments.record(
              input,
              idempotencyKey !== undefined
                ? { requestKey: mcpRequestKey(grant.grantId, idempotencyKey) }
                : undefined,
            );
            return okResult(`Recorded payment (settlement: ${result.settlement}).`, result);
          });

        case "settle_proforma":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(SettleProformaArgs, normalizedInput);
            yield* requireActions(caller, ["payment.write"]);
            const documents = yield* Documents;
            const proforma = yield* documents.get(args.proformaId);
            if (proforma.kind !== "proforma") {
              return yield* new Conflict({ reason: "illegal_transition" });
            }
            const payments = yield* Payments;
            const result = yield* payments.record(
              {
                target: { document: args.proformaId },
                ...(args.amount !== undefined ? { amount: args.amount } : {}),
                ...(args.paidOn !== undefined ? { paidOn: args.paidOn } : {}),
                ...(args.method !== undefined ? { method: args.method } : {}),
              },
              args.idempotencyKey !== undefined
                ? { requestKey: mcpRequestKey(grant.grantId, args.idempotencyKey) }
                : undefined,
            );
            return okResult(
              `Settled proforma ${proforma.number ?? proforma.id} (settlement: ${result.settlement}).`,
              result,
            );
          });

        case "lock_document":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(LockDocumentArgs, normalizedInput);
            const documents = yield* Documents;
            const document = yield* documents.lock(args.documentId);
            return okResult(`Locked document ${document.number ?? document.id}.`, { document });
          });

        case "create_from_template":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(CreateFromTemplateArgs, normalizedInput);
            const templates = yield* Templates;
            if (args.as !== "issued") {
              if (args.confirm !== undefined || args.confirmationToken !== undefined) {
                return yield* confirmationRequiredError();
              }
              const document = yield* templates.use(
                args.templateId,
                {
                  as: "draft",
                  ...(args.patch !== undefined ? { patch: args.patch } : {}),
                },
                args.idempotencyKey !== undefined
                  ? { requestKey: mcpRequestKey(grant.grantId, args.idempotencyKey) }
                  : undefined,
              );
              return okResult(`Created draft ${document.id} from template.`, { document });
            }

            const step = confirmStep(args);
            if (step === "malformed") return yield* confirmationRequiredError();

            if (step === "preview") {
              yield* requireActions(
                caller,
                requiredActions("create_from_template", { as: "issued" }),
              );
              const template = yield* templates.get(args.templateId);
              const input = yield* templatePreviewInput(template, args.patch);
              const documents = yield* Documents;
              const previewDoc = yield* documents.preview(input);
              const summary = documentSummaryOf(previewDoc);
              const minted = yield* mint("create_from_template", template.revision);
              const templateName =
                typeof template.name === "string" ? template.name : args.templateId;
              const confirmation = buildConfirmationRequired({
                action: "create_from_template",
                token: minted.token,
                expiresAt: minted.expiresAt,
                text: `Issue ${summary.kind} for ${summary.contact}, ${summary.total} ${summary.currency}, due ${summary.dueOn}, from template "${templateName}". The number will be assigned on confirm.`,
                document: summary,
                warnings: documentWarnings(previewDoc),
              });
              return okResult(confirmation.summary.text, confirmation);
            }

            const document = yield* confirm(
              "create_from_template",
              args.confirmationToken,
              { table: "templates", id: args.templateId },
              (requestKey) =>
                templates.use(
                  args.templateId,
                  {
                    as: "issued",
                    ...(args.patch !== undefined ? { patch: args.patch } : {}),
                  },
                  { requestKey },
                ),
            );
            return confirmedDocument(
              `Issued document ${document.number ?? document.id} from template.`,
              document,
            );
          });

        case "issue_document":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(IssueDocumentArgs, normalizedInput);
            const step = confirmStep(args);
            if (step === "malformed") return yield* confirmationRequiredError();

            const documents = yield* Documents;
            if (step === "preview") {
              yield* requireActions(caller, requiredActions("issue_document", args));
              let previewDoc: DocumentView;
              let subjectRevision: number | null;
              if ("draft" in args.from) {
                const draft = yield* documents.get(args.from.draft);
                if (draft.revision !== args.from.revision) {
                  return yield* new Conflict({
                    reason: "revision_changed",
                    currentRevision: draft.revision,
                  });
                }
                previewDoc = draft;
                subjectRevision = draft.revision;
              } else {
                previewDoc = yield* documents.preview(args.from.input);
                subjectRevision = null;
              }
              const minted = yield* mint("issue_document", subjectRevision);
              const docSummary = documentSummaryOf(previewDoc);
              const sendSummary: ConfirmationSendSummaryType | undefined =
                args.send !== undefined
                  ? {
                      to: args.send.to ? [...args.send.to] : [],
                      language: args.send.language ?? caller.locale,
                    }
                  : undefined;
              const sendNote =
                sendSummary !== undefined
                  ? ` Then email it (${sendSummary.language})${sendSummary.to.length > 0 ? ` to ${sendSummary.to.join(", ")}` : ""}.`
                  : "";
              const confirmation = buildConfirmationRequired({
                action: "issue_document",
                token: minted.token,
                expiresAt: minted.expiresAt,
                text: `Issue ${docSummary.kind} for ${docSummary.contact}, ${docSummary.total} ${docSummary.currency}${docSummary.dueOn ? `, due ${docSummary.dueOn}` : ""}.${sendNote}`,
                document: docSummary,
                warnings: documentWarnings(previewDoc),
                ...(sendSummary !== undefined ? { send: sendSummary } : {}),
              });
              return okResult(confirmation.summary.text, confirmation);
            }

            const document = yield* confirm(
              "issue_document",
              args.confirmationToken,
              undefined,
              (requestKey) =>
                documents.issue(
                  "draft" in args.from
                    ? { draft: args.from.draft, expectedRevision: args.from.revision }
                    : { input: args.from.input },
                  {
                    requestKey,
                    ...(args.send !== undefined ? { send: args.send } : {}),
                  },
                ),
            );
            return confirmedDocument(
              `Issued document ${document.number ?? document.id}.`,
              document,
            );
          });

        case "send_document":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(SendDocumentArgs, normalizedInput);
            const step = confirmStep(args);
            if (step === "malformed") return yield* confirmationRequiredError();

            const documents = yield* Documents;
            const sendOptions = {
              ...(args.to !== undefined ? { to: args.to } : {}),
              ...(args.language !== undefined ? { language: args.language } : {}),
              ...(args.reminders !== undefined ? { reminders: args.reminders } : {}),
              purpose: "document" as const,
            };

            if (step === "preview") {
              yield* requireActions(caller, requiredActions("send_document", {}));
              const doc = yield* documents.get(args.documentId);
              const sendPreview = yield* documents.previewSend(args.documentId, sendOptions);
              const minted = yield* mint("send_document", doc.revision);
              const confirmation = buildConfirmationRequired({
                action: "send_document",
                token: minted.token,
                expiresAt: minted.expiresAt,
                text: `Send ${doc.kind} ${doc.number ?? doc.id} to ${sendPreview.to.join(", ")} in ${sendPreview.language} (subject: "${sendPreview.subject}").`,
                document: documentSummaryOf(doc),
                send: {
                  to: [...sendPreview.to],
                  language: sendPreview.language,
                  subject: sendPreview.subject,
                },
              });
              return okResult(confirmation.summary.text, confirmation);
            }

            const delivery = yield* confirm(
              "send_document",
              args.confirmationToken,
              { table: "documents", id: args.documentId },
              (requestKey) => documents.send(args.documentId, sendOptions, { requestKey }),
            );
            return okResult(`Queued email delivery ${delivery.deliveryId}.`, {
              _tag: "Confirmed",
              result: delivery,
            });
          });

        case "send_reminder":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(SendReminderArgs, normalizedInput);
            const step = confirmStep(args);
            if (step === "malformed") return yield* confirmationRequiredError();

            const documents = yield* Documents;
            const sendOptions = {
              ...(args.to !== undefined ? { to: args.to } : {}),
              purpose: "reminder" as const,
            };

            if (step === "preview") {
              yield* requireActions(caller, requiredActions("send_reminder", {}));
              const doc = yield* documents.get(args.documentId);
              const sendPreview = yield* documents.previewSend(args.documentId, sendOptions);
              const minted = yield* mint("send_reminder", doc.revision);
              const confirmation = buildConfirmationRequired({
                action: "send_reminder",
                token: minted.token,
                expiresAt: minted.expiresAt,
                text: `Send payment reminder for ${doc.kind} ${doc.number ?? doc.id} to ${sendPreview.to.join(", ")} in ${sendPreview.language} (subject: "${sendPreview.subject}").`,
                document: documentSummaryOf(doc),
                send: {
                  to: [...sendPreview.to],
                  language: sendPreview.language,
                  subject: sendPreview.subject,
                },
              });
              return okResult(confirmation.summary.text, confirmation);
            }

            const delivery = yield* confirm(
              "send_reminder",
              args.confirmationToken,
              { table: "documents", id: args.documentId },
              (requestKey) => documents.send(args.documentId, sendOptions, { requestKey }),
            );
            return okResult(`Queued payment reminder ${delivery.deliveryId}.`, {
              _tag: "Confirmed",
              result: delivery,
            });
          });

        case "create_final_invoice":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(CreateFinalInvoiceArgs, normalizedInput);
            const step = confirmStep(args);
            if (step === "malformed") return yield* confirmationRequiredError();

            const documents = yield* Documents;
            const input = args.patch !== undefined ? { patch: args.patch } : undefined;

            if (step === "preview") {
              yield* requireActions(caller, requiredActions("create_final_invoice", {}));
              const proforma = yield* documents.get(args.proformaId);
              const previewDoc = yield* documents.previewFinalInvoice(args.proformaId, input);
              const minted = yield* mint("create_final_invoice", proforma.revision);
              const summary = documentSummaryOf(previewDoc);
              const confirmation = buildConfirmationRequired({
                action: "create_final_invoice",
                token: minted.token,
                expiresAt: minted.expiresAt,
                text: `Issue Final Invoice for Proforma ${proforma.number ?? proforma.id} (${summary.contact}), amount due ${summary.total} ${summary.currency}.`,
                document: summary,
                warnings: documentWarnings(previewDoc),
              });
              return okResult(confirmation.summary.text, confirmation);
            }

            const document = yield* confirm(
              "create_final_invoice",
              args.confirmationToken,
              { table: "documents", id: args.proformaId },
              (requestKey) => documents.issueFinalInvoice(args.proformaId, input, { requestKey }),
            );
            return confirmedDocument(
              `Issued Final Invoice ${document.number ?? document.id}.`,
              document,
            );
          });

        case "create_credit_note":
          return Effect.gen(function* () {
            const args = yield* decodeArgs(CreateCreditNoteArgs, normalizedInput);
            const step = confirmStep(args);
            if (step === "malformed") return yield* confirmationRequiredError();

            const documents = yield* Documents;
            const correctionInput = {
              reason: args.reason,
              lines: args.lines,
              ...(args.correctedOn !== undefined ? { correctedOn: args.correctedOn } : {}),
            };

            if (step === "preview") {
              yield* requireActions(caller, requiredActions("create_credit_note", {}));
              const source = yield* documents.get(args.documentId);
              const previewDoc = yield* documents.previewCorrection(
                args.documentId,
                correctionInput,
              );
              const minted = yield* mint("create_credit_note", source.revision);
              const summary = documentSummaryOf(previewDoc);
              const confirmation = buildConfirmationRequired({
                action: "create_credit_note",
                token: minted.token,
                expiresAt: minted.expiresAt,
                text: `Issue Credit Note against ${source.number ?? source.id} (${summary.contact}), total ${summary.total} ${summary.currency}, reason: "${args.reason}".`,
                document: summary,
                warnings: documentWarnings(previewDoc),
              });
              return okResult(confirmation.summary.text, confirmation);
            }

            const document = yield* confirm(
              "create_credit_note",
              args.confirmationToken,
              { table: "documents", id: args.documentId },
              (requestKey) => documents.correct(args.documentId, correctionInput, { requestKey }),
            );
            return confirmedDocument(
              `Issued Credit Note ${document.number ?? document.id}.`,
              document,
            );
          });
      }
    };

    return yield* executeTool().pipe(
      Effect.provideService(RequestOutcome, singleOutcome),
      Effect.catchIf(
        (error): error is CoreError => !(error instanceof ToolInvalidParams),
        (error) => Effect.succeed(coreErrorToolResult(error, caller)),
      ),
    );
  });
