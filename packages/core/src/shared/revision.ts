/** Optimistic revision check of rule C2, for methods that take `expectedRevision`. */

import { Conflict } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";

/**
 * Fails with `Conflict{revision_changed, currentRevision}` unless `row` is at `expectedRevision`.
 * Run it on the row from `getForUpdate`, then pass the row on to `update`.
 */
export const checkRevision: {
  (
    expectedRevision: number,
  ): <A extends { readonly revision: number }>(row: A) => Effect.Effect<A, Conflict>;
  <A extends { readonly revision: number }>(
    row: A,
    expectedRevision: number,
  ): Effect.Effect<A, Conflict>;
} = Fn.dual(2, <A extends { readonly revision: number }>(row: A, expectedRevision: number) =>
  row.revision === expectedRevision
    ? Effect.succeed(row)
    : Effect.fail(Conflict.make({ reason: "revision_changed", currentRevision: row.revision })),
);
