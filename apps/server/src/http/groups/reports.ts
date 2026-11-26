/** `reports` group handlers (http-mcp-contracts 3.5.4): dashboard, reports, FX rates, exports. */
import { Api } from "@kvitbit/api-contract";
import { Reports } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { fileDownload, requestOptions } from "../conventions";
import { jsonSafe } from "./records/json";

export const ReportsGroupLive = HttpApiBuilder.group(Api, "reports", (handlers) =>
  Effect.gen(function* () {
    const reports = yield* Reports;
    return handlers
      .handle("dashboard", ({ query }) => reports.dashboard({ from: query.from, to: query.to }))
      .handle("run", ({ params, query }) =>
        Effect.map(
          reports.run({
            report: params.report,
            period: { from: query.from, to: query.to },
            ...(query.groupBy === undefined ? {} : { groupBy: query.groupBy }),
          }),
          jsonSafe,
        ),
      )
      .handle("export", ({ params, query }) =>
        Effect.map(
          reports.export(
            {
              report: params.report,
              period: { from: query.from, to: query.to },
              ...(query.groupBy === undefined ? {} : { groupBy: query.groupBy }),
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
