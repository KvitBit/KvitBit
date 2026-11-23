import { describe, expect, test } from "bun:test";
import {
  AttachmentId,
  DocumentId,
  ExpenseId,
  Invalid,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Context, Effect, Option, Schema } from "effect";
import {
  HttpApi,
  HttpApiClient,
  type HttpApiEndpoint,
  HttpApiError,
  HttpApiMiddleware,
  OpenApi,
} from "effect/http-api";
import {
  Api,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  BRANDING_IMAGE_MAX_BYTES,
  BRANDING_IMAGE_TYPES,
  SchemaErrors,
  schemaErrorToInvalid,
} from "../src/index";

const WS = Schema.decodeSync(WorkspaceId)("01890a5d-ac96-774b-bcce-b302099a8057");
const DOC = Schema.decodeSync(DocumentId)("01890a5d-ac96-774b-bcce-b302099a8058");
const EXP = Schema.decodeSync(ExpenseId)("01890a5d-ac96-774b-bcce-b302099a8059");
const ATT = Schema.decodeSync(AttachmentId)("01890a5d-ac96-774b-bcce-b302099a805a");

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
  [...endpoint.success].flatMap((schema) =>
    "contentTypes" in schema && Array.isArray(schema.contentTypes)
      ? schema.contentTypes.map(String)
      : [],
  );

const multipartLimits = (endpoint: AnyEndpoint): unknown =>
  endpoint.payload.get("multipart/form-data")?.encoding;

describe("binary bodies and uploads (section 3.4)", () => {
  const g = Api.groups;

  test("streamed successes declare their content types", () => {
    expect(streamContentTypes(g.documents.endpoints.pdf)).toEqual(["application/pdf"]);
    expect(streamContentTypes(g.publicShare.endpoints.pdf)).toEqual(["application/pdf"]);
    expect(streamContentTypes(g.branding.endpoints.previewPdf)).toEqual(["application/pdf"]);
    expect(streamContentTypes(g.publicShare.endpoints.logo)).toEqual([...BRANDING_IMAGE_TYPES]);
    expect(streamContentTypes(g.branding.endpoints.getImage)).toEqual([...BRANDING_IMAGE_TYPES]);
    expect(streamContentTypes(g.expenses.endpoints.attachment)).toEqual([...ATTACHMENT_TYPES]);
    expect(streamContentTypes(g.reports.endpoints.export)).toEqual([
      "text/csv; charset=utf-8",
      "application/pdf",
    ]);
    expect(streamContentTypes(g.reports.endpoints.exportFile)).toEqual(["application/zip"]);
  });

  test("uploads are streamed multipart with one part and the size limit", () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(BRANDING_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(multipartLimits(g.expenses.endpoints.attach)).toMatchObject({
      _tag: "Multipart",
      mode: "stream",
      limits: { maxParts: 1, maxFileSize: ATTACHMENT_MAX_BYTES },
    });
    expect(multipartLimits(g.branding.endpoints.putImage)).toMatchObject({
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
      onGroup: () => {},
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

  const asCodec = (schema: Schema.Top) => schema as Schema.Top as Schema.Codec<unknown, unknown>;

  test("payload and query reject excess properties; headers and responses keep defaults", () => {
    const options = optionsOf("contacts", "create");
    expect(Option.getOrUndefined(options.payload)).toEqual({ onExcessProperty: "error" });
    expect(Option.getOrUndefined(options.query)).toEqual({ onExcessProperty: "error" });
    expect(Option.isNone(options.headers)).toBe(true);
    expect(Option.isNone(options.success)).toBe(true);
    expect(Option.isNone(options.all)).toBe(true);
  });

  test("an unknown payload field is rejected", () => {
    const endpoint = Api.groups.documents.endpoints.unlock;
    const options = Option.getOrThrow(optionsOf("documents", "unlock").payload);
    const [schema] = endpoint.payload.get("application/json")?.schemas ?? [];
    if (schema === undefined) throw new Error("no JSON payload");
    const decode = Schema.decodeUnknownSync(asCodec(schema), options);
    expect(decode({ reason: "typo" })).toEqual({ reason: "typo" });
    expect(() => decode({ reason: "typo", extra: 1 })).toThrow();
  });

  test("an unknown query field is rejected", () => {
    const endpoint = Api.groups.expenses.endpoints.list;
    const options = Option.getOrThrow(optionsOf("expenses", "list").query);
    if (endpoint.query === undefined) throw new Error("no query");
    const decode = Schema.decodeUnknownSync(asCodec(endpoint.query), options);
    expect(decode({ incomplete: "true" })).toEqual({ incomplete: true });
    expect(() => decode({ incomplete: "true", supplier: "x" })).toThrow();
  });
});

describe("SchemaErrors middleware", () => {
  const schemaError = (kind: HttpApiError.HttpApiSchemaError["kind"]) => {
    const cause = Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(Schema.String)(42)));
    return new HttpApiError.HttpApiSchemaError({ kind, cause });
  };
  const run = (kind: HttpApiError.HttpApiSchemaError["kind"]) =>
    Effect.runSync(Effect.flip(schemaErrorToInvalid(schemaError(kind))));

  test("request decode failures become Invalid request.malformed (422)", () => {
    for (const kind of ["Params", "Query", "Headers", "Payload"] as const) {
      const error = run(kind);
      expect(error).toBeInstanceOf(Invalid);
      expect(error).toMatchObject({
        issues: [{ path: [kind.toLowerCase()], code: "request.malformed" }],
      });
    }
  });

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

describe("OpenAPI (section 3.7)", () => {
  const spec = OpenApi.fromApi(Api);
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item as Record<string, { operationId?: string; summary?: string }>).map(
      ([method, op]) => ({ path, method, operationId: op.operationId, summary: op.summary }),
    ),
  );

  test("every endpoint is an operation with an English summary", () => {
    expect(operations.length).toBe(104);
    for (const op of operations) {
      expect([op.operationId, typeof op.summary === "string" && op.summary.length > 0]).toEqual([
        op.operationId,
        true,
      ]);
      expect(op.summary ?? "").toMatch(/^[A-Z][\w ’'Č-]+$/);
    }
  });

  test("operationId is <group>.<endpoint>", () => {
    const expected: Array<string> = [];
    HttpApi.reflect(Api, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) => {
        expected.push(`${group.identifier}.${endpoint.identifier}`);
      },
    });
    expect(operations.map((op) => op.operationId).sort()).toEqual(expected.sort());
  });
});
