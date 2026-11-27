import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  ContactId,
  Contacts,
  CurrencyCode,
  CurrentCaller,
  ExpenseId,
  IsoDate,
  PriceList,
  PriceListItemInput,
  Templates,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Formatter from "effect/Formatter";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { makeMcpHarness } from "./harness";

setDefaultTimeout(30_000);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value);
const isJsonArray = (value: Schema.Json | undefined): value is Schema.JsonArray =>
  Arr.isArray(value);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const decodeResourceJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const decodeToolList = Schema.decodeUnknownEffect(
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({ name: Schema.String, outputSchema: Schema.optional(Schema.JsonObject) }),
    ),
  }),
);
const decodePriceListItems = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ unitPrice: Schema.String })),
);
const FxRate = Schema.NullOr(Schema.Struct({ rate: Schema.Json }));
const decodeDraft = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.String,
    revision: Schema.Int,
    fx: FxRate,
    totals: Schema.Struct({ gross: Schema.Struct({ amount: Schema.Json }) }),
    lines: Schema.Array(Schema.Struct({ unitPrice: Schema.Json })),
  }),
);
const decodeDocumentFx = Schema.decodeUnknownEffect(Schema.Struct({ fx: FxRate }));
const decodeConfirmation = Schema.decodeUnknownEffect(
  Schema.Struct({ confirmationToken: Schema.String }),
);
const decodeExpense = Schema.decodeUnknownEffect(Schema.Struct({ id: ExpenseId }));

/** Recursively verifies no internal Effect BigDecimal representation leaked into JSON output. */
const findLeakedBigDecimalPaths = (value: Schema.Json, path = "$"): Array<string> => {
  if (isJsonArray(value)) {
    return Arr.flatMap(value, (entry, idx) => findLeakedBigDecimalPaths(entry, `${path}[${idx}]`));
  }
  if (!isJsonObject(value)) return [];
  if (value["_id"] === "BigDecimal") {
    return [path];
  }
  return Arr.flatMap(EffectRecord.toEntries(value), ([key, entry]) =>
    findLeakedBigDecimalPaths(entry, `${path}.${key}`),
  );
};

/**
 * Lightweight validator for the JSON Schema subset emitted by `Schema.toJsonSchemaDocument`
 * (`$defs`, `$ref`, `type`, `const`, `enum`, `anyOf`, `oneOf`, `allOf`, `properties`, `required`,
 * `additionalProperties`, `items`, `pattern`, `minimum`, `maximum`, `minLength`, `maxLength`).
 */
