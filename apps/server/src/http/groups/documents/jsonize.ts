/**
 * Normalizes `BigDecimal` values inside `Schema.Unknown`-branded domain views (`LineView`,
 * `DocumentSummary`, `AuditEntry.changes`) into decimal strings matching `Schema.BigDecimal`'s
 * JSON codec, so `HttpApiBuilder`'s `Schema.toCodecJson` response encoder accepts them while
 * leaving real schema fields (`totals`, `fx`, `amountDue`) as `BigDecimal` instances.
 */
import type {
  AuditEntry,
  DocumentSummary,
  DocumentView,
  LineView,
  Page,
  SharedDocumentView,
} from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";

const toJsonValue = (value: unknown): unknown => {
  if (BigDecimal.isBigDecimal(value)) return BigDecimal.format(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJsonValue(v);
    }
    return out;
  }
  return value;
};

export const jsonizeDocumentView = (view: DocumentView): DocumentView => ({
  ...view,
  lines: view.lines.map((line) => toJsonValue(line) as LineView),
});

export const jsonizeSharedDocumentView = (view: SharedDocumentView): SharedDocumentView => ({
  ...view,
  lines: view.lines.map((line) => toJsonValue(line) as LineView),
});

export const jsonizeDocumentPage = (page: Page<DocumentSummary>): Page<DocumentSummary> => ({
  ...page,
  items: page.items.map((item) => toJsonValue(item) as DocumentSummary),
});

export const jsonizeAuditEntries = (
  entries: ReadonlyArray<AuditEntry>,
): ReadonlyArray<AuditEntry> =>
  entries.map((entry) =>
    entry.changes === undefined
      ? entry
      : { ...entry, changes: toJsonValue(entry.changes) as AuditEntry["changes"] },
  );
