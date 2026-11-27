/**
 * Stub `documents` rows for store-level numbering tests: `reservations.tryReserve` needs the
 * document row (`number_reservations_document_fk`), which the in-memory store enforces.
 */
import type { DocumentId } from "@kvitbit/domain/contract";
import { WorkspaceId } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as EffectFunction from "effect/Function";
import * as Schema from "effect/Schema";
import type { Row } from "../../src/store/tables";
import { defineCollection, MemoryTables } from "../../src/store/tables";

/** A `documents` collection for numbering tests without full document fixtures. */
export const StubDocuments = defineCollection<Row>({
  name: "documents",
  entity: "Document",
  schema: Schema.Struct({ id: Schema.String, workspaceId: WorkspaceId, revision: Schema.Int }),
  unique: [],
});

/** Inserts a stub row for `documentId` unless one exists; run it inside a transaction. */
export const ensureDocumentRow: {
  (documentId: DocumentId): (workspaceId: WorkspaceId) => Effect.Effect<void, never, MemoryTables>;
  (workspaceId: WorkspaceId, documentId: DocumentId): Effect.Effect<void, never, MemoryTables>;
} = EffectFunction.dual(
  2,
  (workspaceId: WorkspaceId, documentId: DocumentId): Effect.Effect<void, never, MemoryTables> =>
    Effect.gen(function* () {
      const documents = (yield* MemoryTables).collection(StubDocuments);
      yield* documents.get(workspaceId, documentId).pipe(
        Effect.catchTag("NotFound", () =>
          documents.insert({ id: documentId, workspaceId, revision: 1 }).pipe(Effect.orDie),
        ),
        Effect.orDie,
      );
    }),
);
