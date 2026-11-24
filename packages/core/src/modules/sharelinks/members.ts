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
import type { ShareLinkId, ShareLinkRecord } from "./record";
import { ShareLinksRepo } from "./repo";
import { deriveToken } from "./token";

export const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

/** The current key's secret; configuration without one is a deployment defect. */
const currentKey = Effect.flatMap(ShareLinkKeys, (keys) => {
  const secret = keys.secret(keys.current);
  return secret === null
    ? Effect.die(new Error("ShareLinkKeys: the current key version has no secret"))
    : Effect.succeed({ version: keys.current, secret });
});

const tokenFor = (linkId: string, version: number, secret: Uint8Array) =>
  Effect.flatMap(deriveToken(linkId, version, secret), (token) =>
    Effect.map(sha256Hex(token), (tokenHash) => ({ token, tokenHash })),
  );

/** Idempotent: returns the active link's URL if one exists. Issued documents only. */
export const create = (id: DocumentId) =>
  Effect.gen(function* () {
    const { caller, workspaceId } = yield* authorizeInWorkspace("share.write");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const document = yield* (yield* DocumentsRepo).lock(workspaceId, id);
        // Drafts (D13) and cancelled documents cannot be shared.
        if (document.status !== "issued") {
          return yield* new Conflict({ reason: "illegal_transition" });
        }
        const repo = yield* ShareLinksRepo;
        const keys = yield* ShareLinkKeys;
        const active = yield* repo.activeFor(workspaceId, id);
        if (Option.isSome(active)) {
          const link = active.value;
          const secret = keys.secret(link.keyVersion);
          if (secret !== null) {
            const { token } = yield* tokenFor(link.id, link.keyVersion, secret);
            return { url: keys.pageUrl(token) };
          }
          // The link's key was retired (its URL expired): re-key the same link.
          const key = yield* currentKey;
          const { token, tokenHash } = yield* tokenFor(link.id, key.version, key.secret);
          yield* repo.update({ ...link, keyVersion: key.version, tokenHash }, link.revision).pipe(
            // The document lock serializes link writes; the hash is unique per link id.
            Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }),
          );
          yield* appendAudit({
            workspaceId,
            subject: { entity: "Document", id },
            action: "share.create",
            revision: document.revision,
            changes: [{ path: "share.keyVersion", before: link.keyVersion, after: key.version }],
          });
          return { url: keys.pageUrl(token) };
        }
        const linkId = yield* newId<ShareLinkId>();
        const key = yield* currentKey;
        const { token, tokenHash } = yield* tokenFor(linkId, key.version, key.secret);
        const row: ShareLinkRecord = {
          id: linkId,
          workspaceId,
          revision: 1,
          documentId: id,
          tokenHash,
          keyVersion: key.version,
          createdBy: caller._tag === "Member" ? caller.userId : null,
          viewedAt: null,
          revokedAt: null,
          createdAt: yield* nowIso,
        };
        yield* repo.insert(row).pipe(Effect.catchTag("UniqueViolation", Effect.die));
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "share.create",
          revision: document.revision,
          changes: [{ path: "share", before: null, after: linkId }],
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
        const link = yield* repo.lock(workspaceId, active.value.id);
        yield* repo
          .update({ ...link, revokedAt: yield* nowIso }, link.revision)
          .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "share.revoke",
          revision: document.revision,
          changes: [{ path: "share", before: link.id, after: null }],
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
