/**
 * Formats BigDecimal values in JSON-encoded open fields while leaving closed money and FX fields
 * for the document response schema's codecs.
 */
import {
  type AuditEntry,
  DocumentSummary,
  type DocumentView,
  LineView,
  type Page,
  type SharedDocumentView,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import { documentJsonValue } from "../records/json";

const jsonizeLine = (line: LineView): LineView => LineView.make(documentJsonValue(line));

export const jsonizeDocumentView = (view: DocumentView): DocumentView => ({
  ...view,
  lines: Arr.map(view.lines, jsonizeLine),
});

export const jsonizeSharedDocumentView = (view: SharedDocumentView): SharedDocumentView => ({
  ...view,
  lines: Arr.map(view.lines, jsonizeLine),
});

export const jsonizeDocumentPage = (page: Page<DocumentSummary>): Page<DocumentSummary> => ({
  ...page,
  items: Arr.map(page.items, (item) => DocumentSummary.make(documentJsonValue(item))),
});

export const jsonizeAuditEntries = (
  entries: ReadonlyArray<AuditEntry>,
): ReadonlyArray<AuditEntry> =>
  Arr.map(entries, (entry) =>
    entry.changes === undefined
      ? entry
      : {
          ...entry,
          changes: Arr.map(entry.changes, (change) => ({
            ...change,
            before: documentJsonValue(change.before),
            after: documentJsonValue(change.after),
          })),
        },
  );
