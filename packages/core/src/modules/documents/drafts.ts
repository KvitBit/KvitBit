/**
 * Draft methods: preview, createDraft, discardDraft and edit of a draft. Each follows the
 * method shape of src/index.ts. Drafts audit only create and discard (issue is P2's).
 */
import type { DocumentId, DocumentPatch, RequestOptions } from "@kvitbit/domain/contract";
import { Conflict, DocumentInput } from "@kvitbit/domain/contract";
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
import { newDraftRecord, now, viewOf, withActivity } from "./support";
import { guard } from "./transitions";
import { DocumentViewCodec, toView } from "./view";

/**
 * Live totals (rule D15): the createDraft code path and errors, inside a CoreStore transaction
 * (the snapshot ports' contract, #402), with nothing stored, numbered, audited or logged.
 */
export const preview = (input: DocumentInput) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.draft");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const { today, at } = yield* now;
        const spec = yield* specFromInput(workspaceId, input);
        const composed = yield* compose(workspaceId, spec, { today });
        const row = newDraftRecord(yield* newId<DocumentId>(), workspaceId, composed, at);
        return toView(row, { today });
      }),
    );
  }).pipe(orUnavailable);

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
        const spec = yield* specFromInput(workspaceId, input);
        const composed = yield* compose(workspaceId, spec, { today });
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
      (view) => withActivity(workspaceId, view),
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
        yield* guard(row, "discard");
        yield* repo.remove(workspaceId, id, row.revision);
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.discard",
          revision: row.revision,
        });
      }),
    );
  }).pipe(orUnavailable);

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
    const spec = yield* applyPatch(row.workspaceId, specFromRecord(row), patch);
    const composed = yield* compose(row.workspaceId, spec, { today });
    const next = yield* repo
      .update({ ...row, ...composed, updatedAt: at }, row.revision)
      .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
    return yield* viewOf(next);
  });
