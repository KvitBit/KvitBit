import { describe, expect, test } from "bun:test";
import { Action, Scope } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import type * as JsonSchema from "effect/JsonSchema";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  ConfirmationRequired,
  CreateDraftArgs,
  confirmationBoundArgs,
  confirmStep,
  DocumentResult,
  ExpenseListQuery,
  IssueDocumentArgs,
  ListContactsArgs,
  ListExpensesArgs,
  MCP_RESOURCES,
  MCP_TOOLS,
  McpToolError,
  mcpConfirmRequestKey,
  mcpRequestKey,
  reportKindFromMcp,
  requiredActions,
  SendDocumentArgs,
  toolJsonSchema,
  twoStepOutput,
  UpsertContactArgs,
} from "../src/index";

/**
 * Section 6.5 tool table: name, scope, mode (1 single, 2 two-step, 1/2 two-step when issued),
 * annotations, actions.
 */
const SPEC = `
get_workspace workspace:read 1 RO workspace.read
list_documents documents:read 1 RO document.read
get_document documents:read 1 RO document.read
get_document_history documents:read 1 RO document.history
get_document_pdf documents:read 1 RO document.pdf
list_payments payments:read 1 RO payment.read
list_invoice_templates templates:read 1 RO template.read
list_expenses expenses:read 1 RO expense.read
get_expense expenses:read 1 RO expense.read
list_contacts contacts:read 1 RO contact.read
lookup_ares contacts:read 1 RO,O contact.read
list_price_list_items catalog:read 1 RO priceList.read
get_share_link share:read 1 RO share.read
get_report reports:read 1 RO report.run
get_fx_rate reports:read 1 RO,O report.run
create_draft documents:write 1 - document.draft
update_draft documents:write 1 I document.edit
upsert_contact contacts:write 1 I,O contact.write
record_expense expenses:write 1 - expense.write
record_payment payments:write 1 - payment.write
settle_proforma payments:write 1 - payment.write
lock_document documents:write 1 I document.lock
create_from_template documents:write 1/2 - document.draft,document.issue
issue_document documents:write 2 D document.issue,document.send
send_document documents:write 2 O document.send
send_reminder documents:write 2 O document.send
create_final_invoice documents:write 2 D document.finalInvoice
create_credit_note documents:write 2 D document.correct
`;

const MODES: Readonly<Record<string, string>> = {
  "1": "single",
  "2": "two_step",
  "1/2": "two_step_when_issued",
};
const spec = Arr.map(Str.split(Str.trim(SPEC), "\n"), (line) => {
  const [name = "", scope = "", mode = "", hints = "", actions = ""] = Str.split(line, " ");
  const flags: ReadonlyArray<string> = hints === "-" ? [] : Str.split(hints, ",");
  return {
    name,
    scope,
    mode: MODES[mode],
    annotations: {
      readOnlyHint: flags.includes("RO"),
      destructiveHint: flags.includes("D"),
      idempotentHint: flags.includes("I"),
      openWorldHint: flags.includes("O"),
    },
    actions: Str.split(actions, ","),
  };
});

const json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Fn.flow(Schema.encodeEffect(json), Effect.runSync);
const LOCAL_REF = /"\$ref":"#\/\$defs\/([^"]+)"/g;
const EXTERNAL_REF = /"\$ref":"(?!#\/\$defs\/)/;
const schemaProperties = ({ properties }: JsonSchema.JsonSchema) =>
  Predicate.isObject(properties) ? properties : {};

