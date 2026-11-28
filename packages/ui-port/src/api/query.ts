/**
 * List query builders (AG-UI-1): `cursor` plus `limit` (1 to 100, ui-port asks for 50) merged with
 * the list's own filters. A cursor is bound to the filters it came from, so filters are compared by
 * a stable hash and any change restarts from the first page.
 */

import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@kvitbit/api-contract";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { stringifyJson } from "../json";

export { PAGE_LIMIT_DEFAULT as PAGE_LIMIT } from "@kvitbit/api-contract";

type PagingKey = "cursor" | "limit";
const isFilterKey = <K extends string>(key: K): key is Exclude<K, PagingKey> =>
  key !== "cursor" && key !== "limit";

type FilterFields<F> = { [K in Exclude<keyof F, PagingKey>]?: NonNullable<F[K]> };

/** Filters with empty values and paging fields removed. */
export type CleanFilters<F> = Readonly<FilterFields<F>>;

export const cleanFilters = <F extends object>(filters: F): CleanFilters<F> => {
  type Key = Extract<keyof F, string>;
  const clean: FilterFields<F> = {};
  for (const key of Rec.keys<Key, F[Key]>(filters)) {
    if (!isFilterKey(key) || key === "__proto__") continue;
    const value = filters[key];
    if (value === undefined || value === null) continue;
    if (Predicate.isString(value) && Str.trim(value) === "") continue;
    clean[key] = value;
  }
  return clean;
};

/** Stable identity of a filter set (key order and empty values do not matter). */
export const filterHash = <F extends object>(filters: F): string => {
  const entries = Rec.toEntries(cleanFilters(filters));
  return stringifyJson(entries.sort(([first], [second]) => Order.String(first, second)));
};

const clampLimit = (limit: number): number =>
  Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.trunc(limit)));

/** The query of one page request: cleaned filters, the cursor when continuing, and the limit. */
export const pageQuery: {
  (cursor?: string | null, limit?: number): <F extends object>(filters: F) => PageQuery<F>;
  <F extends object>(filters: F, cursor?: string | null, limit?: number): PageQuery<F>;
} = Fn.dual(
  (args) => Predicate.isNotNullish(args[0]) && !Predicate.isString(args[0]),
  <F extends object>(
    filters: F,
    cursor: string | null = null,
    limit: number = PAGE_LIMIT_DEFAULT,
  ): PageQuery<F> => {
    const base = { ...cleanFilters(filters), limit: clampLimit(limit) };
    return cursor === null ? base : { ...base, cursor };
  },
);

export type PageQuery<F> = CleanFilters<F> & { readonly limit: number; readonly cursor?: string };
