/** `reports` group handlers (http-mcp-contracts 3.5.4): dashboard, reports, FX rates, exports. */

import { Api, RequestCaller } from "@kvitbit/api-contract";
import { Reports } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Analytics } from "../../runtime/analytics";
import { compact, fileDownload, requestOptions } from "../conventions";
import { jsonizeReport } from "./records/json";

export const ReportsGroupLive = HttpApiBuilder.group(
  Api,
  "reports",
  Effect.fnUntraced(function* (handlers) {
    const reports = yield* Reports;
    const analytics = yield* Analytics;
    return handlers
      .handle("dashboard", ({ query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          reports.dashboard(caller, { from: query.from, to: query.to }),
        ),
      )
      .handle("run", ({ params, query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(
            reports.run(caller, {
              report: params.report,
              period: { from: query.from, to: query.to },
              ...compact({ groupBy: query.groupBy }),
            }),
            jsonizeReport,
          ),
        ),
      )
      .handle("export", ({ params, query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(
            reports
              .export(
                caller,
                {
                  report: params.report,
                  period: { from: query.from, to: query.to },
                  ...compact({ groupBy: query.groupBy }),
                },
                query.format,
              )
              .pipe(
                Effect.tap(
                  Effect.fn("Analytics.captureExport")(function* () {
                    if (caller._tag === "Member") {
                      yield* analytics.capture({
                        event: "report_exported",
                        userId: caller.userId,
                        workspaceId: params.workspaceId,
                        report: params.report,
                        format: query.format,
                      });
                    }
                  }),
                ),
              ),
            (file) => fileDownload(file),
          ),
        ),
      )
      .handle("fxRate", ({ params, query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          reports.fxRate(caller, { currency: params.currency, on: query.on }),
        ),
      )
      .handle("startExport", ({ headers }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          reports.startExport(caller, requestOptions(headers)),
        ),
      )
      .handle("getExport", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) => reports.getExport(caller, params.exportId)),
      )
      .handle("exportFile", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(reports.exportFile(caller, params.exportId), (file) => fileDownload(file)),
        ),
      );
  }),
);
