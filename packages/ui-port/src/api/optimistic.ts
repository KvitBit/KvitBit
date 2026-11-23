/**
 * Optimistic updates (ui-port-contracts section 2.11). The Model keeps the confirmed `base`, the
 * shown `value` and the pending ops with their before-image; confirm and rollback are pure
 * transitions that replay the remaining pending ops over the base, so out-of-order answers and a
 * rollback under later ops keep every other pending change. Unknown `seq`s are ignored (T3).
 */
export interface PendingOp<S, Op> {
  readonly seq: number;
  /** What the op touches (an entity id), for the "Saving" marker. */
  readonly key: string;
  readonly op: Op;
  /** The shown value before this op was applied. */
  readonly before: S;
}

export interface Optimistic<S, Op> {
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
  /** Server accepted the op; `reconcile` folds in the server's answer (e.g. a new revision). */
  readonly confirm: (
    state: Optimistic<S, Op>,
    seq: number,
    reconcile?: (base: S) => S,
  ) => Optimistic<S, Op>;
  /** Server rejected the op: drop it and recompute the shown value. */
  readonly rollback: (state: Optimistic<S, Op>, seq: number) => Optimistic<S, Op>;
  readonly isPending: (state: Optimistic<S, Op>, key: string) => boolean;
  /** Replace the confirmed value (a reload), keeping pending ops on top. */
  readonly rebase: (state: Optimistic<S, Op>, base: S) => Optimistic<S, Op>;
}

export const makeOptimistic = <S, Op>(step: (state: S, op: Op) => S): OptimisticOps<S, Op> => {
  const replay = (base: S, pending: ReadonlyArray<PendingOp<S, Op>>): S =>
    pending.reduce((acc, p) => step(acc, p.op), base);
  return {
    init: (value) => ({ base: value, value, pending: [], nextSeq: 1 }),
    apply: (state, key, op) => {
      const seq = state.nextSeq;
      return {
        seq,
        state: {
          base: state.base,
          value: step(state.value, op),
          pending: [...state.pending, { seq, key, op, before: state.value }],
          nextSeq: seq + 1,
        },
      };
    },
    confirm: (state, seq, reconcile) => {
      const done = state.pending.find((p) => p.seq === seq);
      if (done === undefined) return state;
      const applied = step(state.base, done.op);
      const base = reconcile ? reconcile(applied) : applied;
      const pending = state.pending.filter((p) => p.seq !== seq);
      return { ...state, base, pending, value: replay(base, pending) };
    },
    rollback: (state, seq) => {
      if (!state.pending.some((p) => p.seq === seq)) return state;
      const pending = state.pending.filter((p) => p.seq !== seq);
      return { ...state, pending, value: replay(state.base, pending) };
    },
    isPending: (state, key) => state.pending.some((p) => p.key === key),
    rebase: (state, base) => ({ ...state, base, value: replay(base, state.pending) }),
  };
};

/** List ops for the optimistic rows of section 2.11 (archive with Undo, lock badge flip). */
export type ListOp<A> =
  | { readonly _tag: "Remove"; readonly id: string }
  | { readonly _tag: "Replace"; readonly item: A };

export const listStep =
  <A>(idOf: (item: A) => string) =>
  (items: ReadonlyArray<A>, op: ListOp<A>): ReadonlyArray<A> =>
    op._tag === "Remove"
      ? items.filter((item) => idOf(item) !== op.id)
      : items.map((item) => (idOf(item) === idOf(op.item) ? op.item : item));

/** Optimistic list: removal and replacement; rollback reinserts at the old index by replay. */
export const optimisticList = <A>(
  idOf: (item: A) => string,
): OptimisticOps<ReadonlyArray<A>, ListOp<A>> => makeOptimistic(listStep(idOf));
