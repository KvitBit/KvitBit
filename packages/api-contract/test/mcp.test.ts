import { describe, expect, test } from "bun:test";
import { Action, Scope } from "@kvitbit/domain/contract";
import { Schema } from "effect";
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
  toolInputJsonSchema,
  toolInputParseOptions,
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

const MODES = { "1": "single", "2": "two_step", "1/2": "two_step_when_issued" } as const;
const spec = SPEC.trim()
  .split("\n")
  .map((line) => {
    const [name = "", scope = "", mode = "", hints = "", actions = ""] = line.split(" ");
    const flags = hints === "-" ? [] : hints.split(",");
    return {
      name,
      scope,
      mode: MODES[mode as keyof typeof MODES],
      annotations: {
        readOnlyHint: flags.includes("RO"),
        destructiveHint: flags.includes("D"),
        idempotentHint: flags.includes("I"),
        openWorldHint: flags.includes("O"),
      },
      actions: actions.split(","),
    };
  });

describe("MCP tool catalog", () => {
  test("matches the section 6.5 table: 28 tools in order with scope, mode, hints, actions", () => {
    expect(spec).toHaveLength(28);
    expect<unknown>(
      MCP_TOOLS.map(({ name, scope, mode, annotations, actions }) => ({
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
      expect([t.name, t.scope.endsWith(":read")]).toEqual([t.name, t.annotations.readOnlyHint]);
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
        const defs = (schema.$defs as Record<string, unknown> | undefined) ?? {};
        for (const match of JSON.stringify(schema).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)) {
          expect([t.name, match[1] ?? "", (match[1] ?? "") in defs]).toEqual([
            t.name,
            match[1] ?? "",
            true,
          ]);
        }
        expect(JSON.stringify(schema)).not.toMatch(/"\$ref":"(?!#\/\$defs\/)/);
      }
    }
  });

  test("no tool takes a workspaceId; two-step tools take confirm and confirmationToken", () => {
    for (const t of MCP_TOOLS) {
      const properties = Object.keys(
        (toolJsonSchema(t.input).properties as Record<string, unknown> | undefined) ?? {},
      );
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
    const decoded = Schema.decodeUnknownSync(ConfirmationRequired)(example);
    expect<unknown>(Schema.encodeSync(ConfirmationRequired)(decoded)).toEqual(example);
  });

  test("ConfirmationRequired rejects malformed tokens, amounts and empty summaries", () => {
    const decode = Schema.decodeUnknownSync(ConfirmationRequired);
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
    const output = Schema.decodeUnknownSync(twoStepOutput(Schema.Struct({ ok: Schema.Boolean })));
    expect(output(example)).toMatchObject({ _tag: "ConfirmationRequired" });
    expect(output({ _tag: "Confirmed", result: { ok: true } })).toEqual({
      _tag: "Confirmed",
      result: { ok: true },
    });
    expect(() => output({ _tag: "Confirmed", result: {} })).toThrow();
    expect(toolJsonSchema(twoStepOutput(DocumentResult)).type).toBe("object");
  });

  test("args decode for preview and confirm; confirm must be literally true", () => {
    const decode = Schema.decodeUnknownSync(IssueDocumentArgs);
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
    const properties = Object.keys(toolJsonSchema(SendDocumentArgs).properties as object);
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
        idempotencyKey: "k".repeat(8),
      }),
    ).toEqual({ documentId: DOC });
  });

  test("retry keys use the confirmation id or the grant plus idempotencyKey", () => {
    expect(mcpConfirmRequestKey("0193")).toBe("mcp-confirm:0193" as never);
    expect(mcpRequestKey("grant-1", "abcdefgh")).toBe("mcp:grant-1:abcdefgh" as never);
  });

  test("single-call idempotencyKey follows the Idempotency-Key format", () => {
    const fields = CreateDraftArgs.fields;
    expect(Object.keys(fields)).toContain("idempotencyKey");
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({ idempotencyKey: fields.idempotencyKey }),
    );
    expect(decode({ idempotencyKey: "abcdefgh" })).toEqual({ idempotencyKey: "abcdefgh" });
    expect(() => decode({ idempotencyKey: "short" })).toThrow();
  });

  test("tool errors carry the encoded core error", () => {
    const decoded = Schema.decodeUnknownSync(McpToolError)({
      error: { _tag: "Forbidden", action: "document.issue" },
    });
    expect(decoded.error._tag).toBe("Forbidden");
  });
});

describe("MCP resources", () => {
  test("four static resources and five templates, as in section 6.7", () => {
    expect(MCP_RESOURCES.filter((r) => r.kind === "static").map((r) => r.uri)).toEqual([
      "kvitbit://workspace",
      "kvitbit://templates",
      "kvitbit://price-list",
      "kvitbit://guide",
    ]);
    expect(MCP_RESOURCES.filter((r) => r.kind === "template").map((r) => r.uri)).toEqual([
      "kvitbit://documents/{documentId}",
      "kvitbit://documents/{documentId}/pdf{?template,language}",
      "kvitbit://contacts/{contactId}",
      "kvitbit://expenses/{expenseId}",
      "kvitbit://expenses/{expenseId}/attachments/{attachmentId}",
    ]);
    for (const r of MCP_RESOURCES)
      if (r.action !== null) expect(Schema.is(Action)(r.action)).toBe(true);
  });
});

describe("upsert_contact argument forms", () => {
  const decode = Schema.decodeUnknownSync(UpsertContactArgs);
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
    const revision = JSON.stringify((schema.properties as Record<string, unknown>).revision);
    expect(revision).toContain("Contact revision");
    expect(revision).not.toContain("document revision");
  });
});

describe("list_expenses arguments", () => {
  test("are incomplete plus paging, the same fields as the HTTP list query", () => {
    expect(Object.keys(ListExpensesArgs.fields).sort()).toEqual(
      ["cursor", "incomplete", "limit"].sort(),
    );
    expect(Object.keys(ListExpensesArgs.fields).sort()).toEqual(
      Object.keys(ExpenseListQuery).sort(),
    );
  });

  test("is a closed input: unmodeled filters fail and the schema says so", () => {
    const listExpenses = MCP_TOOLS.find((t) => t.name === "list_expenses");
    if (listExpenses === undefined) throw new Error("list_expenses missing");
    const decode = Schema.decodeUnknownSync(ListExpensesArgs);
    const options = toolInputParseOptions(listExpenses);
    expect(() => decode({ incomplete: true, supplier: "x" }, options)).toThrow();
    expect(() => decode({ incomplete: true, limit: 10 }, options)).not.toThrow();
    expect(toolInputJsonSchema(listExpenses).additionalProperties).toBe(false);
  });

  test("only list_expenses is closed so far", () => {
    expect(MCP_TOOLS.filter((t) => t.closedInput).map((t) => t.name)).toEqual(["list_expenses"]);
    const listContacts = MCP_TOOLS.find((t) => t.name === "list_contacts");
    if (listContacts === undefined) throw new Error("list_contacts missing");
    const decoded = Schema.decodeUnknownSync(ListContactsArgs)(
      { text: "Ada", extra: true },
      toolInputParseOptions(listContacts),
    );
    expect(decoded).toEqual({ text: "Ada" });
    expect(toolInputJsonSchema(listContacts).additionalProperties).toBe(true);
  });
});
