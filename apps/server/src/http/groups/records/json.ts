/**
 * Converts core views behind open/unknown contract schemas (`PriceListItemView`, `PaymentView`,
 * `TemplateView`, `ReportView`) into JSON-safe values before `HttpApiBuilder` encodes them with
 * `Schema.toCodecJson`. Core returns `BigDecimal` instances inside open fields where the wire
 * contract expects decimal strings (http-mcp-contracts section 3.2).
 */
import { BigDecimal } from "effect";

const toJsonValue = (value: unknown): unknown => {
  if (BigDecimal.isBigDecimal(value)) {
    return BigDecimal.format(value);
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined) {
        out[key] = toJsonValue(val);
      }
    }
    return out;
  }
  return value;
};

/** Recursively formats `BigDecimal` values and drops `undefined` keys in open view objects. */
export const jsonSafe = <T>(value: T): T => toJsonValue(value) as T;