describe("MCP tool catalog", () => {
  test("matches the section 6.5 table: 28 tools in order with scope, mode, hints, actions", () => {
    expect(spec).toHaveLength(28);
    expect<unknown>(
      Arr.map(MCP_TOOLS, ({ name, scope, mode, annotations, actions }) => ({
        name,
        scope,
        mode,
        annotations,
        actions: [...actions],
      })),
    ).toEqual(spec);
  });

  test("read-only tools need <area>:read, every other tool <area>:write", () => {
    for (const t of MCP_TOOLS) {
      expect(Schema.is(Scope)(t.scope)).toBe(true);
      expect([t.name, Str.endsWith(":read")(t.scope)]).toEqual([
        t.name,
        t.annotations.readOnlyHint,
      ]);
    }
  });

  test("every action is a core Action", () => {
    for (const t of MCP_TOOLS) for (const a of t.actions) expect(Schema.is(Action)(a)).toBe(true);
  });

  test("input and output JSON Schemas are objects, as MCP requires", () => {
    for (const t of MCP_TOOLS) {
      expect([t.name, toolJsonSchema(t.input).type, toolJsonSchema(t.output).type]).toEqual([
        t.name,
        "object",
        "object",
      ]);
    }
  });

  test("no tool input schema has a root anyOf, oneOf or allOf", () => {
    for (const t of MCP_TOOLS) {
      const root = toolJsonSchema(t.input);
      expect([t.name, "anyOf" in root, "oneOf" in root, "allOf" in root]).toEqual([
        t.name,
        false,
        false,
        false,
      ]);
    }
  });

  test("every $ref in a tool schema resolves inside its own $defs", () => {
    for (const t of MCP_TOOLS) {
      for (const schema of [toolJsonSchema(t.input), toolJsonSchema(t.output)]) {
        const defs = Predicate.isObject(schema.$defs) ? schema.$defs : {};
        const encoded = encodeJson(schema);
        for (const match of Str.matchAll(LOCAL_REF)(encoded)) {
          expect([t.name, match[1] ?? "", (match[1] ?? "") in defs]).toEqual([
            t.name,
            match[1] ?? "",
            true,
          ]);
        }
        expect(encoded).not.toMatch(EXTERNAL_REF);
      }
    }
  });

  test("no tool takes a workspaceId; two-step tools take confirm and confirmationToken", () => {
    for (const t of MCP_TOOLS) {
      const properties = t.input.pipe(toolJsonSchema, schemaProperties, Record.keys);
      expect(properties).not.toContain("workspaceId");
      const twoStep = t.mode !== "single";
      expect([
        t.name,
        properties.includes("confirm"),
        properties.includes("confirmationToken"),
      ]).toEqual([t.name, twoStep, twoStep]);
    }
  });

  test("required actions depend on send and as", () => {
    expect(requiredActions("issue_document", {})).toEqual(["document.issue"]);
    expect(requiredActions("issue_document", { send: {} })).toEqual([
      "document.issue",
      "document.send",
    ]);
    expect(requiredActions("create_from_template", {})).toEqual(["document.draft"]);
    expect(requiredActions("create_from_template", { as: "issued" })).toEqual([
      "document.draft",
      "document.issue",
    ]);
    expect(requiredActions("get_report", {})).toEqual(["report.run"]);
  });

  test("get_report maps the vat alias to vat_summary", () => {
    expect(reportKindFromMcp("vat")).toBe("vat_summary");
    expect(reportKindFromMcp("cashflow")).toBe("cashflow");
  });
});

const DOC = "01936f3e-7b4c-7d2a-9f1e-3c5a7b9d1e2f";
// biome-ignore lint/security/noSecrets: Fixed fake confirmation token.
const TOKEN = "mcpc_01JDXq9w8e7r6t5y4u3i";

