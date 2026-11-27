import type { WorkspaceId } from "@kvitbit/domain/contract";
import { err, Paged, type PagedStep, Remote, UiError } from "@kvitbit/ui-port/api";
import type { DocumentListQuery } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../runtime/api-runtime";
import { fromMobilePromise } from "../../runtime/request-intent";
import { runFeatureEffect } from "../ui-effect";
import { type DocumentSummaryView, parseDocumentSummary } from "./codecs";

type DocumentPageStep = PagedStep<DocumentSummaryView, DocumentListQuery>;
type ReportError = (error: UiError) => void;

interface PageActions {
  readonly reload: () => void;
  readonly loadMore: (reportError: ReportError) => void;
}

const idlePageActions: PageActions = {
  reload: () => undefined,
  loadMore: () => undefined,
};

export function useDocumentPages({
  workspaceId,
  query,
}: {
  readonly workspaceId: WorkspaceId;
  readonly query: DocumentListQuery;
}) {
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
  const actions = useRef(idlePageActions);

  useLayoutEffect(() => {
    let active = true;
    let page = scope.initial.paged;
    const publish = (next: typeof page) => {
      page = next;
      setResult({ scope, page });
    };
    const request = Effect.fn("request")(function* (
      step: DocumentPageStep,
      reportError?: ReportError,
    ): Effect.fn.Return<void> {
      const { fetch } = step;
      if (fetch === null) return;
      if (step.paged !== page) publish(step.paged);

      const response = yield* fromMobilePromise(() =>
        scope.run((api) =>
          api.documents.list({ params: { workspaceId: scope.workspaceId }, query: fetch.query }),
        ),
      ).pipe(Effect.orElseSucceed(() => err(UiError.unexpected())));
      if (!active || fetch.seq !== page.seq) return;

      const received = Paged.receive(
        page,
        fetch.seq,
        response._tag === "Err"
          ? response
          : {
              ...response,
              value: {
                ...response.value,
                items: Arr.map(response.value.items, parseDocumentSummary),
              },
            },
      );
      if (received.fetch !== null) {
        yield* request(received);
      } else if (reportError !== undefined && Option.isSome(received.paged.error)) {
        publish({ ...received.paged, status: "ready", error: Option.none() });
        reportError(received.paged.error.value);
      } else {
        publish(received.paged);
      }
    });

    actions.current = {
      reload: () => {
        runFeatureEffect(request(Paged.refresh(page)));
      },
      loadMore: (reportError) => {
        runFeatureEffect(request(Paged.loadMore(page), reportError));
      },
    };
    runFeatureEffect(request(scope.initial));
    return () => {
      active = false;
      actions.current = idlePageActions;
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
    reload: () => actions.current.reload(),
    loadMore: (reportError: ReportError) => actions.current.loadMore(reportError),
  };
}
