/** Optimistic revision check of rule C2, for methods that take `expectedRevision`. */
import { Conflict } from "@kvitbit/domain/contract";
import { Effect } from "effect";

/**
 * Fails with `Conflict{revision_changed, currentRevision}` unless `row` is at `expectedRevision`.
 * Run it on the row from `getForUpdate`, then pass the row on to `update`.
 */
export const checkRevision = <A extends { readonly revision: number }>(
  row: A,
  expectedRevision: number,
): Effect.Effect<A, Conflict> =>
  row.revision === expectedRevision
    ? Effect.succeed(row)
    : Effect.fail(new Conflict({ reason: "revision_changed", currentRevision: row.revision }));
