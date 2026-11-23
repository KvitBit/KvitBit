/**
 * Remote data and paged lists (ui-port-contracts section 2.4). Every transition is pure; paged
 * transitions also return the page fetch to issue, tagged with `seq` so results of an older query
 * are ignored (T3).
 */
import type { Page } from "@kvitbit/domain/contract";
import { Option } from "effect";
import { isCursorMismatch, type UiError } from "./errors";
import { filterHash, PAGE_LIMIT, pageQuery } from "./query";
import type { ApiResult } from "./result";

// --- Remote -------------------------------------------------------------------------------------

export type Remote<A, E = UiError> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly stale: Option.Option<A> }
  | { readonly _tag: "Ready"; readonly value: A; readonly refreshing: boolean }
  | { readonly _tag: "Failed"; readonly error: E; readonly stale: Option.Option<A> };

export const idle: Remote<never, never> = { _tag: "Idle" };
const ready = <A>(value: A): Remote<A, never> => ({ _tag: "Ready", value, refreshing: false });

/** Latest known value, ready or stale. */
const value = <A, E>(remote: Remote<A, E>): Option.Option<A> => {
  switch (remote._tag) {
    case "Idle":
      return Option.none();
    case "Ready":
      return Option.some(remote.value);
    default:
      return remote.stale;
  }
};

/** Start a (re)load: a Ready value stays visible as `refreshing`; otherwise it becomes stale. */
const load = <A, E>(remote: Remote<A, E>): Remote<A, E> =>
  remote._tag === "Ready"
    ? { ...remote, refreshing: true }
    : { _tag: "Loading", stale: value(remote) };

const succeed = <A, E>(_remote: Remote<A, E>, next: A): Remote<A, E> => ready(next);

const fail = <A, E>(remote: Remote<A, E>, error: E): Remote<A, E> => ({
  _tag: "Failed",
  error,
  stale: value(remote),
});

const fromResult = <A>(remote: Remote<A>, result: ApiResult<A>): Remote<A> =>
  result._tag === "Ok" ? ready(result.value) : fail(remote, result.error);

const isBusy = <A, E>(remote: Remote<A, E>): boolean =>
  remote._tag === "Loading" || (remote._tag === "Ready" && remote.refreshing);

// --- Paged --------------------------------------------------------------------------------------

export type PagedStatus = "loading" | "ready" | "loading_more" | "refreshing" | "failed";

export interface Paged<A, Q> {
  readonly query: Q;
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | null;
  readonly status: PagedStatus;
  readonly error: Option.Option<UiError>;
  readonly seq: number;
}

/** A page request to send; the result goes back through `receive` with the same `seq`. */
export interface PageFetch<Q> {
  readonly seq: number;
  readonly query: Q & { readonly limit: number; readonly cursor?: string };
}

export interface PagedStep<A, Q> {
  readonly paged: Paged<A, Q>;
  readonly fetch: PageFetch<Q> | null;
}

const fetchOf = <A, Q extends object>(
  paged: Paged<A, Q>,
  cursor: string | null,
  limit: number,
): PageFetch<Q> => ({ seq: paged.seq, query: pageQuery(paged.query, cursor, limit) });

const firstPage = <A, Q extends object>(
  paged: Paged<A, Q>,
  status: "loading" | "refreshing",
  limit: number,
): PagedStep<A, Q> => {
  const next: Paged<A, Q> = {
    ...paged,
    items: status === "loading" ? [] : paged.items,
    nextCursor: null,
    status,
    error: Option.none(),
    seq: paged.seq + 1,
  };
  return { paged: next, fetch: fetchOf(next, null, limit) };
};

const init = <A, Q extends object>(query: Q, limit = PAGE_LIMIT): PagedStep<A, Q> =>
  firstPage<A, Q>(
    { query, items: [], nextCursor: null, status: "loading", error: Option.none(), seq: 0 },
    "loading",
    limit,
  );

/** New filters: unchanged (by hash) is a no-op; otherwise drop items and cursor, reload. */
const setQuery = <A, Q extends object>(
  paged: Paged<A, Q>,
  query: Q,
  limit = PAGE_LIMIT,
): PagedStep<A, Q> =>
  filterHash(query) === filterHash(paged.query)
    ? { paged, fetch: null }
    : firstPage({ ...paged, query }, "loading", limit);

/** Pull to refresh / Retry: reload from the first page, keeping rows visible meanwhile. */
const refresh = <A, Q extends object>(paged: Paged<A, Q>, limit = PAGE_LIMIT): PagedStep<A, Q> =>
  firstPage(paged, paged.items.length === 0 ? "loading" : "refreshing", limit);

/** Next page, only from a ready list that has one. */
const loadMore = <A, Q extends object>(paged: Paged<A, Q>, limit = PAGE_LIMIT): PagedStep<A, Q> => {
  if (paged.status !== "ready" || paged.nextCursor === null) return { paged, fetch: null };
  const next: Paged<A, Q> = { ...paged, status: "loading_more", seq: paged.seq + 1 };
  return { paged: next, fetch: fetchOf(next, paged.nextCursor, limit) };
};

/**
 * Apply a page result. A result for an older `seq` is ignored. `Invalid{page.cursor_mismatch}`
 * means the list is stale: drop the cursor and reload from the first page without an error.
 */
const receive = <A, Q extends object>(
  paged: Paged<A, Q>,
  seq: number,
  result: ApiResult<Page<A>>,
  limit = PAGE_LIMIT,
): PagedStep<A, Q> => {
  if (seq !== paged.seq) return { paged, fetch: null };
  if (result._tag === "Ok") {
    const items =
      paged.status === "loading_more"
        ? [...paged.items, ...result.value.items]
        : result.value.items;
    return {
      paged: {
        ...paged,
        items,
        nextCursor: result.value.nextCursor,
        status: "ready",
        error: Option.none(),
      },
      fetch: null,
    };
  }
  if (result.error._tag === "Cancelled") {
    // Not superseded (same seq) but abandoned: leave the busy state so the list is usable again.
    return paged.status === "loading"
      ? { paged: { ...paged, status: "failed", error: Option.some(result.error) }, fetch: null }
      : { paged: { ...paged, status: "ready" }, fetch: null };
  }
  if (isCursorMismatch(result.error)) return firstPage(paged, "loading", limit);
  return { paged: { ...paged, status: "failed", error: Option.some(result.error) }, fetch: null };
};

const hasMore = <A, Q>(paged: Paged<A, Q>): boolean => paged.nextCursor !== null;

export const Remote = { idle, ready, value, load, succeed, fail, fromResult, isBusy } as const;

export const Paged = { init, setQuery, refresh, loadMore, receive, hasMore } as const;
