/** `documents` group handlers (http-mcp-contracts 3.4 & 3.5.4): one Documents method per endpoint. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import {
  CurrentCaller,
  type DocumentKind,
  Documents,
  type WorkspaceId,
} from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Analytics } from "../../runtime/analytics";
import {
  compact,
  fileDownload,
  requestOptions,
  requestWasReplayed,
  setLocation,
  withRevision,
} from "../conventions";
import { jsonizeAuditEntries, jsonizeDocumentPage, jsonizeDocumentView } from "./documents/jsonize";

const documentLocation = (workspaceId: string, documentId: string) =>
  `${API_PREFIX}/workspaces/${workspaceId}/documents/${documentId}`;

export const DocumentsGroupLive = HttpApiBuilder.group(Api, "documents", (handlers) =>
  Effect.gen(function* () {
    const documents = yield* Documents;
    const analytics = yield* Analytics;
    const captureDocument = (
      event: "document_created" | "document_issued",
      workspaceId: WorkspaceId,
      kind: DocumentKind,
      source: "draft" | "direct",
    ) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller;
        if (caller._tag === "Member" && !(yield* requestWasReplayed)) {
          yield* analytics.capture({ event, userId: caller.userId, workspaceId, kind, source });
        }
      });
    return handlers
      .handle("list", ({ query }) =>
        Effect.map(documents.list(compact(query)), jsonizeDocumentPage),
      )
      .handle("preview", ({ payload }) =>
        Effect.map(documents.preview(payload), jsonizeDocumentView),
      )
      .handle("createDraft", ({ params, headers, payload }) =>
        documents.createDraft(payload, requestOptions(headers)).pipe(
          Effect.tap((view) => setLocation(documentLocation(params.workspaceId, view.id))),
          Effect.tap((view) =>
            captureDocument("document_created", params.workspaceId, view.kind, "draft"),
          ),
          Effect.map(jsonizeDocumentView),
        ),
      )
      .handle("issueFromInput", ({ params, headers, payload }) =>
        documents
          .issue(
            { input: payload.input },
            {
              ...requestOptions(headers),
              ...(payload.send === undefined ? {} : { send: payload.send }),
            },
          )
          .pipe(
            Effect.tap((view) => setLocation(documentLocation(params.workspaceId, view.id))),
            Effect.tap((view) =>
              captureDocument("document_issued", params.workspaceId, view.kind, "direct"),
            ),
            Effect.map(jsonizeDocumentView),
          ),
      )
      .handle("get", ({ params }) =>
        Effect.map(documents.get(params.documentId), jsonizeDocumentView),
      )
      .handle("edit", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          documents.edit(params.documentId, payload, expectedRevision),
        ).pipe(Effect.map(jsonizeDocumentView)),
      )
      .handle("discardDraft", ({ params, headers }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          documents.discardDraft(params.documentId, expectedRevision),
        ),
      )
      .handle("issueDraft", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          documents.issue(
            { draft: params.documentId, expectedRevision },
            {
              ...requestOptions(headers),
              ...(payload.send === undefined ? {} : { send: payload.send }),
            },
          ),
        ).pipe(
          Effect.tap((view) =>
            captureDocument("document_issued", params.workspaceId, view.kind, "draft"),
          ),
          Effect.map(jsonizeDocumentView),
        ),
      )
      .handle("lock", ({ params }) =>
        Effect.map(documents.lock(params.documentId), jsonizeDocumentView),
      )
      .handle("unlock", ({ params, payload }) =>
        Effect.map(documents.unlock(params.documentId, payload.reason), jsonizeDocumentView),
      )
      .handle("cancel", ({ params, headers, payload }) =>
        Effect.map(
          documents.cancel(params.documentId, payload, requestOptions(headers)),
          (result) => ({
            document: jsonizeDocumentView(result.document),
            creditNote: result.creditNote === null ? null : jsonizeDocumentView(result.creditNote),
          }),
        ),
      )
      .handle("correct", ({ params, headers, payload }) =>
        documents.correct(params.documentId, payload, requestOptions(headers)).pipe(
          Effect.tap((view) => setLocation(documentLocation(params.workspaceId, view.id))),
          Effect.map(jsonizeDocumentView),
        ),
      )
      .handle("issueFinalInvoice", ({ params, headers, payload }) =>
        documents.issueFinalInvoice(params.documentId, payload, requestOptions(headers)).pipe(
          Effect.tap((view) => setLocation(documentLocation(params.workspaceId, view.id))),
          Effect.map(jsonizeDocumentView),
        ),
      )
      .handle("send", ({ params, headers, payload }) =>
        documents.send(params.documentId, payload, requestOptions(headers)),
      )
      .handle("pdf", ({ params, query }) =>
        Effect.map(
          documents.pdf(
            params.documentId,
            compact({ template: query.template, language: query.language }),
          ),
          (file) => fileDownload(file, { disposition: query.disposition }),
        ),
      )
      .handle("history", ({ params }) =>
        Effect.map(documents.history(params.documentId), jsonizeAuditEntries),
      );
  }),
);
