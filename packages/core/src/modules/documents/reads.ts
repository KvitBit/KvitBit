/** Read methods: get, list, history, pdf. */

import type {
  Caller,
  DocumentQuery,
  FileDownload,
  Locale,
  PageRequest,
  PdfTemplate,
} from "@kvitbit/domain/contract";
import { DocumentId, Invalid, IsoDate } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import { authorizeInWorkspace } from "../../policy/Policy";
import { canonicalJson } from "../../shared/canonicalJson";
import { orUnavailable } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { CoreStore } from "../../store/CoreStore";
import { DocumentRenderer } from "./ports";
import { DocumentsRepo } from "./repo";
import { now, viewOf } from "./support";
import { toSummary } from "./view";

export const get = Effect.fn("get")(
  function* (caller: Caller, id: DocumentId) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.read");
    const row = yield* (yield* DocumentsRepo).get(workspaceId, id);
    return yield* viewOf(row);
  },
  (_) => orUnavailable(_),
);

const DEFAULT_LIMIT = 50;

const pageIssue = (path: string, code: "request.malformed" | "page.cursor_mismatch") =>
  Invalid.make({ issues: [{ path: [path], code }] });

/**
 * Cursor = base64 of JSON [filter fingerprint (first 16 hex), issuedOn, id]: bound to the filter
 * it came from (`page.cursor_mismatch` otherwise).
 */
const ListCursor = Schema.StringFromBase64.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Tuple([Schema.String, IsoDate, DocumentId]))),
);
const decodeCursor = Schema.decodeUnknownOption(ListCursor);
const encodeCursor = Schema.encodeEffect(ListCursor);

export const list = Effect.fn("list")(
  function* (caller: Caller, q: DocumentQuery & PageRequest) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.read");
    const limit = q.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return yield* pageIssue("limit", "request.malformed");
    }
    const { cursor: _cursor, limit: _limit, ...filter } = q;
    const value_1 = yield* sha256Hex(canonicalJson(filter));
    const fingerprint = EffectString.slice(0, 16)(value_1);
    let after: readonly [IsoDate, DocumentId] | undefined;
    if (q.cursor !== undefined) {
      const cursor = decodeCursor(q.cursor);
      if (Option.isNone(cursor) || cursor.value[0] !== fingerprint)
        return yield* pageIssue("cursor", "page.cursor_mismatch");
      after = [cursor.value[1], cursor.value[2]];
    }
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
    const nextCursor =
      more && last !== undefined
        ? yield* encodeCursor([fingerprint, last.issuedOn, last.id]).pipe(Effect.orDie)
        : null;
    return {
      items: EffectArray.map(rows, (row) => toSummary(row, today)),
      nextCursor,
    };
  },
  (_) => orUnavailable(_),
);

/** The document's audit entries in time order (drafts: create; issued: every change). */
export const history = Effect.fn("history")(
  function* (caller: Caller, id: DocumentId) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.history");
    yield* (yield* DocumentsRepo).get(workspaceId, id);
    return yield* (yield* CoreStore).audit.history(workspaceId, { entity: "Document", id });
  },
  (_) => orUnavailable(_),
);

const filenameOf = (number: string | null, id: DocumentId) =>
  `${EffectString.replace(/[^\p{L}\p{N}._-]+/gu, "-")(number ?? `draft-${id}`)}.pdf`;

/** PDF of the current revision through `DocumentRenderer`; locked documents render too (D5). */
export const pdf = Effect.fn("pdf")(
  function* (
    caller: Caller,
    id: DocumentId,
    opts?: { readonly template?: PdfTemplate; readonly language?: Locale },
  ) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.pdf");
    const row = yield* (yield* DocumentsRepo).get(workspaceId, id);
    const language = opts?.language ?? row.language;
    const view = yield* viewOf(row, { language });
    const bytes = yield* (yield* DocumentRenderer).render(
      view,
      {
        template: opts?.template ?? "classic",
        language,
      },
      workspaceId,
    );
    return {
      filename: filenameOf(row.number, row.id),
      contentType: "application/pdf",
      bytes: Stream.make(bytes),
    } satisfies FileDownload;
  },
  (_) => orUnavailable(_),
);
