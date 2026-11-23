/**
 * Decoding of the open parts of module inputs. The domain schemas leave Contact particulars and
 * Price List Item fields open (`OpenStruct`, `Schema.Unknown`), so apps/server cannot decode
 * them; the module does, and a decode failure is `Invalid{request.malformed}` at the failing
 * path, the same shape apps/server gives for its own decode failures (http-mcp-contracts 437).
 */
import type { Issue } from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import { Effect, Schema, SchemaIssue } from "effect";

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

const pathSegment = (segment: unknown): string | number => {
  const key =
    typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment;
  return typeof key === "number" ? key : String(key);
};

/** `Invalid{request.malformed}` issues for a schema failure, one per failing path. */
export const malformedIssues = (issue: SchemaIssue.Issue): readonly [Issue, ...Array<Issue>] => {
  const issues = formatter(issue).issues.map(
    (failure): Issue => ({
      path: (failure.path ?? []).map(pathSegment),
      code: "request.malformed",
    }),
  );
  const [first, ...rest] = issues;
  return first === undefined ? [{ path: [], code: "request.malformed" }] : [first, ...rest];
};

/** Decodes `input` with `schema`; failures become `Invalid{request.malformed}`. */
export const decodeInput = <A>(
  schema: Schema.Decoder<A>,
  input: unknown,
): Effect.Effect<A, Invalid> =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "ignore" }).pipe(
    Effect.mapError((error) => new Invalid({ issues: malformedIssues(error.issue) })),
  );

/** `Invalid` with one issue. */
export const invalidAt = (path: ReadonlyArray<string | number>, code: Issue["code"]): Invalid =>
  new Invalid({ issues: [{ path: [...path], code }] });

/** Case- and diacritics-insensitive form used by text filters. */
export const foldText = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
