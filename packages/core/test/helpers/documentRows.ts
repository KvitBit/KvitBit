/**
 * Stub `documents` rows for store-level numbering tests: `reservations.tryReserve` needs the
 * document row (`number_reservations_document_fk`), which the in-memory store enforces.
 */
import type { DocumentId, WorkspaceId } from "@kvitbit/domain/contract";
import { Effect, Schema } from "effect";
import type { Row } from "../../src/store/tables";
import { defineCollection, MemoryTables } from "../../src/store/tables";

/** A schema-less `documents` collection: rows carry only id, workspaceId and revision. */
export const StubDocuments = defineCollection<Row>({
  name: "documents",
  entity: "Document",
  schema: Schema.Any as unknown as Schema.Codec<Row, unknown>,
  unique: [],
});

/** Inserts a stub row for `documentId` unless one exists; run it inside a transaction. */
export const ensureDocumentRow = (workspaceId: WorkspaceId, documentId: DocumentId) =>
  Effect.gen(function* () {
    const documents = (yield* MemoryTables).collection(StubDocuments);
    yield* documents.get(workspaceId, documentId).pipe(
      Effect.catchTag("NotFound", () =>
        documents.insert({ id: documentId, workspaceId, revision: 1 }).pipe(Effect.orDie),
      ),
      Effect.orDie,
    );
  });
