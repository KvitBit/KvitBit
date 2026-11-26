import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ContactId,
  Contacts,
  CurrencyCode,
  CurrentCaller,
  type ExpenseId,
  IsoDate,
  PriceList,
  Templates,
} from "@kvitbit/domain/contract";
import { BigDecimal, Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeMcpHarness } from "./harness";

setDefaultTimeout(30_000);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** Recursively verifies no internal Effect BigDecimal representation leaked into JSON output. */
const findLeakedBigDecimalPaths = (value: unknown, path = "$"): Array<string> => {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, idx) => findLeakedBigDecimalPaths(entry, `${path}[${idx}]`));
  }
  const obj = value as Record<string, unknown>;
  if (obj._id === "BigDecimal") {
    return [path];
  }
  return Object.entries(obj).flatMap(([key, entry]) =>
    findLeakedBigDecimalPaths(entry, `${path}.${key}`),
  );
};

/**
 * Lightweight validator for the JSON Schema subset emitted by `Schema.toJsonSchemaDocument`
 * (`$defs`, `$ref`, `type`, `const`, `enum`, `anyOf`, `oneOf`, `allOf`, `properties`, `required`,
 * `additionalProperties`, `items`, `pattern`, `minimum`, `maximum`, `minLength`, `maxLength`).
 */
const validateJsonSchema = (
  value: unknown,
  schema: Record<string, unknown>,
  rootDefs: Record<string, Record<string, unknown>>,
  path = "$",
): Array<string> => {
  if (typeof schema.$ref === "string") {
    const refPrefix = "#/$defs/";
    if (!schema.$ref.startsWith(refPrefix)) {
      return [`${path}: unsupported $ref ${schema.$ref}`];
    }
    const targetName = schema.$ref.slice(refPrefix.length);
    const target = rootDefs[targetName];
    if (target === undefined) {
      return [`${path}: missing $defs entry ${targetName}`];
    }
    return validateJsonSchema(value, target, rootDefs, path);
  }

  if ("const" in schema && value !== schema.const) {
    return [
      `${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
    ];
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${path}: value ${JSON.stringify(value)} not in enum`];
  }

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as ReadonlyArray<Record<string, unknown>>;
    const matched = branches.some(
      (branch) => validateJsonSchema(value, branch, rootDefs, path).length === 0,
    );
    if (!matched) {
      return [`${path}: value did not match anyOf branches`];
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as ReadonlyArray<Record<string, unknown>>;
    const matches = branches.filter(
      (branch) => validateJsonSchema(value, branch, rootDefs, path).length === 0,
    ).length;
    if (matches !== 1) {
      return [`${path}: value matched ${matches} oneOf branches (expected 1)`];
    }
  }

  if (Array.isArray(schema.allOf)) {
    const branches = schema.allOf as ReadonlyArray<Record<string, unknown>>;
    const errors = branches.flatMap((branch) => validateJsonSchema(value, branch, rootDefs, path));
    if (errors.length > 0) return errors;
  }

  const schemaType = schema.type;
  if (schemaType !== undefined) {
    const allowedTypes = Array.isArray(schemaType) ? schemaType : [schemaType];
    const matchesType = allowedTypes.some((t) => {
      switch (t) {
        case "null":
          return value === null;
        case "boolean":
          return typeof value === "boolean";
        case "string":
          return typeof value === "string";
        case "number":
          return typeof value === "number" && Number.isFinite(value);
        case "integer":
          return typeof value === "number" && Number.isInteger(value);
        case "array":
          return Array.isArray(value);
        case "object":
          return typeof value === "object" && value !== null && !Array.isArray(value);
        default:
          return true;
      }
    });
    if (!matchesType) {
      return [
        `${path}: expected type ${JSON.stringify(schemaType)}, got ${
          value === null ? "null" : Array.isArray(value) ? "array" : typeof value
        }`,
      ];
    }
  }

  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      return [`${path}: string ${JSON.stringify(value)} failed pattern ${schema.pattern}`];
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return [`${path}: string shorter than minLength ${schema.minLength}`];
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return [`${path}: string longer than maxLength ${schema.maxLength}`];
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return [`${path}: number ${value} < minimum ${schema.minimum}`];
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return [`${path}: number ${value} > maximum ${schema.maximum}`];
    }
  }

  const errors: Array<string> = [];

  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    const itemSchema = schema.items as Record<string, unknown>;
    for (let i = 0; i < value.length; i++) {
      errors.push(...validateJsonSchema(value[i], itemSchema, rootDefs, `${path}[${i}]`));
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (typeof req === "string" && !(req in obj)) {
          errors.push(`${path}: missing required key ${req}`);
        }
      }
    }
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : undefined;
    if (properties !== undefined) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj) {
          errors.push(...validateJsonSchema(obj[key], propSchema, rootDefs, `${path}.${key}`));
        }
      }
    }
    if (schema.additionalProperties === false && properties !== undefined) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`${path}: unexpected additional property ${key}`);
        }
      }
    }
  }

  return errors;
};

