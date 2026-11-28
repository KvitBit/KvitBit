import { IsoDate, type WorkspaceId } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { useCallback } from "react";
import { useTransfer } from "../../platform/transfer";
import { type ApiRunner, useApi, useRemote } from "../../runtime/api-runtime";
import { decodeReportView } from "./model";

export function ReportsProbe(props: {
  readonly workspaceId: WorkspaceId;
  readonly onReady: (
    api: ApiRunner,
    transfer: ReturnType<typeof useTransfer>,
    vatLoaded: boolean,
  ) => void;
}) {
  const api = useApi();
  const transfer = useTransfer();
  const vat = useRemote(
    useCallback(
      (c: KvitbitApiClient) =>
        c.reports.run({
          params: { workspaceId: props.workspaceId, report: "vat_summary" },
          query: { from: IsoDate.make("2026-11-01"), to: IsoDate.make("2026-11-30") },
        }),
      [props.workspaceId],
    ),
  );
  if (vat.state._tag === "Ready") {
    const decoded = decodeReportView(vat.state.value, "vat_summary");
    props.onReady(
      api,
      transfer,
      decoded.report === "vat_summary" && decoded.totals.payable.amount === "1600.00",
    );
  }
  return <span>{vat.state._tag}</span>;
}
