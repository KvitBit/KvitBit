/**
 * Draft methods: preview, createDraft, discardDraft and edit of a draft. Each follows the
 * method shape of src/index.ts. Drafts audit only create and discard (issue is P2's).
 */

import type { Caller, DocumentId, DocumentPatch, RequestOptions } from "@kvitbit/domain/contract";
import { Conflict, DocumentId as DocumentIdSchema, DocumentInput } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { fxDryRun } from "../../shared/fx";
import { withIdempotency } from "../../shared/idempotency";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { applyPatch, compose, specFromInput, specFromRecord } from "./compose";
import type { DocumentRecord } from "./record";
import { DocumentsRepo } from "./repo";
import { newDraftRecord, now, viewOf } from "./support";
import { guard } from "./transitions";
import { DocumentViewCodec, toView } from "./view";

/**
 * Live totals (rule D15): the createDraft code path and errors, inside a CoreStore transaction
 * (the snapshot ports' contract, #402), with nothing stored, numbered, audited or logged.
 */
export const preview = Effect.fn("preview")(
  function* (caller: Caller, input: DocumentInput) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.draft");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const { today, at } = yield* now;
        const spec = yield* specFromInput(workspaceId, input);
        const composed = yield* compose(caller, workspaceId, spec, { today });
        const value_1 = yield* newId(DocumentIdSchema.make);
        const row = newDraftRecord(value_1, workspaceId, composed, at);
        return toView(row, { today });
      }),
    );
  },
  (_) => fxDryRun(_),
  (_) => orUnavailable(_),
);

export const createDraft = Effect.fn("createDraft")(
  function* (caller: Caller, input: DocumentInput, opts?: RequestOptions) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.draft");
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
        const composed = yield* compose(caller, workspaceId, spec, { today });
        const value_1 = yield* newId(DocumentIdSchema.make);
        const row = yield* repo
          .insert(newDraftRecord(value_1, workspaceId, composed, at))
          // A draft has no number, so no unique index can break.
          .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
        yield* appendAudit(caller, {
          workspaceId,
          subject: { entity: "Document", id: row.id },
          action: "document.create",
          revision: row.revision,
        });
        return toView(row, { today });
      }),
    );
  },
  (_) => orUnavailable(_),
);

/** Drafts only (rule D2); a hard delete that never consumes a number (D1). */
export const discardDraft = Effect.fn("discardDraft")(
  function* (caller: Caller, id: DocumentId, expectedRevision: number) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.draft");
    const store = yield* CoreStore;
    const repo = yield* DocumentsRepo;
    yield* store.transaction(
      Effect.gen(function* () {
        const row = yield* repo.getForUpdate(workspaceId, id, expectedRevision);
        yield* guard(row, "discard");
        yield* repo.remove(workspaceId, id, row.revision);
        yield* appendAudit(caller, {
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.discard",
          revision: row.revision,
        });
      }),
    );
  },
  (_) => orUnavailable(_),
);

/**
 * `edit` of a draft (locked row from `getForUpdate`): applies the patch and recomposes with
 * fresh party snapshots and defaults (drafts are never frozen, rule D10). Not audited.
 * `number` is for issued documents only (rule D4).
 */
export const editDraft = Effect.fn("editDraft")(function* (
  caller: Caller,
  row: DocumentRecord,
  patch: DocumentPatch,
) {
  if (patch.number !== undefined) {
    return yield* Conflict.make({ reason: "illegal_transition" });
  }
  const repo = yield* DocumentsRepo;
  const { today, at } = yield* now;
  const spec = yield* applyPatch(row.workspaceId, specFromRecord(row), patch);
  const composed = yield* compose(caller, row.workspaceId, spec, { today });
  const next = yield* repo
    .update({ ...row, ...composed, updatedAt: at }, row.revision)
    .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
  return yield* viewOf(next);
});
