/**
 * Gapless number allocation (rule S3). Call inside the issue transaction after locking the
 * document (lock order S4: documents, then counters): it locks the counter, skips numbers that
 * are already reserved (overrides, rule D4), reserves the number and advances the counter; a
 * rollback reverts all of it.
 */
import type {
  DocumentId,
  DocumentKind,
  NumberingSeriesId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Effect } from "effect";
import type { StoreUnavailable } from "./CoreStore";
import { CoreStore } from "./CoreStore";

/** Hard stop for a corrupt series whose every candidate is reserved. */
const MAX_SKIPS = 10_000;

export const allocateNumber = (input: {
  readonly workspaceId: WorkspaceId;
  readonly seriesId: NumberingSeriesId;
  readonly period: string;
  readonly kind: DocumentKind;
  readonly documentId: DocumentId;
  /** Formats a sequence number (e.g. `Numbering.format`). */
  readonly format: (sequence: number) => string;
}): Effect.Effect<
  { readonly sequence: number; readonly number: string },
  StoreUnavailable,
  CoreStore
> =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const counter = {
      workspaceId: input.workspaceId,
      seriesId: input.seriesId,
      period: input.period,
    };
    const first = yield* store.counters.lock(counter);
    for (let sequence = first; sequence < first + MAX_SKIPS; sequence++) {
      const number = input.format(sequence);
      const reserved = yield* store.reservations.tryReserve({
        workspaceId: input.workspaceId,
        kind: input.kind,
        number,
        seriesId: input.seriesId,
        documentId: input.documentId,
      });
      if (reserved) {
        yield* store.counters.set(counter, sequence + 1);
        return { sequence, number };
      }
    }
    return yield* Effect.die(new Error(`allocateNumber: ${MAX_SKIPS} reserved numbers in a row`));
  });

/**
 * Reserves a manually chosen number (override, rule D4). `false` when the number is taken; the
 * module maps that to `Conflict{duplicate}`.
 */
export const reserveNumber = (reservation: {
  readonly workspaceId: WorkspaceId;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly seriesId: NumberingSeriesId | null;
  readonly documentId: DocumentId;
}): Effect.Effect<boolean, StoreUnavailable, CoreStore> =>
  Effect.flatMap(CoreStore, (store) => store.reservations.tryReserve(reservation));
