import { describe, expect, test } from "bun:test";
import {
  AttachmentId,
  DocumentId,
  ExpenseId,
  Invalid,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  Api,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  BRANDING_IMAGE_MAX_BYTES,
  BRANDING_IMAGE_TYPES,
  SchemaErrors,
  schemaErrorToInvalid,
} from "../src/index";
import { decodeReflectedSchema } from "./reflected-http-schema";

const WS = Schema.decodeEffect(WorkspaceId)("01890a5d-ac96-774b-bcce-b302099a8057").pipe(
  Effect.runSync,
);
const DOC = Schema.decodeEffect(DocumentId)("01890a5d-ac96-774b-bcce-b302099a8058").pipe(
  Effect.runSync,
);
const EXP = Schema.decodeEffect(ExpenseId)("01890a5d-ac96-774b-bcce-b302099a8059").pipe(
  Effect.runSync,
);
const ATT = Schema.decodeEffect(AttachmentId)("01890a5d-ac96-774b-bcce-b302099a805a").pipe(
  Effect.runSync,
);

describe("HttpApiClient URL builder fills nested Workspace routes", () => {
  const url = HttpApiClient.urlBuilder(Api);

  test("documents.get", () => {
    expect(url.documents.get({ params: { workspaceId: WS, documentId: DOC } })).toBe(
      `/api/v1/workspaces/${WS}/documents/${DOC}`,
    );
  });

  test("expenses.attachment", () => {
    expect(
      url.expenses.attachment({
        params: { workspaceId: WS, expenseId: EXP, attachmentId: ATT },
        query: { disposition: "inline" },
      }),
    ).toBe(`/api/v1/workspaces/${WS}/expenses/${EXP}/attachments/${ATT}?disposition=inline`);
  });

  test("shareLinks.views", () => {
    expect(url.shareLinks.views({ params: { workspaceId: WS, documentId: DOC }, query: {} })).toBe(
      `/api/v1/workspaces/${WS}/documents/${DOC}/share-link/views`,
    );
  });

  test("payments.listForExpense (group prefix is the bare Workspace path)", () => {
    expect(url.payments.listForExpense({ params: { workspaceId: WS, expenseId: EXP } })).toBe(
      `/api/v1/workspaces/${WS}/expenses/${EXP}/payments`,
    );
  });
});

type AnyEndpoint = HttpApiEndpoint.Top;

const streamContentTypes = (endpoint: AnyEndpoint): ReadonlyArray<string> =>
  Arr.flatMap([...endpoint.success], (schema) =>
    "contentTypes" in schema && Arr.isArray(schema.contentTypes)
      ? Arr.map(schema.contentTypes, String)
      : [],
  );

const multipartLimits = (endpoint: AnyEndpoint): unknown =>
  endpoint.payload.get("multipart/form-data")?.encoding;

describe("binary bodies and uploads (section 3.4)", () => {
  const g = Api.groups;

  test("streamed successes declare their content types", () => {
    expect(g.documents.endpoints.pdf.pipe(streamContentTypes)).toEqual(["application/pdf"]);
    expect(g.publicShare.endpoints.pdf.pipe(streamContentTypes)).toEqual(["application/pdf"]);
    expect(g.branding.endpoints.previewPdf.pipe(streamContentTypes)).toEqual(["application/pdf"]);
    expect(g.publicShare.endpoints.logo.pipe(streamContentTypes)).toEqual([
      ...BRANDING_IMAGE_TYPES,
    ]);
    expect(g.branding.endpoints.getImage.pipe(streamContentTypes)).toEqual([
      ...BRANDING_IMAGE_TYPES,
    ]);
    expect(g.expenses.endpoints.attachment.pipe(streamContentTypes)).toEqual([...ATTACHMENT_TYPES]);
    expect(g.reports.endpoints.export.pipe(streamContentTypes)).toEqual([
      "text/csv; charset=utf-8",
      "application/pdf",
    ]);
    expect(g.reports.endpoints.exportFile.pipe(streamContentTypes)).toEqual(["application/zip"]);
  });

  test("uploads are streamed multipart with one part and the size limit", () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(BRANDING_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(g.expenses.endpoints.attach.pipe(multipartLimits)).toMatchObject({
      _tag: "Multipart",
      mode: "stream",
      limits: { maxParts: 1, maxFileSize: ATTACHMENT_MAX_BYTES },
    });
    expect(g.branding.endpoints.putImage.pipe(multipartLimits)).toMatchObject({
      _tag: "Multipart",
      mode: "stream",
      limits: { maxParts: 1, maxFileSize: BRANDING_IMAGE_MAX_BYTES },
    });
  });
});

