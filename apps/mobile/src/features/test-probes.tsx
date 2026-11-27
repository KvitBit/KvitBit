import type { WorkspaceId } from "@kvitbit/domain/contract";
import { Remote, type UiError } from "@kvitbit/ui-port/api";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type ApiRunner, useApi, useRemote } from "../runtime/api-runtime";
import { usePagedFeed } from "./dashboard/paged-feed";

export function TemplatesProbe(props: {
  readonly workspaceId: WorkspaceId;
  readonly onReady: (api: ApiRunner, count: number) => void;
}) {
  const api = useApi();
  const list = useRemote(
    (c) => c.templates.list({ params: { workspaceId: props.workspaceId } }),
    [],
  );
  if (list.state._tag === "Ready") props.onReady(api, list.state.value.length);
  return <span>{list.state._tag}</span>;
}

export function FeedProbe({ load }: { readonly load: () => Effect.Effect<string, UiError> }) {
  const { state, reload } = usePagedFeed(load);
  return (
    <button type="button" onClick={reload}>
      {Option.getOrElse(Remote.value(state), () => "")}
      {state._tag === "Failed" ? ` (${state.error._tag})` : ""}
    </button>
  );
}
