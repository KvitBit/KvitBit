import type {
  DocumentId,
  DocumentSummary,
  IsoDate,
  ShareViewEvent,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { inWorkspace, type KvitbitApiClient, pageQuery } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { decodeReportView } from "../reports/model";
import {
  DASHBOARD_LIST_LIMIT,
  type DashboardActivity,
  type DashboardDocument,
  documentActivity,
  mostOverdueDocuments,
  parseDocumentSummaries,
} from "./model";
import { feedRequest, scanFeedPages } from "./paged-feed";

export const loadRecentDocuments = ({
  api,
  workspaceId,
}: {
  readonly api: KvitbitApiClient;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.map(
    api.documents.list({
      params: inWorkspace(workspaceId),
      query: { limit: DASHBOARD_LIST_LIMIT },
    }),
    (page) => ({
      items: parseDocumentSummaries(page.items),
      hasDocuments: page.items.length > 0 || page.nextCursor !== null,
    }),
  );

export const loadOverdueDocuments = ({
  api,
  workspaceId,
  query,
}: {
  readonly api: KvitbitApiClient;
  readonly workspaceId: WorkspaceId;
  readonly query: { readonly from: IsoDate; readonly to: IsoDate };
}) =>
  Effect.map(api.reports.run({ params: { workspaceId, report: "receivables" }, query }), (view) => {
    const report = decodeReportView(view, "receivables");
    return report.report === "receivables" ? mostOverdueDocuments(report) : [];
  });

const loadLatestViews = Effect.fn("loadLatestViews")(function* (
  api: KvitbitApiClient,
  params: { readonly workspaceId: WorkspaceId; readonly documentId: DocumentId },
) {
  const views = new Map<string, ShareViewEvent>();
  yield* scanFeedPages({
    fetchPage: (cursor) => api.shareLinks.views({ params, query: pageQuery({}, cursor) }),
    visit: (items) =>
      Effect.sync(() => {
        for (const view of items) {
          if (view.kind === "view" && !views.has(view.id) && Number.isFinite(Date.parse(view.at))) {
            views.set(view.id, view);
          }
        }
        // The endpoint orders events newest first and also includes PDF downloads.
        return views.size < DASHBOARD_LIST_LIMIT;
      }),
  });
  return [...views.values()];
});

const loadDocumentActivity = (
  api: KvitbitApiClient,
  workspaceId: WorkspaceId,
  document: DashboardDocument,
) => {
  const params = { workspaceId, documentId: document.id };
  return Effect.all(
    [
      feedRequest(api.documents.get({ params })),
      document.kind === "invoice" || document.kind === "proforma"
        ? feedRequest(api.payments.listForDocument({ params }))
        : Effect.succeed([]),
      loadLatestViews(api, params),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([detail, payments, views]) => documentActivity(document, detail, payments, views)),
    // A document can disappear between the list and activity reads.
    Effect.catchTag("NotFound", (error) =>
      error.entity === "Document" && error.id === document.id
        ? Effect.succeed([])
        : Effect.fail(error),
    ),
  );
};

const compareActivity = (a: DashboardActivity, b: DashboardActivity) =>
  Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : a.id === b.id ? 0 : -1);

export const loadWorkspaceActivity = Effect.fnUntraced(function* ({
  api,
  workspaceId,
}: {
  readonly api: KvitbitApiClient;
  readonly workspaceId: WorkspaceId;
}) {
  const seen = new Set<DocumentId>();
  let latest: DashboardActivity[] = [];

  yield* scanFeedPages({
    fetchPage: (cursor) =>
      api.documents.list({ params: inWorkspace(workspaceId), query: pageQuery({}, cursor) }),
    visit: Effect.fn("collectActivityPage")(function* (items: ReadonlyArray<DocumentSummary>) {
      const documents = Arr.filter(parseDocumentSummaries(items), (document) => {
        if (document.status === "draft" || seen.has(document.id)) return false;
        seen.add(document.id);
        return true;
      });
      const events = yield* Effect.forEach(
        documents,
        (document) => loadDocumentActivity(api, workspaceId, document),
        { concurrency: 2 },
      );
      const unique = new Map(Arr.map(latest, (event) => [event.id, event]));
      for (const event of events.flat()) {
        const existing = unique.get(event.id);
        if (existing === undefined || compareActivity(event, existing) < 0)
          unique.set(event.id, event);
      }
      latest = [...unique.values()].sort(compareActivity).slice(0, DASHBOARD_LIST_LIMIT);
      return true;
    }),
  });

  return latest;
});
