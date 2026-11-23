import { describe, expect, test } from "bun:test";
import { Exit, Schema } from "effect";
import { Conflict, CoreError, Forbidden, Invalid, NotFound, Unavailable } from "../src/index";

const json = Schema.toCodecJson(CoreError);
const roundTrip = (e: CoreError) => Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(e));

const samples: ReadonlyArray<CoreError> = [
  new NotFound({ entity: "Document", id: "doc-1" }),
  new Forbidden({ action: "document.unlock" }),
  new Invalid({
    issues: [
      {
        path: ["lines", 0, "vat"],
        code: "vat.not_allowed_for_regime",
        params: { regime: "non_vat_payer" },
      },
    ],
  }),
  new Conflict({ reason: "revision_changed", currentRevision: 7 }),
  new Conflict({ reason: "illegal_transition", detail: "member.owner_cannot_leave" }),
  new Unavailable({ dependency: "company_registry", retryAfterSeconds: 30 }),
];

describe("error codecs", () => {
  test.each(samples.map((e) => [e._tag, e] as const))("%s round-trips through JSON", (_, e) => {
    const back = roundTrip(e);
    expect(back).toBeInstanceOf(e.constructor);
    expect(back).toEqual(e);
  });

  test("encoded form carries _tag and fields only", () => {
    expect(Schema.encodeSync(json)(new NotFound({ entity: "Contact", id: "c" }))).toEqual({
      _tag: "NotFound",
      entity: "Contact",
      id: "c",
    });
  });

  test("errors are yieldable Error instances", () => {
    expect(new Forbidden({ action: "workspace.close" })).toBeInstanceOf(Error);
  });

  test.each([
    ["empty issues", { _tag: "Invalid", issues: [] }],
    ["unknown issue code", { _tag: "Invalid", issues: [{ path: [], code: "nope.nope" }] }],
    ["unknown conflict reason", { _tag: "Conflict", reason: "stale" }],
    ["unknown action", { _tag: "Forbidden", action: "document.delete" }],
    ["unknown entity", { _tag: "NotFound", entity: "Invoice", id: "x" }],
    ["unknown dependency", { _tag: "Unavailable", dependency: "smtp" }],
    ["unknown tag", { _tag: "Teapot" }],
  ])("rejects %s", (_, input) => {
    expect(Exit.isFailure(Schema.decodeUnknownExit(json)(input))).toBe(true);
  });
});

describe("HTTP status annotations", () => {
  test.each([
    [NotFound.schema, 404],
    [Forbidden.schema, 403],
    [Invalid.schema, 422],
    [Conflict.schema, 409],
    [Unavailable.schema, 503],
  ] as const)("%#", (schema, status) => {
    expect(schema.ast.context?.annotations?.httpApiStatus).toBe(status);
  });
});
