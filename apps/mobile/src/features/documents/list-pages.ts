import type { WorkspaceId } from "@kvitbit/domain/contract";
import { err, Paged, type PagedStep, Remote, UiError } from "@kvitbit/ui-port/api";
import type { DocumentListQuery } from "@kvitbit/ui-port/view-models";
import { Option } from "effect";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../runtime/api-runtime";
import { type DocumentSummaryView, parseDocumentSummary } from "./codecs";

type DocumentPageStep = PagedStep<DocumentSummaryView, DocumentListQuery>;
type ReportError = (error: UiError) => void;

export function useDocumentPages(workspaceId: WorkspaceId, query: DocumentListQuery) {
  const { run } = useApi();
  const scope = useMemo(
    () => ({
      run,
      workspaceId,
      initial: Paged.init<DocumentSummaryView, DocumentListQuery>(query),
    }),
    [run, workspaceId, query],
  );
  const [result, setResult] = useState(() => ({ scope, page: scope.initial.paged }));
  const actions = useRef<{ reload: () => void; loadMore: (reportError: ReportError) => void }>(
    null,
  );

  useLayoutEffect(() => {
    let active = true;
    let page = scope.initial.paged;
    const publish = (next: typeof page) => {
      page = next;
      setResult({ scope, page });
    };
    const request = async (step: DocumentPageStep, reportError?: ReportError) => {
      const { fetch } = step;
      if (fetch === null) return;
      if (step.paged !== page) publish(step.paged);

      const response = await scope
        .run((api) =>
          api.documents.list({ params: { workspaceId: scope.workspaceId }, query: fetch.query }),
        )
        .catch(() => err(UiError.unexpected()));
      if (!active || fetch.seq !== page.seq) return;

      const received = Paged.receive(
        page,
        fetch.seq,
        response._tag === "Err"
          ? response
          : {
              ...response,
              value: { ...response.value, items: response.value.items.map(parseDocumentSummary) },
            },
      );
      if (received.fetch !== null) {
        void request(received);
      } else if (reportError !== undefined && Option.isSome(received.paged.error)) {
        publish({ ...received.paged, status: "ready", error: Option.none() });
        reportError(received.paged.error.value);
      } else {
        publish(received.paged);
      }
    };

    actions.current = {
      reload: () => void request(Paged.refresh(page)),
      loadMore: (reportError) => void request(Paged.loadMore(page), reportError),
    };
    void request(scope.initial);
    return () => {
      active = false;
      actions.current = null;
    };
  }, [scope]);

  // A query change immediately hides the previous rows, even before the new request starts.
  const page = result.scope === scope ? result.page : scope.initial.paged;
  const state: Remote<ReadonlyArray<DocumentSummaryView>> =
    page.status === "loading"
      ? Remote.load<ReadonlyArray<DocumentSummaryView>, UiError>(Remote.idle)
      : Option.isSome(page.error)
        ? Remote.fail(
            page.items.length === 0 ? Remote.idle : Remote.ready(page.items),
            page.error.value,
          )
        : Remote.ready(page.items);

  return {
    state,
    refreshing: page.status === "refreshing",
    hasMore: page.status !== "failed" && Paged.hasMore(page),
    loadingMore: page.status === "loading_more",
    reload: () => actions.current?.reload(),
    loadMore: (reportError: ReportError) => actions.current?.loadMore(reportError),
  };
}
