/**
 * Remote data with sequence guards (ui-port-contracts 2.4, ADR-0005 Tier 2).
 *
 * Every load bumps `seq` in the Model and stamps the Command with it; a reply whose `seq` is not the
 * current one is stale (superseded by a newer load, a route change or a refresh) and is dropped, so
 * an out-of-order response can never overwrite newer data.
 */
import { Schema } from "effect";
import { Failure } from "./api";

export const Seq = Schema.Int;
export type Seq = number;

export const remoteSchema = <A extends Schema.Top>(data: A) =>
  Schema.Union([
    Schema.TaggedStruct("Idle", {}),
    Schema.TaggedStruct("Loading", { seq: Seq }),
    Schema.TaggedStruct("Loaded", { seq: Seq, data }),
    Schema.TaggedStruct("Refreshing", { seq: Seq, data }),
    Schema.TaggedStruct("Failed", { seq: Seq, failure: Failure }),
  ]);

export type Remote<A> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly seq: Seq }
  | { readonly _tag: "Loaded"; readonly seq: Seq; readonly data: A }
  | { readonly _tag: "Refreshing"; readonly seq: Seq; readonly data: A }
  | { readonly _tag: "Failed"; readonly seq: Seq; readonly failure: Failure };

export const idle: Remote<never> = { _tag: "Idle" };

export const seqOf = (r: Remote<unknown>): Seq => (r._tag === "Idle" ? 0 : r.seq);

/** Next load: keeps shown data while refreshing (zero-CLS), else shows the skeleton. */
export const load = <A>(r: Remote<A>): Remote<A> => {
  const seq = seqOf(r) + 1;
  return r._tag === "Loaded" || r._tag === "Refreshing"
    ? { _tag: "Refreshing", seq, data: r.data }
    : { _tag: "Loading", seq };
};

const isCurrent = (r: Remote<unknown>, seq: Seq): boolean =>
  (r._tag === "Loading" || r._tag === "Refreshing") && r.seq === seq;

/** Applies a success reply only when it answers the in-flight load. */
export const succeed = <A>(r: Remote<A>, seq: Seq, data: A): Remote<A> =>
  isCurrent(r, seq) ? { _tag: "Loaded", seq, data } : r;

/** Applies a failure reply only when it answers the in-flight load. */
export const fail = <A>(r: Remote<A>, seq: Seq, failure: Failure): Remote<A> =>
  isCurrent(r, seq) ? { _tag: "Failed", seq, failure } : r;

export const dataOf = <A>(r: Remote<A>): A | undefined =>
  r._tag === "Loaded" || r._tag === "Refreshing" ? r.data : undefined;

export const isPending = (r: Remote<unknown>): boolean =>
  r._tag === "Loading" || r._tag === "Refreshing";
