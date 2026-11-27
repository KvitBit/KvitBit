/**
 * List query builders (AG-UI-1): `cursor` plus `limit` (1 to 100, ui-port asks for 50) merged with
 * the list's own filters. A cursor is bound to the filters it came from, so filters are compared by
 * a stable hash and any change restarts from the first page.
 */

import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { stringifyJson } from "../json";

export { PAGE_LIMIT_DEFAULT as PAGE_LIMIT } from "@kvitbit/api-contract";

/** Paging fields belong to the page request, never to the filters. */
const PAGING_KEYS = new Set(["cursor", "limit"]);

/**
 * Filters with empty values and paging fields removed: `undefined`, `null` and blank strings mean
 * "no filter"; `cursor` and `limit` come only from the page request.
 */
/** Filters after cleaning: every key may be absent at runtime, and none is null or a paging field. */
export type CleanFilters<F> = {
  readonly [K in Exclude<keyof F, "cursor" | "limit">]?: Exclude<F[K], null | undefined>;
};

export const cleanFilters = <F extends object>(filters: F): CleanFilters<F> => {
  // biome-ignore lint/plugin/no-unsafe-dictionary-type: Filter values can have any type and keys are enumerated at runtime.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Rec.toEntries(filters)) {
    if (PAGING_KEYS.has(key) || value === undefined || value === null) continue;
    if (Predicate.isString(value) && Str.trim(value) === "") continue;
    out[key] = value;
  }
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: The loop copies only values from F and skips nullish and paging keys.
  // biome-ignore lint/plugin/no-widen-then-assert: The loop retains each copied key's value type.
  return out as CleanFilters<F>;
};

/** Stable identity of a filter set (key order and empty values do not matter). */
// biome-ignore lint/plugin/no-object-parameters: Filters belong to the caller and have no shared shape.
export const filterHash = (filters: object): string => {
  // biome-ignore lint/plugin/no-unsafe-dictionary-type: The hash consumes arbitrary filter values as JSON.
  const clean: Readonly<Record<string, unknown>> = cleanFilters(filters);
  return stringifyJson(Arr.map(Rec.keys(clean).sort(Order.String), (key) => [key, clean[key]]));
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
