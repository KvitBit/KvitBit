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
import type { DocumentView } from "@kvitbit/domain/contract";
import { BigDecimal, Schema } from "effect";

const TOOL_OUTPUT_ENCODERS = new Map<McpToolName, (value: unknown) => unknown>(
  MCP_TOOLS.map((def) => [
    def.name,
    Schema.encodeUnknownSync(
      Schema.toCodecJson(def.output) as unknown as Schema.Encoder<unknown, never>,
    ),
  ]),
);

/**
 * Recursively converts nested `BigDecimal` values inside open / `Schema.Unknown` fields into
 * normalized decimal strings (matching `Schema.toCodecJson(Schema.BigDecimal)`) and drops
 * `undefined` object keys.
 */
export const jsonizeOpenValue = <T>(value: T): T => {
  const walk = (input: unknown): unknown => {
    if (BigDecimal.isBigDecimal(input)) {
      return BigDecimal.format(BigDecimal.normalize(input));
    }
    if (input instanceof Date) {
      return input.toISOString();
    }
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input)) {
        if (entry !== undefined) {
          out[key] = walk(entry);
        }
      }
      return out;
    }
    return input;
  };
  return walk(value) as T;
};

/**
 * Prepares a `DocumentView` for `Schema.toCodecJson(DocumentView)`: normalizes decimals inside
 * its `Schema.Unknown`-branded fields (`lines`, `contact`, `issuer`) while keeping typed
 * `BigDecimal` fields (`totals`, `fx`) intact for the schema's wire codec.
 */
export const prepareDocumentView = (doc: DocumentView): DocumentView => ({
  ...doc,
  contact: jsonizeOpenValue(doc.contact),
  issuer: jsonizeOpenValue(doc.issuer),
  lines: doc.lines.map((line) => jsonizeOpenValue(line)),
});

/** Encodes a tool's `structuredContent` with the exact wire codec of its declared output schema. */
export const encodeToolOutput = (name: McpToolName, value: unknown): Record<string, unknown> => {
  const encode = TOOL_OUTPUT_ENCODERS.get(name);
  if (encode === undefined) {
    throw new Error(`Missing output encoder for MCP tool: ${name}`);
  }
  return encode(value) as Record<string, unknown>;
};

/** Creates a wire-codec JSON encoder for an MCP resource schema. */
export const makeResourceEncoder = <S extends Schema.Encoder<unknown, never>>(schema: S) =>
  Schema.encodeUnknownSync(Schema.toCodecJson(schema));
