/**
 * Evaluation of `Query` over rows in memory, shared by the in-memory store and by in-memory
 * implementations of module repository operations.
 */

import * as EffectArray from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import type { Query, Row, Scalar } from "./tables";

/** Scalar order: null first, then booleans, numbers, strings (code-unit order, i.e. COLLATE "C"). */
export const compareScalar: {
  (b: Scalar | undefined): (a: Scalar | undefined) => number;
  (a: Scalar | undefined, b: Scalar | undefined): number;
} = Fn.dual(2, (a: Scalar | undefined, b: Scalar | undefined) => {
  const rank = (v: Scalar | undefined) =>
    v === null || v === undefined ? 0 : Predicate.isBoolean(v) ? 1 : Predicate.isNumber(v) ? 2 : 3;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a === b || a === null || a === undefined || b === null || b === undefined) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
});

const isScalar = <V>(value: V): value is V & Scalar =>
  value === null ||
  Predicate.isString(value) ||
  Predicate.isNumber(value) ||
  Predicate.isBoolean(value);

const field = (row: Row, name: string): Scalar | undefined => {
  if (!Predicate.hasProperty(row, name)) return undefined;
  const value = row[name];
  return isScalar(value) ? value : undefined;
};

export const matches: {
  <A extends Row>(query: Query<A>): (row: A) => boolean;
  <A extends Row>(row: A, query: Query<A>): boolean;
} = Fn.dual(2, <A extends Row>(row: A, query: Query<A>) => {
  for (const [name, value] of EffectRecord.toEntries<string, unknown>(query.where ?? {})) {
    if (isScalar(value) && compareScalar(field(row, name), value) !== 0) return false;
  }
  for (const [name, values] of EffectRecord.toEntries<string, readonly unknown[] | undefined>(
    query.whereIn ?? {},
  )) {
    if (values === undefined) continue;
    const v = field(row, name);
    if (
      !EffectArray.some(
        values,
        (x) => (x === undefined || isScalar(x)) && compareScalar(v, x) === 0,
      )
    )
      return false;
  }
  for (const [name, bounds] of EffectRecord.toEntries<
    string,
    { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown } | undefined
  >(query.range ?? {})) {
    if (bounds === undefined) continue;
    const v = field(row, name);
    if (v === null || v === undefined) return false;
    if (isScalar(bounds.gt) && compareScalar(v, bounds.gt) <= 0) return false;
    if (isScalar(bounds.gte) && compareScalar(v, bounds.gte) < 0) return false;
    if (isScalar(bounds.lt) && compareScalar(v, bounds.lt) >= 0) return false;
    if (isScalar(bounds.lte) && compareScalar(v, bounds.lte) > 0) return false;
  }
  return true;
});

export const runQuery: {
  <A extends Row>(rows: Iterable<A>, query?: Query<A>): ReadonlyArray<A>;
  <A extends Row>(query?: Query<A>): (rows: Iterable<A>) => ReadonlyArray<A>;
} = Fn.dual(
  (args) => Predicate.hasProperty(args[0], Symbol.iterator),
  <A extends Row>(rows: Iterable<A>, query: Query<A> = {}): ReadonlyArray<A> => {
    const keys: ReadonlyArray<string> = [...(query.orderBy ?? []), "id"];
    const sign = query.direction === "desc" ? -1 : 1;
    const tuple = (row: A) => EffectArray.map(keys, (k) => field(row, k));
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
    let result = EffectArray.filter([...rows], (row) => matches(row, query));
    result.sort((a, b) => compareTuples(tuple(a), tuple(b)));
    const after = query.after;
    if (after !== undefined)
      result = EffectArray.filter(result, (row) => compareTuples(tuple(row), after) > 0);
    return query.limit === undefined ? result : result.slice(0, query.limit);
  },
);
