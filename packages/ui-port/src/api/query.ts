/**
 * List query builders (AG-UI-1): `cursor` plus `limit` (1 to 100, ui-port asks for 50) merged with
 * the list's own filters. A cursor is bound to the filters it came from, so filters are compared by
 * a stable hash and any change restarts from the first page.
 */
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@kvitbit/api-contract";

export const PAGE_LIMIT = PAGE_LIMIT_DEFAULT;

export type FilterValue = string | number | boolean | null | undefined;

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
  const out: Record<string, FilterValue> = {};
  for (const [key, value] of Object.entries(filters) as Array<[string, FilterValue]>) {
    if (PAGING_KEYS.has(key) || value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out as CleanFilters<F>;
};

/** Stable identity of a filter set (key order and empty values do not matter). */
export const filterHash = (filters: object): string => {
  const clean = cleanFilters(filters) as Record<string, FilterValue>;
  return JSON.stringify(
    Object.keys(clean)
      .sort()
      .map((key) => [key, clean[key]]),
  );
};

export const clampLimit = (limit: number): number =>
  Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.trunc(limit)));

/** The query of one page request: cleaned filters, the cursor when continuing, and the limit. */
export const pageQuery = <F extends object>(
  filters: F,
  cursor: string | null = null,
  limit: number = PAGE_LIMIT,
): PageQuery<F> => {
  const base = { ...cleanFilters(filters), limit: clampLimit(limit) };
  return (cursor === null ? base : { ...base, cursor }) as PageQuery<F>;
};

export type PageQuery<F> = CleanFilters<F> & { readonly limit: number; readonly cursor?: string };
