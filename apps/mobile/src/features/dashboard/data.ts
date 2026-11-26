import type { IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import { inWorkspace, type KvitbitApiClient } from "@kvitbit/ui-port/api";
import { Effect } from "effect";
import { decodeReportView } from "../reports/model";
import {
  DASHBOARD_LIST_LIMIT,
  type DashboardDocument,
  documentActivity,
  mostOverdueDocuments,
  parseDocumentSummaries,
} from "./model";

export const loadRecentDocuments = (api: KvitbitApiClient, workspaceId: WorkspaceId) =>
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

export const loadOverdueDocuments = (
  api: KvitbitApiClient,
  workspaceId: WorkspaceId,
  query: { readonly from: IsoDate; readonly to: IsoDate },
) =>
  Effect.map(api.reports.run({ params: { workspaceId, report: "receivables" }, query }), (view) => {
    const report = decodeReportView(view, "receivables");
    return report.report === "receivables" ? mostOverdueDocuments(report) : [];
  });

export const loadRecentDocumentActivity = (
  api: KvitbitApiClient,
  workspaceId: WorkspaceId,
  documents: ReadonlyArray<DashboardDocument>,
) =>
  Effect.map(
    Effect.forEach(
      documents.filter((document) => document.status !== "draft"),
      (document) => {
        const params = { workspaceId, documentId: document.id };
        return Effect.map(
          Effect.all([api.documents.get({ params }), api.payments.listForDocument({ params })], {
            concurrency: 2,
          }),
          ([detail, payments]) => documentActivity(document, detail, payments),
        );
      },
      { concurrency: 2 },
    ),
    (events) =>
      events
        .flat()
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, DASHBOARD_LIST_LIMIT),
  );
