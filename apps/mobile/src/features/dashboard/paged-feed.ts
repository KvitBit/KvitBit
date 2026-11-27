import type { Page } from "@kvitbit/domain/contract";
import {
  DEFAULT_TIMEOUT,
  fromCause,
  type KvitbitApiClient,
  type Remote,
  Remote as RemoteOps,
  UiError,
} from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../runtime/api-runtime";
import { runFeatureCallback } from "../ui-effect";

// A scan may take longer than a single request. Time out each read independently.
export const feedRequest = Effect.timeout(DEFAULT_TIMEOUT);

export const scanFeedPages = Effect.fn("scanFeedPages")(function* <A, E, F>({
  fetchPage,
  visit,
}: {
  readonly fetchPage: (cursor: string | null) => Effect.Effect<Page<A>, E>;
  readonly visit: (items: ReadonlyArray<A>) => Effect.Effect<boolean, F>;
}) {
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: Page<A> = yield* feedRequest(fetchPage(cursor));
    if ((yield* visit(page.items)) === false) return;
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) return yield* Effect.fail(UiError.unexpected());
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
});

export function usePagedFeed<A, E>(load: ((api: KvitbitApiClient) => Effect.Effect<A, E>) | null) {
  const { run } = useApi();
  const [state, setState] = useState<Remote<A>>(RemoteOps.idle);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((current) => current + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision restarts the scan on refresh.
  useEffect(() => {
    if (load === null) return;
    let cancelled = false;
    setState((current) => RemoteOps.load(current));

    const scan = Effect.gen(function* () {
      const client = yield* Effect.promise(() => run(Effect.succeed));
      if (client._tag === "Err") return yield* Effect.fail(client.error);
      return yield* load(client.value);
    });
    const interrupt = runFeatureCallback({
      effect: scan,
      onExit: (exit) => {
        if (cancelled) return;
        setState((current) =>
          Exit.isSuccess(exit)
            ? RemoteOps.ready(exit.value)
            : RemoteOps.fail(current, fromCause(exit.cause)),
        );
      },
    });

    return () => {
      cancelled = true;
      interrupt();
    };
  }, [load, revision, run]);

  return { state, reload };
}