const validateJsonSchema = (
  value: Schema.Json,
  schema: Schema.Json,
  rootDefs: Schema.Json,
  path = "$",
): Array<string> => {
  if (!isJsonObject(schema)) return [`${path}: expected a schema object`];

  if (Predicate.isString(schema["$ref"])) {
    const refPrefix = "#/$defs/";
    if (!Str.startsWith(refPrefix)(schema["$ref"])) {
      return [`${path}: unsupported $ref ${schema["$ref"]}`];
    }
    const targetName = Str.slice(refPrefix.length)(schema["$ref"]);
    const target = isJsonObject(rootDefs) ? rootDefs[targetName] : undefined;
    if (target === undefined) {
      return [`${path}: missing $defs entry ${targetName}`];
    }
    return validateJsonSchema(value, target, rootDefs, path);
  }

  if ("const" in schema && value !== schema["const"]) {
    return [
      `${path}: expected const ${Formatter.formatJson(schema["const"])}, got ${Formatter.formatJson(value)}`,
    ];
  }

  if (isJsonArray(schema["enum"]) && !Arr.some(schema["enum"], (entry) => entry === value)) {
    return [`${path}: value ${Formatter.formatJson(value)} not in enum`];
  }

  if (isJsonArray(schema["anyOf"])) {
    const matched = Arr.some(
      schema["anyOf"],
      (branch) => validateJsonSchema(value, branch, rootDefs, path).length === 0,
    );
    if (!matched) {
      return [`${path}: value did not match anyOf branches`];
    }
  }

  if (isJsonArray(schema["oneOf"])) {
    const matches = Arr.filter(
      schema["oneOf"],
      (branch) => validateJsonSchema(value, branch, rootDefs, path).length === 0,
    ).length;
    if (matches !== 1) {
      return [`${path}: value matched ${matches} oneOf branches (expected 1)`];
    }
  }

  if (isJsonArray(schema["allOf"])) {
    const errors = Arr.flatMap(schema["allOf"], (branch) =>
      validateJsonSchema(value, branch, rootDefs, path),
    );
    if (errors.length > 0) return errors;
  }

  const schemaType = schema["type"];
  if (schemaType !== undefined) {
    const allowedTypes = isJsonArray(schemaType) ? schemaType : [schemaType];
    const matchesType = Arr.some(allowedTypes, (t) => {
      switch (t) {
        case "null":
          return value === null;
        case "boolean":
          return Predicate.isBoolean(value);
        case "string":
          return Predicate.isString(value);
        case "number":
          return Predicate.isNumber(value) && Number.isFinite(value);
        case "integer":
          return Predicate.isNumber(value) && Number.isInteger(value);
        case "array":
          return isJsonArray(value);
        case "object":
          return isJsonObject(value);
        default:
          return true;
      }
    });
    if (!matchesType) {
      return [
        `${path}: expected type ${Formatter.formatJson(schemaType)}, got ${Formatter.formatJson(value)}`,
      ];
    }
  }

  if (Predicate.isString(value)) {
    if (Predicate.isString(schema["pattern"]) && !new RegExp(schema["pattern"]).test(value)) {
      return [`${path}: string ${Formatter.formatJson(value)} failed pattern ${schema["pattern"]}`];
    }
    if (Predicate.isNumber(schema["minLength"]) && value.length < schema["minLength"]) {
      return [`${path}: string shorter than minLength ${schema["minLength"]}`];
    }
    if (Predicate.isNumber(schema["maxLength"]) && value.length > schema["maxLength"]) {
      return [`${path}: string longer than maxLength ${schema["maxLength"]}`];
    }
  }

  if (Predicate.isNumber(value)) {
    if (Predicate.isNumber(schema["minimum"]) && value < schema["minimum"]) {
      return [`${path}: number ${value} < minimum ${schema["minimum"]}`];
    }
    if (Predicate.isNumber(schema["maximum"]) && value > schema["maximum"]) {
      return [`${path}: number ${value} > maximum ${schema["maximum"]}`];
    }
  }

  const errors: Array<string> = [];

  const itemSchema = schema["items"];
  if (isJsonArray(value) && isJsonObject(itemSchema)) {
    for (const [index, item] of value.entries()) {
      errors.push(...validateJsonSchema(item, itemSchema, rootDefs, `${path}[${index}]`));
    }
  }

  if (isJsonObject(value)) {
    if (isJsonArray(schema["required"])) {
      for (const req of schema["required"]) {
        if (Predicate.isString(req) && !(req in value)) {
          errors.push(`${path}: missing required key ${req}`);
        }
      }
    }
    const properties = schema["properties"];
    if (isJsonObject(properties)) {
      for (const [key, propSchema] of EffectRecord.toEntries(properties)) {
        if (key in value) {
          const property = value[key];
          if (property !== undefined) {
            errors.push(...validateJsonSchema(property, propSchema, rootDefs, `${path}.${key}`));
          }
        }
      }
      if (schema["additionalProperties"] === false) {
        for (const key of EffectRecord.keys<string, Schema.Json>(value)) {
          if (!(key in properties)) {
            errors.push(`${path}: unexpected additional property ${key}`);
          }
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
        yield* priceList.save(
          PriceListItemInput.make({
            name: "Consulting Day",
            unit: "day",
            unitPrice: BigDecimal.fromStringUnsafe("2000"),
            currency: CurrencyCode.make("CZK"),
            vat: "standard",
          }),
        );
        const id = yield* Schema.decodeUnknownEffect(ContactId)(created["id"]);
        const templates = yield* Templates;
        yield* templates.save({
          name: "Monthly Retainer",
          kind: "invoice",
          contact: id,
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
        });
        return id;
      }).pipe(Effect.provideService(CurrentCaller, ws)),
    );

    // Fetch declared outputSchemas from tools/list.
    const listed = await h.rpc(rw.token, "tools/list");
    expect(listed.res.status).toBe(200);
    const { tools } = await h.run(decodeToolList(listed.json["result"]));
    const schemaByTool = new Map(Arr.map(tools, (t) => [t.name, t.outputSchema]));

    const assertMatchesDeclaredSchema = async (
      toolName: string,
      call: Awaited<ReturnType<typeof h.callTool>>,
    ) => {
      const schema = schemaByTool.get(toolName);
      expect(schema).toBeDefined();
      if (schema === undefined) return;
      const structured = await h.run(decodeJson(call.result?.structuredContent));
      const errors = validateJsonSchema(structured, schema, schema["$defs"] ?? {});
      expect(errors).toEqual([]);
      expect(findLeakedBigDecimalPaths(structured)).toEqual([]);
    };

    const readJsonResource = async (uri: string) => {
      const res = await h.readResource(rw.token, uri);
      expect(res.error).toBeUndefined();
      const json = await h.run(decodeResourceJson(res.contents?.[0]?.["text"]));
      expect(findLeakedBigDecimalPaths(json)).toEqual([]);
      return json;
    };

    // 1. get_fx_rate: rate must be string "25.35", matching declared outputSchema.
    const fxCall = await h.callTool(rw.token, "get_fx_rate", {
      currency: "EUR",
      on: "2026-11-23",
    });
    expect(fxCall.result?.isError).toBe(false);
    expect(fxCall.result?.structuredContent?.["rate"]).toBe("25.35");
    await assertMatchesDeclaredSchema("get_fx_rate", fxCall);

    // 2. list_price_list_items tool + kvitbit://price-list resource: unitPrice must be string "2000".
    const plCall = await h.callTool(rw.token, "list_price_list_items", {});
    expect(plCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("list_price_list_items", plCall);
    const plItems = await h.run(decodePriceListItems(plCall.result?.structuredContent?.["items"]));
    expect(plItems[0]?.unitPrice).toBe("2000");

    const plResJson = await readJsonResource("kvitbit://price-list");
    const resourceItems = await h.run(decodePriceListItems(plResJson));
    expect(resourceItems[0]?.unitPrice).toBe("2000");

    // 3. list_invoice_templates tool + kvitbit://templates resource.
    const tplCall = await h.callTool(rw.token, "list_invoice_templates", {});
    expect(tplCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("list_invoice_templates", tplCall);
    await readJsonResource("kvitbit://templates");

    // 4. Foreign-currency draft + issue + get_document + list_documents + kvitbit://documents/{id}.
    const draftCall = await h.callTool(rw.token, "create_draft", {
      kind: "invoice",
      contact: contactId,
      currency: "EUR",
      paymentMethod: "bank_transfer",
      lines: [{ description: "Advisory", quantity: "2.5", unitPrice: "120.40", vat: "standard" }],
    });
    expect(draftCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("create_draft", draftCall);
    const draftDoc = await h.run(decodeDraft(draftCall.result?.structuredContent?.["document"]));
    const { id: draftId, revision: draftRev } = draftDoc;
    expect(draftDoc.fx?.rate).toBe("25.35");
    expect(Predicate.isString(draftDoc.totals.gross.amount)).toBe(true);
    expect(Predicate.isString(draftDoc.lines[0]?.unitPrice)).toBe(true);

    const issuePreview = await h.callTool(rw.token, "issue_document", {
      from: { draft: draftId, revision: draftRev },
    });
    expect(issuePreview.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("issue_document", issuePreview);
    const { confirmationToken: token } = await h.run(
      decodeConfirmation(issuePreview.result?.structuredContent),
    );

    const issueConfirm = await h.callTool(rw.token, "issue_document", {
      from: { draft: draftId, revision: draftRev },
      confirm: true,
      confirmationToken: token,
    });
    expect(issueConfirm.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("issue_document", issueConfirm);

    // Replay returns identical encoded wire output.
    const issueReplay = await h.callTool(rw.token, "issue_document", {
      from: { draft: draftId, revision: draftRev },
      confirm: true,
      confirmationToken: token,
    });
    expect(issueReplay.result).toEqual(issueConfirm.result);

    const getDocCall = await h.callTool(rw.token, "get_document", { documentId: draftId });
    expect(getDocCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("get_document", getDocCall);

    const docResJson = await readJsonResource(`kvitbit://documents/${draftId}`);
    const resourceDocument = await h.run(decodeDocumentFx(docResJson));
    expect(resourceDocument.fx?.rate).toBe("25.35");

    const listDocsCall = await h.callTool(rw.token, "list_documents", {});
    expect(listDocsCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("list_documents", listDocsCall);

    // 5. Payments + Expenses + Reports + Workspace + Contact resources.
    const payCall = await h.callTool(rw.token, "record_payment", {
      target: { document: draftId },
      paidOn: "2026-11-23",
      method: "bank_transfer",
    });
    expect(payCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("record_payment", payCall);

    const listPayCall = await h.callTool(rw.token, "list_payments", {
      target: { document: draftId },
    });
    expect(listPayCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("list_payments", listPayCall);

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
    await assertMatchesDeclaredSchema("record_expense", expCall);
    const { id: expenseId } = await h.run(
      decodeExpense(expCall.result?.structuredContent?.["expense"]),
    );
    expect(expenseId).toBeDefined();

    await readJsonResource(`kvitbit://expenses/${expenseId}`);

    const reportCall = await h.callTool(rw.token, "get_report", {
      report: "vat",
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(reportCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("get_report", reportCall);

    const wsCall = await h.callTool(rw.token, "get_workspace", {});
    expect(wsCall.result?.isError).toBe(false);
    await assertMatchesDeclaredSchema("get_workspace", wsCall);

    await readJsonResource("kvitbit://workspace");
    await readJsonResource(`kvitbit://contacts/${contactId}`);
  });

  test("enforces 300/min per MCP grant with shared trailing sliding window before body decoding", async () => {
    const h = makeMcpHarness();
    cleanup = h.dispose;

    const peer = h.createInstance();
    const owner = h.addUser("Rate Owner");
    const ws = await h.createWorkspace(owner);
    const grantA = h.addReadWriteGrant(owner, ws.workspaceId);
    const grantB = h.addReadWriteGrant(owner, ws.workspaceId);

    const admitRequests = (rpc: typeof h.rpc, firstId: number, count: number) =>
      h.run(
        Effect.forEach(
          Arr.range(firstId, firstId + count - 1),
          Effect.fnUntraced(function* (id) {
            const { res } = yield* Effect.promise(() => rpc(grantA.token, "ping", undefined, id));
            expect(res.status).toBe(200);
          }),
          { concurrency: 1, discard: true },
        ),
      );

    // 100 requests at t=0s on instance 1.
    await admitRequests(h.rpc, 1, 100);

    // Advance 40s; send 200 more requests on instance 2 (shared RateLimiterSql counter reaches 300).
    await h.run(TestClock.adjust(Duration.seconds(40)));
    await admitRequests(peer.rpc, 1000, 200);

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
    await admitRequests(h.rpc, 2000, 100);

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