describe("strict request parsing (section 3.2)", () => {
  const optionsOf = (group: string, name: string) => {
    let found: Context.Context<never> | undefined;
    HttpApi.reflect(Api, {
      onGroup: Fn.constVoid,
      onEndpoint: ({ group: g, endpoint, mergedAnnotations }) => {
        if (g.identifier === group && endpoint.identifier === name) found = mergedAnnotations;
      },
    });
    if (found === undefined) throw new Error(`missing ${group}.${name}`);
    const annotations = found;
    return {
      payload: Context.getOption(annotations, HttpApi.PayloadParseOptions),
      query: Context.getOption(annotations, HttpApi.QueryParseOptions),
      headers: Context.getOption(annotations, HttpApi.HeadersParseOptions),
      success: Context.getOption(annotations, HttpApi.SuccessParseOptions),
      all: Context.getOption(annotations, HttpApi.ParseOptions),
    };
  };

  test("payload and query reject excess properties; headers and responses keep defaults", () => {
    const options = optionsOf("contacts", "create");
    expect(options.payload.pipe(Option.getOrUndefined)).toEqual({ onExcessProperty: "error" });
    expect(options.query.pipe(Option.getOrUndefined)).toEqual({ onExcessProperty: "error" });
    expect(Option.isNone(options.headers)).toBe(true);
    expect(Option.isNone(options.success)).toBe(true);
    expect(Option.isNone(options.all)).toBe(true);
  });

  test("an unknown payload field is rejected", () => {
    const endpoint = Api.groups.documents.endpoints.unlock;
    const options = Option.getOrThrow(optionsOf("documents", "unlock").payload);
    const [schema] = endpoint.payload.get("application/json")?.schemas ?? [];
    if (schema === undefined) throw new Error("no JSON payload");
    const decode = Fn.flow(decodeReflectedSchema(schema), Effect.runSync);
    expect(decode({ reason: "typo" }, options)).toEqual({ reason: "typo" });
    expect(() => decode({ reason: "typo", extra: 1 }, options)).toThrow();
  });

  test("an unknown query field is rejected", () => {
    const endpoint = Api.groups.expenses.endpoints.list;
    const options = Option.getOrThrow(optionsOf("expenses", "list").query);
    if (endpoint.query === undefined) throw new Error("no query");
    const decode = Fn.flow(decodeReflectedSchema(endpoint.query), Effect.runSync);
    expect(decode({ incomplete: "true" }, options)).toEqual({ incomplete: true });
    expect(() => decode({ incomplete: "true", supplier: "x" }, options)).toThrow();
  });
});

