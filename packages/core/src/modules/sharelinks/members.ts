import type { DocumentId, PageRequest, ShareViewEvent } from "@kvitbit/domain/contract";
import { Conflict, Invalid } from "@kvitbit/domain/contract";
/**
 * Member side of Public Share Links (core-ports 4.6): `create`, `revoke`, `views`. Both writes
 * are idempotent by state (C6): they row-lock the document, so one active link per document
 * holds, and audit on the Document subject (D audit list: share create and revoke).
 */
import * as EffectArray from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { DocumentsRepo } from "../documents";
import { ShareLinkKeys } from "./ports";
import { type ShareLink, ShareLinkId } from "./record";
import { ShareLinksRepo } from "./repo";
import { deriveToken } from "./token";

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The token and its stored hash for `linkId` under the current key. */
const currentToken = Effect.fn("currentToken")(function* (linkId: string) {
  const keys = yield* ShareLinkKeys;
  const token = yield* deriveToken(linkId, keys.version, keys.secret);
  return { token, tokenHash: yield* sha256Hex(token), version: keys.version };
});

/**
 * Idempotent: returns the active link's URL if one exists. Issued documents only. An active
 * link minted under a rotated-out key version is expired (core-ports section 1): it is revoked
 * and a new link (new id, new token) replaces it in the same transaction.
 */
export const create = Effect.fn("create")(
  function* (id: DocumentId) {
    const { caller, workspaceId } = yield* authorizeInWorkspace("share.write");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        // The document lock serializes every link write of the document.
        const document = yield* (yield* DocumentsRepo).lock(workspaceId, id);
        // Drafts (D13) and cancelled documents cannot be shared.
        if (document.status !== "issued") {
          return yield* Conflict.make({ reason: "illegal_transition" });
        }
        const repo = yield* ShareLinksRepo;
        const keys = yield* ShareLinkKeys;
        const active = yield* repo.activeFor(workspaceId, id);
        if (Option.isSome(active) && active.value.keyVersion === keys.version) {
          const { token } = yield* currentToken(active.value.id);
          return { url: keys.pageUrl(token) };
        }
        const at = yield* nowIso;
        const expired = Option.getOrNull(active);
        if (expired !== null) yield* repo.revoke(workspaceId, expired.id, at);
        const linkId = yield* newId(ShareLinkId.make);
        const { token, tokenHash, version } = yield* currentToken(linkId);
        const link: ShareLink = {
          id: linkId,
          workspaceId,
          documentId: id,
          tokenHash,
          keyVersion: version,
          createdBy: caller._tag === "Member" ? caller.userId : null,
          viewedAt: null,
          revokedAt: null,
          createdAt: at,
        };
        yield* repo.insert(link).pipe(Effect.catchTag("UniqueViolation", Effect.die));
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "share.create",
          revision: document.revision,
          changes: [{ path: "share", before: expired?.id ?? null, after: linkId }],
        });
        return { url: keys.pageUrl(token) };
      }),
    );
  },
  (_) => orUnavailable(_),
);

/** Idempotent: revokes the active link if there is one; its token then returns NotFound. */
export const revoke = Effect.fn("revoke")(
  function* (id: DocumentId) {
    const { workspaceId } = yield* authorizeInWorkspace("share.write");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const document = yield* (yield* DocumentsRepo).lock(workspaceId, id);
        const repo = yield* ShareLinksRepo;
        const active = yield* repo.activeFor(workspaceId, id);
        if (Option.isNone(active)) return;
        const nowIso_1 = yield* nowIso;
        yield* repo.revoke(workspaceId, active.value.id, nowIso_1);
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "share.revoke",
          revision: document.revision,
          changes: [{ path: "share", before: active.value.id, after: null }],
        });
      }),
    );
  },
  (_) => orUnavailable(_),
);

const DEFAULT_LIMIT = 50;

const pageIssue = (path: string, code: "request.malformed" | "page.cursor_mismatch") =>
  Invalid.make({ issues: [{ path: [path], code }] });

/** Cursor = base64 of JSON [document id, at, event id]: bound to the document it came from. */
const ViewCursor = Schema.StringFromBase64.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
  ),
);
const decodeCursor = Schema.decodeUnknownOption(ViewCursor);
const encodeCursor = Schema.encodeEffect(ViewCursor);

/** View and download events of the document's links (all of them), newest first. */
export const views = Effect.fn("views")(
  function* (id: DocumentId, page: PageRequest = {}) {
    const { workspaceId } = yield* authorizeInWorkspace("share.read");
    const limit = page.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return yield* pageIssue("limit", "request.malformed");
    }
    let after: readonly [string, string] | undefined;
    if (page.cursor !== undefined) {
      const cursor = decodeCursor(page.cursor);
      if (Option.isNone(cursor) || cursor.value[0] !== id)
        return yield* pageIssue("cursor", "page.cursor_mismatch");
      after = [cursor.value[1], cursor.value[2]];
    }
    yield* (yield* DocumentsRepo).get(workspaceId, id);
    const { rows, more } = yield* (yield* ShareLinksRepo).events(workspaceId, id, {
      after,
      limit,
    });
    const last = rows.at(-1);
    const nextCursor =
      more && last !== undefined
        ? yield* encodeCursor([id, last.at, last.id]).pipe(Effect.orDie)
        : null;
    return {
      items: EffectArray.map(
        rows,
        (e): ShareViewEvent => ({ id: e.id, kind: e.kind, at: e.at, device: e.device }),
      ),
      nextCursor,
    };
  },
  (_) => orUnavailable(_),
);