describe("MCP wire-codec output encoding and per-grant rate limiting", () => {
  test("tools/call structuredContent and JSON resources match tools/list outputSchema with decimal strings", async () => {
    const h = makeMcpHarness({
      fixings: [
        {
          fixingDate: IsoDate.make("2026-11-23"),
          sequence: 227,
          rates: [
            {
              code: CurrencyCode.make("EUR"),
              quantity: 1,
              rate: BigDecimal.fromStringUnsafe("25.35"),
            },
          ],
        },
      ],
    });
    cleanup = h.dispose;

    const owner = h.addUser("Wire Owner");
    const ws = await h.createWorkspace(owner, {
      name: "Wire Co s.r.o.",
      taxRegime: "vat_payer",
    });
    const rw = h.addReadWriteGrant(owner, ws.workspaceId, "en");

    // Seed a contact, a price list item with decimal unitPrice, and a template with decimal line prices.
    const contactId = await h.run(
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const created = yield* contacts.save({
          name: "ACME Wire s.r.o.",
          roles: ["customer", "supplier"],
          address: { city: "Prague", country: "CZ" },
        });
        const priceList = yield* PriceList;
        yield* priceList.save({
          name: "Consulting Day",
          unit: "day",
          unitPrice: BigDecimal.fromStringUnsafe("2000"),
          currency: CurrencyCode.make("CZK"),
          vat: "standard",
        } as never);
        const templates = yield* Templates;
        yield* templates.save({
          name: "Monthly Retainer",
          kind: "invoice",
          contact: created.id,
          currency: CurrencyCode.make("CZK"),
          due: { inDays: 14 },
          lines: [
            {
              description: "Retainer",
              quantity: BigDecimal.fromStringUnsafe("1.5"),
              unitPrice: BigDecimal.fromStringUnsafe("10000.50"),
              vat: "standard",
            },
          ],
        } as never);
        return created.id as ContactId;
      }).pipe(Effect.provideService(CurrentCaller, ws)),
    );

    // Fetch declared outputSchemas from tools/list.
    const listed = await h.rpc(rw.token, "tools/list");
    expect(listed.res.status).toBe(200);
    const tools = (
      listed.json.result as {
        readonly tools: ReadonlyArray<{
          readonly name: string;
          readonly outputSchema: Record<string, unknown>;
        }>;
      }
    ).tools;
    const schemaByTool = new Map(tools.map((t) => [t.name, t.outputSchema]));

    const assertMatchesDeclaredSchema = (toolName: string, structured: unknown) => {
      const schema = schemaByTool.get(toolName);
      expect(schema).toBeDefined();
      if (schema === undefined) return;
      const defs = (schema.$defs as Record<string, Record<string, unknown>> | undefined) ?? {};
      const errors = validateJsonSchema(structured, schema, defs);
      expect(errors).toEqual([]);
      expect(findLeakedBigDecimalPaths(structured)).toEqual([]);
    };

    // 1. get_fx_rate: rate must be string "25.35", matching declared outputSchema.
    const fxCall = await h.callTool(rw.token, "get_fx_rate", {
      currency: "EUR",
      on: "2026-11-23",
    });
    expect(fxCall.result?.isError).toBe(false);
    expect(fxCall.result?.structuredContent?.rate).toBe("25.35");
    assertMatchesDeclaredSchema("get_fx_rate", fxCall.result?.structuredContent);

    // 2. list_price_list_items tool + kvitbit://price-list resource: unitPrice must be string "2000".
    const plCall = await h.callTool(rw.token, "list_price_list_items", {});
    expect(plCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("list_price_list_items", plCall.result?.structuredContent);
    const plItems = plCall.result?.structuredContent?.items as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(plItems[0]?.unitPrice).toBe("2000");

    const plRes = await h.readResource(rw.token, "kvitbit://price-list");
    expect(plRes.error).toBeUndefined();
    const plResJson = JSON.parse(plRes.contents?.[0]?.text as string) as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(plResJson[0]?.unitPrice).toBe("2000");
    expect(findLeakedBigDecimalPaths(plResJson)).toEqual([]);

    // 3. list_invoice_templates tool + kvitbit://templates resource.
    const tplCall = await h.callTool(rw.token, "list_invoice_templates", {});
    expect(tplCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("list_invoice_templates", tplCall.result?.structuredContent);
    const tplRes = await h.readResource(rw.token, "kvitbit://templates");
    expect(tplRes.error).toBeUndefined();
    expect(findLeakedBigDecimalPaths(JSON.parse(tplRes.contents?.[0]?.text as string))).toEqual([]);

    // 4. Foreign-currency draft + issue + get_document + list_documents + kvitbit://documents/{id}.
    const draftCall = await h.callTool(rw.token, "create_draft", {
      kind: "invoice",
      contact: contactId,
      currency: "EUR",
      paymentMethod: "bank_transfer",
      lines: [{ description: "Advisory", quantity: "2.5", unitPrice: "120.40", vat: "standard" }],
    });
    expect(draftCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("create_draft", draftCall.result?.structuredContent);
    const draftDoc = draftCall.result?.structuredContent?.document as Record<string, unknown>;
    const draftId = draftDoc.id as string;
    const draftRev = draftDoc.revision as number;
    expect((draftDoc.fx as { rate: unknown } | null)?.rate).toBe("25.35");
    expect(typeof (draftDoc.totals as { gross: { amount: unknown } }).gross.amount).toBe("string");
    expect(typeof (draftDoc.lines as ReadonlyArray<{ unitPrice: unknown }>)[0]?.unitPrice).toBe(
      "string",
    );

    const issuePreview = await h.callTool(rw.token, "issue_document", {
      from: { draft: draftId, revision: draftRev },
    });
    expect(issuePreview.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("issue_document", issuePreview.result?.structuredContent);
    const token = issuePreview.result?.structuredContent?.confirmationToken as string;

    const issueConfirm = await h.callTool(rw.token, "issue_document", {
      from: { draft: draftId, revision: draftRev },
      confirm: true,
      confirmationToken: token,
    });
    expect(issueConfirm.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("issue_document", issueConfirm.result?.structuredContent);

    // Replay returns identical encoded wire output.
    const issueReplay = await h.callTool(rw.token, "issue_document", {
      from: { draft: draftId, revision: draftRev },
      confirm: true,
      confirmationToken: token,
    });
    expect(issueReplay.result).toEqual(issueConfirm.result);

    const getDocCall = await h.callTool(rw.token, "get_document", { documentId: draftId });
    expect(getDocCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("get_document", getDocCall.result?.structuredContent);

    const docRes = await h.readResource(rw.token, `kvitbit://documents/${draftId}`);
    expect(docRes.error).toBeUndefined();
    const docResJson = JSON.parse(docRes.contents?.[0]?.text as string) as Record<string, unknown>;
    expect((docResJson.fx as { rate: unknown } | null)?.rate).toBe("25.35");
    expect(findLeakedBigDecimalPaths(docResJson)).toEqual([]);

    const listDocsCall = await h.callTool(rw.token, "list_documents", {});
    expect(listDocsCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("list_documents", listDocsCall.result?.structuredContent);

    // 5. Payments + Expenses + Reports + Workspace + Contact resources.
    const payCall = await h.callTool(rw.token, "record_payment", {
      target: { document: draftId },
      paidOn: "2026-11-23",
      method: "bank_transfer",
    });
    expect(payCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("record_payment", payCall.result?.structuredContent);

    const listPayCall = await h.callTool(rw.token, "list_payments", {
      target: { document: draftId },
    });
    expect(listPayCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("list_payments", listPayCall.result?.structuredContent);

    const expCall = await h.callTool(rw.token, "record_expense", {
      expense: {
        status: "complete",
        supplier: { contact: contactId },
        issuedOn: "2026-11-23",
        taxableSupplyOn: "2026-11-23",
        currency: "CZK",
        total: "604.88",
        vat: [{ treatment: "standard", base: "499.90", vat: "104.98" }],
        category: "office",
      },
    });
    expect(expCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("record_expense", expCall.result?.structuredContent);
    const expenseId = (expCall.result?.structuredContent?.expense as { id: ExpenseId } | undefined)
      ?.id;
    expect(expenseId).toBeDefined();

    const expRes = await h.readResource(rw.token, `kvitbit://expenses/${expenseId}`);
    expect(expRes.error).toBeUndefined();
    expect(findLeakedBigDecimalPaths(JSON.parse(expRes.contents?.[0]?.text as string))).toEqual([]);

    const reportCall = await h.callTool(rw.token, "get_report", {
      report: "vat",
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(reportCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("get_report", reportCall.result?.structuredContent);

    const wsCall = await h.callTool(rw.token, "get_workspace", {});
    expect(wsCall.result?.isError).toBe(false);
    assertMatchesDeclaredSchema("get_workspace", wsCall.result?.structuredContent);

    for (const uri of ["kvitbit://workspace", `kvitbit://contacts/${contactId}`]) {
      const res = await h.readResource(rw.token, uri);
      expect(res.error).toBeUndefined();
      expect(findLeakedBigDecimalPaths(JSON.parse(res.contents?.[0]?.text as string))).toEqual([]);
    }
  });

  test("enforces 300/min per MCP grant with shared trailing sliding window before body decoding", async () => {
    const h = makeMcpHarness();
    cleanup = h.dispose;

    const peer = h.createInstance();
    const owner = h.addUser("Rate Owner");
    const ws = await h.createWorkspace(owner);
    const grantA = h.addReadWriteGrant(owner, ws.workspaceId);
    const grantB = h.addReadWriteGrant(owner, ws.workspaceId);

    // 100 requests at t=0s on instance 1.
    for (let i = 0; i < 100; i++) {
      const { res } = await h.rpc(grantA.token, "ping", undefined, i + 1);
      expect(res.status).toBe(200);
    }

    // Advance 40s; send 200 more requests on instance 2 (shared RateLimiterSql counter reaches 300).
    await h.run(TestClock.adjust(Duration.seconds(40)));
    for (let i = 0; i < 200; i++) {
      const { res } = await peer.rpc(grantA.token, "ping", undefined, 1000 + i);
      expect(res.status).toBe(200);
    }

    // Advance 10s (t=50s): 301st request is denied with 429 and Retry-After: 10 BEFORE body decoding
    // (invalid JSON body still gets 429, not 400 Parse error).
    await h.run(TestClock.adjust(Duration.seconds(10)));
    const denied = await h.postMcp(grantA.token, "{not-valid-json");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("10");
    expect(await denied.json()).toEqual({ _tag: "RateLimited", retryAfterSeconds: 10 });

    // Separate grant is isolated and still succeeds.
    const otherGrant = await peer.rpc(grantB.token, "ping", undefined, 1);
    expect(otherGrant.res.status).toBe(200);

    // Advance 10s (t=60s): only the 100 admissions from t=0s expire; the 200 from t=40s remain live.
    await h.run(TestClock.adjust(Duration.seconds(10)));
    for (let i = 0; i < 100; i++) {
      const { res } = await h.rpc(grantA.token, "ping", undefined, 2000 + i);
      expect(res.status).toBe(200);
    }

    // 101st request at t=60s is denied with Retry-After: 40 (oldest remaining admission was at t=40s).
    const deniedAgain = await peer.postMcp(grantA.token, {
      jsonrpc: "2.0",
      id: 9999,
      method: "ping",
    });
    expect(deniedAgain.status).toBe(429);
    expect(deniedAgain.headers.get("retry-after")).toBe("40");
    expect(await deniedAgain.json()).toEqual({ _tag: "RateLimited", retryAfterSeconds: 40 });
  });
});
