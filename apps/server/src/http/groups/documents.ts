/** `documents` group handlers (http-mcp-contracts 3.4 & 3.5.4): one Documents method per endpoint. */
import { API_PREFIX, Api, RequestCaller } from "@kvitbit/api-contract";
import { Documents } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  compact,
  downloadResponse,
  requestOptions,
  setLocation,
  withRevision,
} from "../conventions";
import { jsonizeAuditEntries, jsonizeDocumentPage, jsonizeDocumentView } from "./documents/jsonize";

const documentLocation = (workspaceId: string, documentId: string) =>
  `${API_PREFIX}/workspaces/${workspaceId}/documents/${documentId}`;

export const DocumentsGroupLive = HttpApiBuilder.group(
  Api,
  "documents",
  Effect.fnUntraced(function* (handlers) {
    const documents = yield* Documents;
    return handlers
      .handle("list", ({ query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(documents.list(caller, compact(query)), jsonizeDocumentPage),
        ),
      )
      .handle("preview", ({ payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(documents.preview(caller, payload), jsonizeDocumentView),
        ),
      )
      .handle("createDraft", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          documents.createDraft(caller, payload, requestOptions(headers)).pipe(
            Effect.tap((view) => setLocation(documentLocation(params.workspaceId, view.id))),
            Effect.map(jsonizeDocumentView),
          ),
        ),
      )
      .handle("issueFromInput", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          documents
            .issue(
              caller,
              { input: payload.input },
              {
                ...requestOptions(headers),
                ...compact({ send: payload.send }),
              },
            )
            .pipe(
              Effect.tap((view) => setLocation(documentLocation(params.workspaceId, view.id))),
              Effect.map(jsonizeDocumentView),
            ),
        ),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(documents.get(caller, params.documentId), jsonizeDocumentView),
        ),
      )
      .handle("edit", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            documents.edit(caller, params.documentId, payload, expectedRevision),
          ).pipe(Effect.map(jsonizeDocumentView)),
        ),
      )
      .handle("discardDraft", ({ params, headers }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            documents.discardDraft(caller, params.documentId, expectedRevision),
          ),
        ),
      )
      .handle("issueDraft", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            documents.issue(
              caller,
              { draft: params.documentId, expectedRevision },
              {
                ...requestOptions(headers),
                ...compact({ send: payload.send }),
              },
            ),
          ).pipe(Effect.map(jsonizeDocumentView)),
        ),
      )
      .handle("lock", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(documents.lock(caller, params.documentId), jsonizeDocumentView),
        ),
      )
      .handle("unlock", ({ params, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(
            documents.unlock(caller, params.documentId, payload.reason),
            jsonizeDocumentView,
          ),
        ),
      )
      .handle("cancel", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(
            documents.cancel(caller, params.documentId, payload, requestOptions(headers)),
            (result) => ({
              document: jsonizeDocumentView(result.document),
              creditNote:
                result.creditNote === null ? null : jsonizeDocumentView(result.creditNote),
            }),
          ),
        ),
      )
      .handle("correct", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          documents.correct(caller, params.documentId, payload, requestOptions(headers)).pipe(
            Effect.tap((view) => setLocation(documentLocation(params.workspaceId, view.id))),
            Effect.map(jsonizeDocumentView),
          ),
        ),
      )
      .handle("issueFinalInvoice", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          documents
            .issueFinalInvoice(caller, params.documentId, payload, requestOptions(headers))
            .pipe(
              Effect.tap((view) => setLocation(documentLocation(params.workspaceId, view.id))),
              Effect.map(jsonizeDocumentView),
            ),
        ),
      )
      .handle("send", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          documents.send(caller, params.documentId, payload, requestOptions(headers)),
        ),
      )
      .handle("pdf", ({ params, query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(
            documents.pdf(
              caller,
              params.documentId,
              compact({ template: query.template, language: query.language }),
            ),
            downloadResponse({ disposition: query.disposition }),
          ),
        ),
      )
      .handle("history", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(documents.history(caller, params.documentId), jsonizeAuditEntries),
        ),
      );
  }),
);
