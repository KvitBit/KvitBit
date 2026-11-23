import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { NumberingExhausted, NumberTaken, RowNotFound } from "./errors";
import type { DocumentKind } from "./tables";

/** Runs `self` in a transaction, or in a savepoint when the caller already opened one. */
const withSavepoint = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(self);
  });

/** What the formatter sees for one candidate number. */
export interface NumberCandidate {
  /** `numbering_series.pattern`. */
  readonly pattern: string;
  /** Counter period key: `YYYY`, `YYYY-MM` or `all`. */
  readonly period: string;
  readonly counter: number;
}

export interface AllocateNumberInput {
  readonly workspaceId: string;
  readonly seriesId: string;
  readonly period: string;
  /** Pure formatter, normally core's `Numbering.format`. */
  readonly format: (candidate: NumberCandidate) => string;
  /** Document the number is issued to; it must exist in the same Workspace. */
  readonly documentId?: string;
  /** Reserved candidates to skip before failing with `NumberingExhausted`. Default 1000. */
  readonly maxSkips?: number;
}

export interface AllocatedNumber {
  readonly number: string;
  readonly counter: number;
  readonly kind: DocumentKind;
}

/**
 * Allocates the next number of a series and period (core-ports.md S3): upserts and locks
 * `numbering_counters(series_id, period)` with `FOR UPDATE`, formats candidates from the counter,
 * skips numbers already in `number_reservations`, reserves the first free one and moves the
 * counter past it.
 *
 * Run it inside the issue transaction, after locking the document (S4). It opens a savepoint of
 * its own, so a failure leaves nothing behind, and a rollback of the caller's transaction reverts
 * counter and reservation together: allocation never leaves a gap. The counter lock serializes
 * concurrent issuers of the same series and period until the caller commits.
 */
export const allocateNumber = (
  input: AllocateNumberInput,
): Effect.Effect<
  AllocatedNumber,
  RowNotFound | NumberingExhausted | SqlError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { workspaceId, seriesId, period } = input;
    const maxSkips = input.maxSkips ?? 1000;

    const series = yield* sql<{ readonly kind: DocumentKind; readonly pattern: string }>`
      select kind, pattern from numbering_series
      where workspace_id = ${workspaceId} and id = ${seriesId}`;
    const found = series[0];
    if (found === undefined) {
      return yield* new RowNotFound({ table: "numbering_series", workspaceId, id: seriesId });
    }

    yield* sql`
      insert into numbering_counters (workspace_id, series_id, period)
      values (${workspaceId}, ${seriesId}, ${period})
      on conflict (series_id, period) do nothing`;
    const counters = yield* sql<{ readonly next_counter: number }>`
      select next_counter from numbering_counters
      where workspace_id = ${workspaceId} and series_id = ${seriesId} and period = ${period}
      for update`;
    const firstCounter = Number(counters[0]?.next_counter ?? 1);

    for (let attempt = 0; attempt <= maxSkips; attempt++) {
      const counter = firstCounter + attempt;
      const number = input.format({ pattern: found.pattern, period, counter });
      const reserved = yield* sql`
        insert into number_reservations (workspace_id, kind, number, series_id, document_id)
        values (${workspaceId}, ${found.kind}, ${number}, ${seriesId}, ${input.documentId ?? null})
        on conflict (workspace_id, kind, number) do nothing
        returning number`;
      if (reserved.length > 0) {
        yield* sql`
          update numbering_counters set next_counter = ${counter + 1}
          where workspace_id = ${workspaceId} and series_id = ${seriesId} and period = ${period}`;
        return { number, counter, kind: found.kind };
      }
    }
    return yield* new NumberingExhausted({
      seriesId,
      period,
      firstCounter,
      attempts: maxSkips + 1,
    });
  }).pipe(withSavepoint);

export interface ReserveNumberInput {
  readonly workspaceId: string;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly seriesId?: string;
  readonly documentId?: string;
}

/**
 * Reserves a number chosen by hand (an override, rule D4). Insert-only: a reservation is never
 * released, so a number moved away from stays taken. Fails with `NumberTaken` when the Workspace
 * already reserved this number for this kind.
 */
export const reserveNumber = (
  input: ReserveNumberInput,
): Effect.Effect<void, NumberTaken | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { workspaceId, kind, number } = input;
    const inserted = yield* sql`
      insert into number_reservations (workspace_id, kind, number, series_id, document_id)
      values (${workspaceId}, ${kind}, ${number}, ${input.seriesId ?? null}, ${input.documentId ?? null})
      on conflict (workspace_id, kind, number) do nothing
      returning number`;
    if (inserted.length === 0) return yield* new NumberTaken({ workspaceId, kind, number });
  });