describe("two-step preview and confirm schemas", () => {
  const example = {
    _tag: "ConfirmationRequired",
    confirmationToken: TOKEN,
    expiresAt: "2026-11-22T14:10:00Z",
    action: "issue_document",
    summary: {
      text: "Issue Invoice for ACME s.r.o., 12 100,00 CZK incl. 21 % VAT.",
      document: {
        kind: "invoice",
        contact: "ACME s.r.o.",
        currency: "CZK",
        total: "12100.00",
        vat: [{ rate: "21", base: "10000.00", vat: "2100.00" }],
        dueOn: "2026-12-06",
      },
      send: { to: ["fakturace@acme.cz"], language: "cs" },
    },
    warnings: ["document.no_bank_account_for_currency"],
    next: "Show this summary to the user.",
  };

  test("the section 6.6 example decodes and round-trips", () => {
    const decoded = Schema.decodeUnknownEffect(ConfirmationRequired)(example).pipe(Effect.runSync);
    expect<unknown>(
      Schema.encodeEffect(ConfirmationRequired)(decoded).pipe(Effect.runSync),
    ).toEqual(example);
  });

  test("ConfirmationRequired rejects malformed tokens, amounts and empty summaries", () => {
    const decode = Fn.flow(Schema.decodeUnknownEffect(ConfirmationRequired), Effect.runSync);
    expect(() => decode({ ...example, confirmationToken: "tok_123" })).toThrow();
    expect(() => decode({ ...example, confirmationToken: "mcpc_short" })).toThrow();
    expect(() =>
      decode({
        ...example,
        summary: {
          ...example.summary,
          document: { ...example.summary.document, total: "12 100,00" },
        },
      }),
    ).toThrow();
    expect(() => decode({ ...example, summary: { text: "" } })).toThrow();
  });

  test("two-step output is either the preview or a Confirmed result", () => {
    const output = Fn.flow(
      Schema.decodeUnknownEffect(twoStepOutput(Schema.Struct({ ok: Schema.Boolean }))),
      Effect.runSync,
    );
    expect(output(example)).toMatchObject({ _tag: "ConfirmationRequired" });
    expect(output({ _tag: "Confirmed", result: { ok: true } })).toEqual({
      _tag: "Confirmed",
      result: { ok: true },
    });
    expect(() => output({ _tag: "Confirmed", result: {} })).toThrow();
    expect(DocumentResult.pipe(twoStepOutput, toolJsonSchema).type).toBe("object");
  });

  test("args decode for preview and confirm; confirm must be literally true", () => {
    const decode = Fn.flow(Schema.decodeUnknownEffect(IssueDocumentArgs), Effect.runSync);
    const preview = decode({ from: { draft: DOC, revision: 4 }, send: { to: ["a@b.cz"] } });
    expect(confirmStep(preview)).toBe("preview");
    const confirm = decode({
      from: { draft: DOC, revision: 4 },
      confirm: true,
      confirmationToken: TOKEN,
    });
    expect(confirmStep(confirm)).toBe("confirm");
    expect(confirmStep(decode({ from: { draft: DOC, revision: 4 }, confirm: true }))).toBe(
      "malformed",
    );
    expect(
      confirmStep(decode({ from: { draft: DOC, revision: 4 }, confirmationToken: TOKEN })),
    ).toBe("malformed");
    expect(() => decode({ from: { draft: DOC, revision: 4 }, confirm: false })).toThrow();
    expect(() => decode({ from: { draft: DOC } })).toThrow();
    expect(() => decode({ from: { draft: "nope", revision: 1 } })).toThrow();
  });

  test("send_document has no purpose argument", () => {
    const properties = SendDocumentArgs.pipe(toolJsonSchema, schemaProperties, Record.keys);
    expect(properties).not.toContain("purpose");
    expect(properties).toEqual(
      expect.arrayContaining(["documentId", "to", "language", "reminders"]),
    );
  });

  test("the confirmation hash ignores confirm, confirmationToken and idempotencyKey", () => {
    expect(
      confirmationBoundArgs({
        documentId: DOC,
        confirm: true,
        confirmationToken: TOKEN,
        idempotencyKey: Str.repeat(8)("k"),
      }),
    ).toEqual({ documentId: DOC });
  });

  test("retry keys use the confirmation id or the grant plus idempotencyKey", () => {
    expect<string>(mcpConfirmRequestKey("0193")).toBe("mcp-confirm:0193");
    expect<string>(mcpRequestKey("grant-1", "abcdefgh")).toBe("mcp:grant-1:abcdefgh");
  });

  test("single-call idempotencyKey follows the Idempotency-Key format", () => {
    const fields = CreateDraftArgs.fields;
    expect(Record.keys(fields)).toContain("idempotencyKey");
    const decode = Fn.flow(
      Schema.decodeUnknownEffect(Schema.Struct({ idempotencyKey: fields.idempotencyKey })),
      Effect.runSync,
    );
    expect(decode({ idempotencyKey: "abcdefgh" })).toEqual({ idempotencyKey: "abcdefgh" });
    expect(() => decode({ idempotencyKey: "short" })).toThrow();
  });

  test("tool errors carry the encoded core error", () => {
    const decoded = Schema.decodeEffect(McpToolError)({
      error: { _tag: "Forbidden", action: "document.issue" },
    }).pipe(Effect.runSync);
    expect(decoded.error._tag).toBe("Forbidden");
  });
});

describe("MCP resources", () => {
  test("four static resources and five templates, as in section 6.7", () => {
    expect(
      Arr.map(
        Arr.filter(MCP_RESOURCES, (r) => r.kind === "static"),
        (r) => r.uri,
      ),
    ).toEqual([
      "kvitbit://workspace",
      "kvitbit://templates",
      "kvitbit://price-list",
      "kvitbit://guide",
    ]);
    expect(
      Arr.map(
        Arr.filter(MCP_RESOURCES, (r) => r.kind === "template"),
        (r) => r.uri,
      ),
    ).toEqual([
      "kvitbit://documents/{documentId}",
      "kvitbit://documents/{documentId}/pdf{?template,language}",
      "kvitbit://contacts/{contactId}",
      "kvitbit://expenses/{expenseId}",
      "kvitbit://expenses/{expenseId}/attachments/{attachmentId}",
    ]);
    for (const r of MCP_RESOURCES) {
      if (r.action === null) continue;
      expect(Schema.is(Action)(r.action)).toBe(true);
    }
  });
});

