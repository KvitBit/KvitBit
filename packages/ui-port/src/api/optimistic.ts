/**
 * Optimistic updates (ui-port-contracts section 2.11). The Model keeps the confirmed `base`, the
 * shown `value` and the pending ops (in apply order) with their before-image. The shown value is
 * always the base with every unresolved op replayed in apply order, so a later op on the same row
 * wins whatever order the server answers in. A confirmed op folds into the base only once every
 * earlier op has resolved; a rollback drops its op and replays the rest. Unknown or already
 * resolved `seq`s are ignored (T3).
 */
import * as Arr from "effect/Array";

interface PendingOp<S, Op> {
  readonly seq: number;
  /** What the op touches (an entity id), for the "Saving" marker. */
  readonly key: string;
  readonly op: Op;
  /** The shown value before this op was applied. */
  readonly before: S;
  /** The server accepted it, but an earlier op is still unresolved. */
  readonly confirmed: boolean;
}

interface Optimistic<S, Op> {
  readonly base: S;
  readonly value: S;
  readonly pending: ReadonlyArray<PendingOp<S, Op>>;
  readonly nextSeq: number;
}

export interface OptimisticOps<S, Op> {
  readonly init: (value: S) => Optimistic<S, Op>;
  /** Shows the op at once; send the request tagged with the returned `seq`. */
  readonly apply: (
    state: Optimistic<S, Op>,
    key: string,
    op: Op,
  ) => { readonly state: Optimistic<S, Op>; readonly seq: number };
  /** Server accepted the op; `serverOp` replaces it with the server's answer (e.g. the saved row). */
  readonly confirm: (state: Optimistic<S, Op>, seq: number, serverOp?: Op) => Optimistic<S, Op>;
  /** Server rejected the op: drop it and recompute the shown value. */
  readonly rollback: (state: Optimistic<S, Op>, seq: number) => Optimistic<S, Op>;
  /** True while an op on `key` is still waiting for the server. */
  readonly isPending: (state: Optimistic<S, Op>, key: string) => boolean;
  /** Replace the confirmed value (a reload), keeping unresolved ops on top. */
  readonly rebase: (state: Optimistic<S, Op>, base: S) => Optimistic<S, Op>;
}

const makeOptimistic = <S, Op>(step: (state: S, op: Op) => S): OptimisticOps<S, Op> => {
  const settle = (
    state: Optimistic<S, Op>,
    pendingIn: ReadonlyArray<PendingOp<S, Op>>,
  ): Optimistic<S, Op> => {
    let base = state.base;
    let pending = pendingIn;
    while (pending[0]?.confirmed === true) {
      base = step(base, pending[0].op);
      pending = pending.slice(1);
    }
    return {
      ...state,
      base,
      pending,
      value: Arr.reduce(pending, base, (acc, p) => step(acc, p.op)),
    };
  };
  return {
    init: (value) => ({ base: value, value, pending: [], nextSeq: 1 }),
    apply: (state, key, op) => {
      const seq = state.nextSeq;
      return {
        seq,
        state: {
          base: state.base,
          value: step(state.value, op),
          pending: [...state.pending, { seq, key, op, before: state.value, confirmed: false }],
          nextSeq: seq + 1,
        },
      };
    },
    confirm: (state, seq, serverOp) =>
      Arr.some(state.pending, (p) => p.seq === seq && !p.confirmed)
        ? settle(
            state,
            Arr.map(state.pending, (p) =>
              p.seq === seq ? { ...p, op: serverOp ?? p.op, confirmed: true } : p,
            ),
          )
        : state,
    rollback: (state, seq) =>
      Arr.some(state.pending, (p) => p.seq === seq && !p.confirmed)
        ? settle(
            state,
            Arr.filter(state.pending, (p) => p.seq !== seq),
          )
        : state,
    isPending: (state, key) => Arr.some(state.pending, (p) => p.key === key && !p.confirmed),
    rebase: (state, base) => settle({ ...state, base }, state.pending),
  };
};

/** List ops for the optimistic rows of section 2.11 (archive with Undo, lock badge flip). */
export type ListOp<A> =
  | { readonly _tag: "Remove"; readonly id: string }
  | { readonly _tag: "Replace"; readonly item: A };

const listStep =
  <A>(idOf: (item: A) => string) =>
  (items: ReadonlyArray<A>, op: ListOp<A>): ReadonlyArray<A> =>
    op._tag === "Remove"
      ? Arr.filter(items, (item) => idOf(item) !== op.id)
      : Arr.map(items, (item) => (idOf(item) === idOf(op.item) ? op.item : item));

/** Optimistic list: removal and replacement; rollback reinserts at the old index by replay. */
export const optimisticList = <A>(
  idOf: (item: A) => string,
): OptimisticOps<ReadonlyArray<A>, ListOp<A>> => makeOptimistic(listStep(idOf));
