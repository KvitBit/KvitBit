/**
 * Member side of Public Share Links (core-ports 4.6): `create`, `revoke`, `views`. Both writes
 * are idempotent by state (C6): they row-lock the document, so one active link per document
 * holds, and audit on the Document subject (D audit list: share create and revoke).
 */
import type { DocumentId, PageRequest, ShareViewEvent } from "@kvitbit/domain/contract";
import { Conflict, Invalid } from "@kvitbit/domain/contract";
import { Clock, Effect, Option } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { DocumentsRepo } from "../documents";
import { ShareLinkKeys } from "./ports";
import type { ShareLink, ShareLinkId } from "./record";
import { ShareLinksRepo } from "./repo";
import { deriveToken } from "./token";

export const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

/** The token and its stored hash for `linkId` under the current key. */
export const currentToken = (linkId: string) =>
  Effect.gen(function* () {
    const keys = yield* ShareLinkKeys;
    const token = yield* deriveToken(linkId, keys.version, keys.secret);
    return { token, tokenHash: yield* sha256Hex(token), version: keys.version };
  });

/**
 * Idempotent: returns the active link's URL if one exists. Issued documents only. An active
 * link minted under a rotated-out key version is expired (core-ports section 1): it is revoked
 * and a new link (new id, new token) replaces it in the same transaction.
 */
export const create = (id: DocumentId) =>
  Effect.gen(function* () {
    const { caller, workspaceId } = yield* authorizeInWorkspace("share.write");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        // The document lock serializes every link write of the document.
        const document = yield* (yield* DocumentsRepo).lock(workspaceId, id);
        // Drafts (D13) and cancelled documents cannot be shared.
        if (document.status !== "issued") {
          return yield* new Conflict({ reason: "illegal_transition" });
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
        const linkId = yield* newId<ShareLinkId>();
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
  }).pipe(orUnavailable);

/** Idempotent: revokes the active link if there is one; its token then returns NotFound. */
export const revoke = (id: DocumentId) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("share.write");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const document = yield* (yield* DocumentsRepo).lock(workspaceId, id);
        const repo = yield* ShareLinksRepo;
        const active = yield* repo.activeFor(workspaceId, id);
        if (Option.isNone(active)) return;
        yield* repo.revoke(workspaceId, active.value.id, yield* nowIso);
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "share.revoke",
          revision: document.revision,
          changes: [{ path: "share", before: active.value.id, after: null }],
        });
      }),
    );
  }).pipe(orUnavailable);

const DEFAULT_LIMIT = 50;

const pageIssue = (path: string, code: "request.malformed" | "page.cursor_mismatch") =>
  new Invalid({ issues: [{ path: [path], code }] });

/** Cursor = base64 of JSON [document id, at, event id]: bound to the document it came from. */
const decodeCursor = (cursor: string, documentId: DocumentId) => {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((p) => typeof p === "string") &&
      parsed[0] === documentId
    ) {
      return [parsed[1] as string, parsed[2] as string] as const;
    }
  } catch {
    // fall through
  }
  return null;
};

/** View and download events of the document's links (all of them), newest first. */
export const views = (id: DocumentId, page: PageRequest = {}) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("share.read");
    const limit = page.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return yield* pageIssue("limit", "request.malformed");
    }
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor, id);
    if (after === null) return yield* pageIssue("cursor", "page.cursor_mismatch");
    yield* (yield* DocumentsRepo).get(workspaceId, id);
    const { rows, more } = yield* (yield* ShareLinksRepo).events(workspaceId, id, {
      after,
      limit,
    });
    const last = rows.at(-1);
    return {
      items: rows.map(
        (e): ShareViewEvent => ({ id: e.id, kind: e.kind, at: e.at, device: e.device }),
      ),
      nextCursor: more && last ? btoa(JSON.stringify([id, last.at, last.id])) : null,
    };
  }).pipe(orUnavailable);