describe("upsert_contact argument forms", () => {
  const decode = Fn.flow(Schema.decodeUnknownEffect(UpsertContactArgs), Effect.runSync);
  const contact = { name: "Acme s.r.o." };
  const contactId = "01936f3e-7b4c-7d2a-9f1e-3c5a7b9d1e2f";

  test("accepts ico, contact, and contactId with revision and contact", () => {
    expect(decode({ ico: "12345678", role: "supplier" })).toEqual({
      ico: "12345678",
      role: "supplier",
    });
    expect(() => decode({ contact, idempotencyKey: "retry-key-1" })).not.toThrow();
    expect(() => decode({ contactId, revision: 3, contact })).not.toThrow();
  });

  test.each([
    ["empty", {}],
    ["only an idempotency key", { idempotencyKey: "retry-key-1" }],
    ["both ico and contact", { ico: "12345678", contact }],
    ["contactId without revision", { contactId, contact }],
    ["revision without contactId", { revision: 3, contact }],
    ["contactId without contact", { contactId, revision: 3, ico: "12345678" }],
    ["role without ico", { role: "customer", contact }],
  ] as const)("rejects %s", (_, args) => {
    expect(() => decode(args)).toThrow();
  });

  test("the JSON Schema describes the valid forms and the Contact revision", () => {
    const schema = toolJsonSchema(UpsertContactArgs);
    expect(String(schema.description)).toContain("{ contactId, revision, contact }");
    const revision = encodeJson(schemaProperties(schema).revision);
    expect(revision).toContain("Contact revision");
    expect(revision).not.toContain("document revision");
  });
});

describe("list_expenses arguments", () => {
  const decode = Fn.flow(Schema.decodeUnknownEffect(ListExpensesArgs), Effect.runSync);

  test("are incomplete plus paging, the same fields as the HTTP list query", () => {
    const properties = ListExpensesArgs.pipe(toolJsonSchema, schemaProperties, Record.keys);
    expect(Arr.sort(properties, Order.String)).toEqual(["cursor", "incomplete", "limit"]);
    expect(Arr.sort(Record.keys(ExpenseListQuery), Order.String)).toEqual([
      "cursor",
      "incomplete",
      "limit",
    ]);
  });

  test("typed decode and encode accept the modeled fields", () => {
    const wire: typeof ListExpensesArgs.Encoded = { incomplete: true };
    expect(Schema.decodeEffect(ListExpensesArgs)(wire).pipe(Effect.runSync)).toEqual({
      incomplete: true,
    });
    expect(
      Schema.decodeEffect(ListExpensesArgs)({ incomplete: true, limit: 3 }).pipe(Effect.runSync),
    ).toEqual({
      incomplete: true,
      limit: 3,
    });
    const args: typeof ListExpensesArgs.Type = { cursor: "c1" };
    expect(Schema.encodeEffect(ListExpensesArgs)(args).pipe(Effect.runSync)).toEqual({
      cursor: "c1",
    });
  });

  test("decode the modeled fields and reject any other, with default options", () => {
    expect(decode({})).toEqual({});
    expect(decode({ incomplete: true, cursor: "c1", limit: 10 })).toEqual({
      incomplete: true,
      cursor: "c1",
      limit: 10,
    });
    expect(() => decode({ supplier: "demo" })).toThrow();
    expect(() => decode({ incomplete: true, contactId: "x" })).toThrow();
    expect(() => decode({ limit: 0 })).toThrow();
    expect(() => decode({ incomplete: "yes" })).toThrow();
    expect(() => decode(null)).toThrow();
  });

  test("the JSON Schema is closed", () => {
    expect(toolJsonSchema(ListExpensesArgs).additionalProperties).toBe(false);
  });

  test("only list_expenses is closed so far; other inputs still drop extras", () => {
    expect(
      Arr.map(
        Arr.filter(MCP_TOOLS, (t) => t.closedInput),
        (t) => t.name,
      ),
    ).toEqual(["list_expenses"]);
    const listExpenses = Option.getOrUndefined(
      Arr.findFirst(MCP_TOOLS, (t) => t.name === "list_expenses"),
    );
    expect(listExpenses?.input).toBe(ListExpensesArgs);
    expect(
      Schema.decodeUnknownEffect(ListContactsArgs)({ text: "Ada", extra: true }).pipe(
        Effect.runSync,
      ),
    ).toEqual({
      text: "Ada",
    });
    expect(toolJsonSchema(ListContactsArgs).additionalProperties).toBe(true);
  });
});
