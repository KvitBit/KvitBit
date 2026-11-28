import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Conflict, CoreError, Forbidden, Invalid, NotFound, Unavailable } from "../src/index";

const json = Schema.toCodecJson(CoreError);
const roundTrip = (e: CoreError) =>
  e.pipe(Schema.encodeEffect(json), Effect.flatMap(Schema.decodeEffect(json)), Effect.runSync);

const samples: ReadonlyArray<CoreError> = [
  NotFound.make({ entity: "Document", id: "doc-1" }),
  Forbidden.make({ action: "document.unlock" }),
  Invalid.make({
    issues: [
      {
        path: ["lines", 0, "vat"],
        code: "vat.not_allowed_for_regime",
        params: { regime: "non_vat_payer" },
      },
    ],
  }),
  Conflict.make({ reason: "revision_changed", currentRevision: 7 }),
  Conflict.make({ reason: "illegal_transition", detail: "member.owner_cannot_leave" }),
  Unavailable.make({ dependency: "company_registry", retryAfterSeconds: 30 }),
];

describe("error codecs", () => {
  test.each(Arr.map(samples, (error) => [error._tag, error] as const))(
    "%s round-trips through JSON",
    (_, e) => {
      const back = roundTrip(e);
      expect(back).toBeInstanceOf(e.constructor);
      expect(back).toEqual(e);
    },
  );

  test("encoded form carries _tag and fields only", () => {
    expect(
      NotFound.make({ entity: "Contact", id: "c" }).pipe(Schema.encodeEffect(json), Effect.runSync),
    ).toEqual({
      _tag: "NotFound",
      entity: "Contact",
      id: "c",
    });
  });

  test.each([
    [
      "a non-finite revision",
      { _tag: "Conflict", reason: "revision_changed", currentRevision: "Infinity" },
    ],
    [
      "a fractional revision",
      { _tag: "Conflict", reason: "revision_changed", currentRevision: 1.5 },
    ],
    [
      "a non-finite retry delay",
      { _tag: "Unavailable", dependency: "database", retryAfterSeconds: "NaN" },
    ],
  ])("rejects %s", (_, input) => {
    expect(Schema.decodeExit(json)(input).pipe(Exit.isFailure)).toBe(true);
  });

  test("errors are yieldable Error instances", () => {
    expect(Forbidden.make({ action: "workspace.close" })).toBeInstanceOf(Error);
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
    expect(Schema.decodeExit(json)(input).pipe(Exit.isFailure)).toBe(true);
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