describe("SchemaErrors middleware", () => {
  const schemaError = (kind: HttpApiError.HttpApiSchemaError["kind"]) => {
    const cause = Schema.decodeUnknownEffect(Schema.String)(42).pipe(Effect.flip, Effect.runSync);
    return new HttpApiError.HttpApiSchemaError({ kind, cause });
  };
  const run = (kind: HttpApiError.HttpApiSchemaError["kind"]) =>
    schemaError(kind).pipe(schemaErrorToInvalid, Effect.flip, Effect.runSync);

  test("a root-level request decode failure keeps the slot as its path", () => {
    for (const kind of ["Params", "Query", "Headers", "Payload"] as const) {
      const error = run(kind);
      expect(error).toBeInstanceOf(Invalid);
      expect(error).toMatchObject({
        issues: [{ path: [Str.toLowerCase(kind)], code: "request.malformed" }],
      });
    }
  });

  const decodeFailure = (
    kind: HttpApiError.HttpApiSchemaError["kind"],
    schema: Schema.Top,
    input: unknown,
  ) => {
    const cause = decodeReflectedSchema(schema)(input, { errors: "all" }).pipe(
      Effect.asVoid,
      Effect.flip,
      Effect.runSync,
    );
    return new HttpApiError.HttpApiSchemaError({ kind, cause }).pipe(
      schemaErrorToInvalid,
      Effect.flip,
      Effect.runSync,
    );
  };

  test("a nested payload failure reports the field name and array index", () => {
    const [schema] =
      Api.groups.documents.endpoints.send.payload.get("application/json")?.schemas ?? [];
    if (schema === undefined) throw new Error("no JSON payload");
    expect(decodeFailure("Payload", schema, { to: ["a@b.cz", 42] })).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["to", 1], code: "request.malformed" }],
    });
  });

  test("every failing field is reported; query paths start with the slot", () => {
    const query = Api.groups.documents.endpoints.list.query;
    if (query === undefined) throw new Error("no query");
    const error = decodeFailure("Query", query, { limit: "0", overdue: "maybe" });
    expect(error).toBeInstanceOf(Invalid);
    const paths = Schema.is(Invalid)(error) ? Arr.map(error.issues, (issue) => issue.path) : [];
    expect(paths).toContainEqual(["query", "limit"]);
    expect(paths).toContainEqual(["query", "overdue"]);
  });

  // biome-ignore lint/security/noSecrets: The test title names an Effect error type.
  test("response encoding failures pass through as HttpApiSchemaError", () => {
    for (const kind of ["Body", "ResponseHeaders"] as const) {
      const error = run(kind);
      expect(HttpApiError.HttpApiSchemaError.is(error)).toBe(true);
      expect(error).toMatchObject({ kind });
    }
  });

  test("the transform fits layerSchemaErrorTransform for the SchemaErrors tag", () => {
    expect(
      HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, schemaErrorToInvalid),
    ).toBeDefined();
  });
});

const ENGLISH_SUMMARY = /^[A-Z][\w ’'Č-]+$/;

describe("OpenAPI (section 3.7)", () => {
  const spec = OpenApi.fromApi(Api);
  const operations = Arr.flatMap(Record.toEntries(spec.paths), ([path, item]) =>
    Arr.map(Record.toEntries<string, unknown>(item), ([method, op]) => {
      const operation = Predicate.isObject(op) ? op : {};
      return { path, method, operationId: operation.operationId, summary: operation.summary };
    }),
  );

  test("every endpoint is an operation with an English summary", () => {
    expect(operations.length).toBe(104);
    for (const op of operations) {
      expect([op.operationId, typeof op.summary === "string" && op.summary.length > 0]).toEqual([
        op.operationId,
        true,
      ]);
      expect(typeof op.summary === "string" ? op.summary : "").toMatch(ENGLISH_SUMMARY);
    }
  });

  test("operationId is <group>.<endpoint>", () => {
    const expected: Array<string> = [];
    HttpApi.reflect(Api, {
      onGroup: Fn.constVoid,
      onEndpoint: ({ group, endpoint }) => {
        expected.push(`${group.identifier}.${endpoint.identifier}`);
      },
    });
    const operationIds = Arr.map(operations, (op) =>
      typeof op.operationId === "string" ? op.operationId : "",
    );
    expect(Arr.sort(operationIds, Order.String)).toEqual(Arr.sort(expected, Order.String));
  });
});
