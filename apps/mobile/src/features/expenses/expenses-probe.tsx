import type { WorkspaceId } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { useCallback } from "react";
import { useTransfer } from "../../platform/transfer";
import { type ApiRunner, useApi, useRemote } from "../../runtime/api-runtime";

export function ExpensesProbe(props: {
  readonly workspaceId: WorkspaceId;
  readonly onReady: (
    api: ApiRunner,
    transfer: ReturnType<typeof useTransfer>,
    count: number,
  ) => void;
}) {
  const api = useApi();
  const transfer = useTransfer();
  const list = useRemote(
    useCallback(
      (client: KvitbitApiClient) =>
        client.expenses.list({ params: { workspaceId: props.workspaceId }, query: {} }),
      [props.workspaceId],
    ),
  );
  if (list.state._tag === "Ready") {
    props.onReady(api, transfer, list.state.value.items.length);
  }
  return <span>{list.state._tag}</span>;
}
