/**
 * Draft methods: preview, createDraft, discardDraft and edit of a draft. Each follows the
 * method shape of src/index.ts. Drafts audit only create and discard (issue is P2's).
 */
import type { DocumentId, DocumentPatch, RequestOptions } from "@kvitbit/domain/contract";
import { Conflict, DocumentInput, Invalid } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { withIdempotency } from "../../shared/idempotency";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { applyPatch, compose, specFromInput, specFromRecord } from "./compose";
import type { DocumentRecord } from "./record";
import { DocumentsRepo } from "./repo";
import { dieOnUnavailable, newDraftRecord, now, viewOf } from "./support";
import { DocumentViewCodec, toView } from "./view";

/** Live totals (rule D15): the createDraft code path, nothing stored, numbered or audited. */
export const preview = (input: DocumentInput) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.draft");
    const { today, at } = yield* now;
    const spec = yield* specFromInput(workspaceId, input, "invalid");
    const composed = yield* compose(workspaceId, spec, { today, missing: "invalid" });
    const row = newDraftRecord(yield* newId<DocumentId>(), workspaceId, composed, at);
    return toView(row, { today });
  }).pipe(
    // "invalid" mode reports every missing reference as Invalid; a NotFound here is a bug.
    Effect.catchTag("NotFound", (e) => Effect.die(e)),
    orUnavailable,
  );

export const createDraft = (input: DocumentInput, opts?: RequestOptions) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.draft");
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Documents.createDraft",
        payload: { schema: DocumentInput, value: input },
        result: DocumentViewCodec,
      },
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const { today, at } = yield* now;
        const spec = yield* specFromInput(workspaceId, input, "notFound");
        const composed = yield* compose(workspaceId, spec, { today, missing: "notFound" });
        const row = yield* repo
          .insert(newDraftRecord(yield* newId<DocumentId>(), workspaceId, composed, at))
          // A draft has no number, so no unique index can break.
          .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id: row.id },
          action: "document.create",
          revision: row.revision,
        });
        return toView(row, { today });
      }),
    ).pipe(
      // The signature has no Conflict: a reused key with another payload is a malformed request.
      Effect.catchTag("Conflict", () =>
        Effect.fail(new Invalid({ issues: [{ path: ["requestKey"], code: "request.malformed" }] })),
      ),
    );
  }).pipe(orUnavailable);

/** Drafts only (rule D2); a hard delete that never consumes a number (D1). */
export const discardDraft = (id: DocumentId, expectedRevision: number) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.draft");
    const store = yield* CoreStore;
    const repo = yield* DocumentsRepo;
    yield* store.transaction(
      Effect.gen(function* () {
        const row = yield* repo.getForUpdate(workspaceId, id, expectedRevision);
        if (row.status !== "draft") {
          return yield* new Conflict({ reason: "illegal_transition" });
        }
        yield* repo.remove(workspaceId, id, row.revision);
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.discard",
          revision: row.revision,
        });
      }),
    );
  }).pipe(dieOnUnavailable);

/**
 * `edit` of a draft (locked row from `getForUpdate`): applies the patch and recomposes with
 * fresh party snapshots and defaults (drafts are never frozen, rule D10). Not audited.
 * `number` is for issued documents only (rule D4).
 */
export const editDraft = (row: DocumentRecord, patch: DocumentPatch) =>
  Effect.gen(function* () {
    if (patch.number !== undefined) {
      return yield* new Conflict({ reason: "illegal_transition" });
    }
    const repo = yield* DocumentsRepo;
    const { today, at } = yield* now;
    const spec = yield* applyPatch(row.workspaceId, specFromRecord(row), patch, "notFound");
    const composed = yield* compose(row.workspaceId, spec, { today, missing: "notFound" });
    const next = yield* repo
      .update({ ...row, ...composed, updatedAt: at }, row.revision)
      .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
    return yield* viewOf(next);
  });
