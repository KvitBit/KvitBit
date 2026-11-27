/** `reports` group handlers (http-mcp-contracts 3.5.4): dashboard, reports, FX rates, exports. */
import { Api } from "@kvitbit/api-contract";
import { Reports } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { compact, fileDownload, requestOptions } from "../conventions";
import { jsonizeReport } from "./records/json";

export const ReportsGroupLive = HttpApiBuilder.group(
  Api,
  "reports",
  Effect.fnUntraced(function* (handlers) {
    const reports = yield* Reports;
    return handlers
      .handle("dashboard", ({ query }) => reports.dashboard({ from: query.from, to: query.to }))
      .handle("run", ({ params, query }) =>
        Effect.map(
          reports.run({
            report: params.report,
            period: { from: query.from, to: query.to },
            ...compact({ groupBy: query.groupBy }),
          }),
          jsonizeReport,
        ),
      )
      .handle("export", ({ params, query }) =>
        Effect.map(
          reports.export(
            {
              report: params.report,
              period: { from: query.from, to: query.to },
              ...compact({ groupBy: query.groupBy }),
            },
            query.format,
          ),
          (file) => fileDownload(file),
        ),
      )
      .handle("fxRate", ({ params, query }) =>
        reports.fxRate({ currency: params.currency, on: query.on }),
      )
      .handle("startExport", ({ headers }) => reports.startExport(requestOptions(headers)))
      .handle("getExport", ({ params }) => reports.getExport(params.exportId))
      .handle("exportFile", ({ params }) =>
        Effect.map(reports.exportFile(params.exportId), (file) => fileDownload(file)),
      );
  }),
);
