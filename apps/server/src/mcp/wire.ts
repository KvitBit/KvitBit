/**
 * Wire-codec encoding for MCP tool outputs and JSON resources (http-mcp-contracts §6.5, §6.7).
 *
 * Every tool output is encoded with `Schema.toCodecJson(def.output)` so `structuredContent`
 * matches the JSON Schema advertised by `tools/list`. Open / `Schema.Unknown`-branded domain
 * fields (such as `DocumentView.lines`, `PriceListItemView`, `PaymentView`, `TemplateView`,
 * `ReportView`) can carry nested `BigDecimal` instances that `Schema.toCodecJson` rejects on
 * `Unknown`; `jsonizeOpenValue` converts those nested decimals into normalized decimal strings
 * matching `Schema.BigDecimal`'s JSON codec before schema encoding runs.
 */
import { MCP_TOOLS, type McpToolName } from "@kvitbit/api-contract";
import {
  ContactSnapshot,
  type DocumentView,
  IssuerSnapshot,
  LineView,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

const TOOL_OUTPUT_ENCODERS = new Map(
  Arr.map(MCP_TOOLS, (tool) => {
    // The contract registry erases service requirements. All its output schemas encode without services.
    const codec = Schema.make<Schema.Codec<Schema.Unknown["Type"], Schema.Json>>(
      Schema.toCodecJson(tool.output).ast,
    );
    return [tool.name, Schema.encodeEffect(codec)] as const;
  }),
);

/** Normalizes decimals in open domain fields before schema encoding. */
export const jsonizeOpenValue = <A>(value: A): Schema.Unknown["Type"] => {
  if (BigDecimal.isBigDecimal(value)) {
    return Fn.pipe(value, BigDecimal.normalize, BigDecimal.format);
  }
  if (Predicate.isDate(value)) {
    return value.toISOString();
  }
  if (Arr.isArray(value)) {
    return Arr.map(value, jsonizeOpenValue);
  }
  if (Predicate.isObject(value)) {
    return Rec.fromEntries(
      Arr.flatMap(Rec.toEntries(value), ([key, entry]) =>
        entry === undefined ? [] : [[key, jsonizeOpenValue(entry)] as const],
      ),
    );
  }
  return value;
};

/** Keeps typed decimal fields intact for the JSON codec. */
export const prepareDocumentView = (doc: DocumentView): DocumentView => ({
  ...doc,
  contact: ContactSnapshot.make(jsonizeOpenValue(doc.contact)),
  issuer: IssuerSnapshot.make(jsonizeOpenValue(doc.issuer)),
  lines: Arr.map(doc.lines, (line) => LineView.make(jsonizeOpenValue(line))),
});

/** Encodes structured content with the tool's advertised wire codec. */
export const encodeToolOutput = Effect.fn("encodeToolOutput")(function* <A>(
  name: McpToolName,
  value: A,
) {
  const encode = TOOL_OUTPUT_ENCODERS.get(name);
  if (encode === undefined) {
    return yield* Effect.die(new Error(`Missing output encoder for MCP tool: ${name}`));
  }
  const json = yield* encode(value).pipe(Effect.orDie);
  return yield* Schema.decodeUnknownEffect(Schema.JsonObject)(json).pipe(Effect.orDie);
});

/** Creates a wire-codec JSON encoder for an MCP resource schema. */
export const makeResourceEncoder =
  <S extends Schema.Encoder<Schema.Unknown["Type"]>>(schema: S) =>
  <A>(value: A) =>
    Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(value).pipe(Effect.orDie);
