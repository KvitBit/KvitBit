/** Read methods: get, list, history, pdf. */
import type {
  DocumentId,
  DocumentQuery,
  FileDownload,
  IsoDate,
  Locale,
  PageRequest,
  PdfTemplate,
} from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import { Effect, Stream } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { canonicalJson } from "../../shared/canonicalJson";
import { orUnavailable } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { CoreStore } from "../../store/CoreStore";
import { DocumentRenderer } from "./ports";
import { DocumentsRepo } from "./repo";
import { dieOnUnavailable, now, viewOf } from "./support";
import { toSummary } from "./view";

export const get = (id: DocumentId) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.read");
    const row = yield* (yield* DocumentsRepo).get(workspaceId, id);
    return yield* viewOf(row);
  }).pipe(dieOnUnavailable);

const DEFAULT_LIMIT = 50;

const pageIssue = (path: string, code: "request.malformed" | "page.cursor_mismatch") =>
  new Invalid({ issues: [{ path: [path], code }] });

/**
 * Cursor = base64 of JSON [filter fingerprint (first 16 hex), issuedOn, id]: bound to the filter
 * it came from (`page.cursor_mismatch` otherwise).
 */
const decodeCursor = (cursor: string, fingerprint: string) => {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((p) => typeof p === "string") &&
      parsed[0] === fingerprint
    ) {
      return [parsed[1] as IsoDate, parsed[2] as DocumentId] as const;
    }
  } catch {
    // fall through
  }
  return null;
};

export const list = (q: DocumentQuery & PageRequest) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.read");
    const limit = q.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return yield* pageIssue("limit", "request.malformed");
    }
    const { cursor: _cursor, limit: _limit, ...filter } = q;
    const fingerprint = (yield* sha256Hex(canonicalJson(filter))).slice(0, 16);
    const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, fingerprint);
    if (after === null) return yield* pageIssue("cursor", "page.cursor_mismatch");
    const { today } = yield* now;
    const { rows, more } = yield* (yield* DocumentsRepo).search(
      workspaceId,
      {
        kind: filter.kind,
        status: filter.status,
        settlement: filter.settlement,
        contactId: filter.contact,
        from: filter.from,
        to: filter.to,
        overdue: filter.overdue === undefined ? undefined : { value: filter.overdue, today },
        text: filter.text,
      },
      { after, limit },
    );
    const last = rows.at(-1);
    return {
      items: rows.map((row) => toSummary(row, today)),
      nextCursor: more && last ? btoa(JSON.stringify([fingerprint, last.issuedOn, last.id])) : null,
    };
  }).pipe(dieOnUnavailable);

/** The document's audit entries in time order (drafts: create; issued: every change). */
export const history = (id: DocumentId) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.history");
    yield* (yield* DocumentsRepo).get(workspaceId, id);
    return yield* (yield* CoreStore).audit.history(workspaceId, { entity: "Document", id });
  }).pipe(dieOnUnavailable);

const filenameOf = (number: string | null, id: DocumentId) =>
  `${(number ?? `draft-${id}`).replace(/[^\p{L}\p{N}._-]+/gu, "-")}.pdf`;

/** PDF of the current revision through `DocumentRenderer`; locked documents render too (D5). */
export const pdf = (
  id: DocumentId,
  opts?: { readonly template?: PdfTemplate; readonly language?: Locale },
) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.pdf");
    const row = yield* (yield* DocumentsRepo).get(workspaceId, id);
    const view = yield* viewOf(row);
    const bytes = yield* (yield* DocumentRenderer).render(view, {
      template: opts?.template ?? "classic",
      language: opts?.language ?? row.language,
    });
    return {
      filename: filenameOf(row.number, row.id),
      contentType: "application/pdf",
      bytes: Stream.make(bytes),
    } satisfies FileDownload;
  }).pipe(orUnavailable);
