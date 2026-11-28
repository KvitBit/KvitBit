/**
 * Decoding of the open parts of module inputs. The domain schemas leave Contact particulars and
 * Price List Item fields open (`OpenStruct`, `Schema.Unknown`), so apps/server cannot decode
 * them; the module does, and a decode failure is `Invalid{request.malformed}` at the failing
 * path, the same shape apps/server gives for its own decode failures (http-mcp-contracts 437).
 */

import type { Issue } from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as EffectString from "effect/String";

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();
const encodePath = Schema.encodeOption(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
);
const DIACRITICS = /\p{Diacritic}/gu;

const pathSegment = <A>(segment: A): string | number => {
  const key = Predicate.isObject(segment) && "key" in segment ? segment["key"] : segment;
  return Predicate.isNumber(key) ? key : String(key);
};

/** `Invalid{request.malformed}` issues for a schema failure, one per failing path. */
const malformedIssues = (issue: SchemaIssue.Issue): readonly [Issue, ...Array<Issue>] => {
  // One issue per failing path (a union reports each member's failure at the same path).
  const byPath = new Map<string, Issue>();
  for (const failure of formatter(issue).issues) {
    const path = EffectArray.map(failure.path ?? [], pathSegment);
    byPath.set(Option.getOrThrow(encodePath(path)), { path, code: "request.malformed" });
  }
  const issues = [...byPath.values()];
  const [first, ...rest] = issues;
  return first === undefined ? [{ path: [], code: "request.malformed" }] : [first, ...rest];
};

/**
 * Decodes `input` with `schema`, rejecting unknown fields (http-mcp-contracts 364); failures
 * become `Invalid{request.malformed}`.
 */
export const decodeInput: {
  <A>(input: Schema.Unknown["Type"]): (schema: Schema.Decoder<A>) => Effect.Effect<A, Invalid>;
  <A>(schema: Schema.Decoder<A>, input: Schema.Unknown["Type"]): Effect.Effect<A, Invalid>;
} = Fn.dual(
  2,
  <A>(schema: Schema.Decoder<A>, input: Schema.Unknown["Type"]): Effect.Effect<A, Invalid> =>
    Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError((error) => Invalid.make({ issues: malformedIssues(error.issue) })),
    ),
);

/** `Invalid` with one issue. */
export const invalidAt: {
  (code: Issue["code"]): (path: ReadonlyArray<string | number>) => Invalid;
  (path: ReadonlyArray<string | number>, code: Issue["code"]): Invalid;
} = Fn.dual(
  2,
  (path: ReadonlyArray<string | number>, code: Issue["code"]): Invalid =>
    Invalid.make({ issues: [{ path: [...path], code }] }),
);

/** Case- and diacritics-insensitive form used by text filters. */
export const foldText = (text: string): string =>
  EffectString.trim(
    EffectString.toLowerCase(
      EffectString.replace(DIACRITICS, "")(EffectString.normalize("NFD")(text)),
    ),
  );
