/**
 * Evaluation of `Query` over rows in memory, shared by the in-memory store and by in-memory
 * implementations of module repository operations.
 */
import type { Query, Row, Scalar } from "./tables";

/** Scalar order: null first, then booleans, numbers, strings (code-unit order, i.e. COLLATE "C"). */
export const compareScalar = (a: Scalar | undefined, b: Scalar | undefined): number => {
  const rank = (v: Scalar | undefined) =>
    v === null || v === undefined ? 0 : typeof v === "boolean" ? 1 : typeof v === "number" ? 2 : 3;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a === b || a === null || a === undefined || b === null || b === undefined) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
};

export const field = (row: Row, name: string): Scalar | undefined =>
  (row as unknown as Record<string, Scalar | undefined>)[name];

export const matches = <A extends Row>(row: A, query: Query<A>): boolean => {
  for (const [name, value] of Object.entries(query.where ?? {})) {
    if (value !== undefined && compareScalar(field(row, name), value as Scalar) !== 0) return false;
  }
  for (const [name, values] of Object.entries(query.whereIn ?? {})) {
    if (values === undefined) continue;
    const v = field(row, name);
    if (!(values as ReadonlyArray<Scalar>).some((x) => compareScalar(v, x) === 0)) return false;
  }
  for (const [name, bounds] of Object.entries(query.range ?? {})) {
    if (bounds === undefined) continue;
    const v = field(row, name);
    if (v === null || v === undefined) return false;
    const b = bounds as { gt?: Scalar; gte?: Scalar; lt?: Scalar; lte?: Scalar };
    if (b.gt !== undefined && !(compareScalar(v, b.gt) > 0)) return false;
    if (b.gte !== undefined && !(compareScalar(v, b.gte) >= 0)) return false;
    if (b.lt !== undefined && !(compareScalar(v, b.lt) < 0)) return false;
    if (b.lte !== undefined && !(compareScalar(v, b.lte) <= 0)) return false;
  }
  return true;
};

export const runQuery = <A extends Row>(
  rows: Iterable<A>,
  query: Query<A> = {},
): ReadonlyArray<A> => {
  const keys: ReadonlyArray<string> = [...(query.orderBy ?? []), "id"];
  const sign = query.direction === "desc" ? -1 : 1;
  const tuple = (row: A) => keys.map((k) => field(row, k));
  const compareTuples = (
    a: ReadonlyArray<Scalar | undefined>,
    b: ReadonlyArray<Scalar | undefined>,
  ) => {
    for (let i = 0; i < keys.length; i++) {
      const c = compareScalar(a[i], b[i]);
      if (c !== 0) return c * sign;
    }
    return 0;
  };
  let result = [...rows].filter((row) => matches(row, query));
  result.sort((a, b) => compareTuples(tuple(a), tuple(b)));
  const after = query.after;
  if (after !== undefined) result = result.filter((row) => compareTuples(tuple(row), after) > 0);
  return query.limit === undefined ? result : result.slice(0, query.limit);
};
