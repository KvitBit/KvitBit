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

/** One counter: a series and its period key (`YYYY`, `YYYY-MM` or `all`). */
export interface CounterKey {
  readonly workspaceId: string;
  readonly seriesId: string;
  readonly period: string;
}

const counterWhere = (sql: SqlClient.SqlClient, key: CounterKey) =>
  sql`workspace_id = ${key.workspaceId} and series_id = ${key.seriesId} and period = ${key.period}`;

/**
 * Upserts the counter row and locks it `FOR UPDATE` until the caller's transaction ends; returns
 * the next counter value (1 for a new period). Lock it after the document (core-ports.md S4). A
 * series outside the Workspace is `RowNotFound`, whether or not its owner has a counter.
 */
export const lockCounter = (
  key: CounterKey,
): Effect.Effect<number, RowNotFound | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const series = yield* sql`
      select 1 from numbering_series
      where workspace_id = ${key.workspaceId} and id = ${key.seriesId}`;
    if (series.length === 0) {
      return yield* new RowNotFound({
        table: "numbering_series",
        workspaceId: key.workspaceId,
        id: key.seriesId,
      });
    }
    yield* sql`
      insert into numbering_counters (workspace_id, series_id, period)
      values (${key.workspaceId}, ${key.seriesId}, ${key.period})
      on conflict (series_id, period) do nothing`;
    const rows = yield* sql<{ readonly next_counter: number }>`
      select next_counter from numbering_counters where ${counterWhere(sql, key)} for update`;
    const row = rows[0];
    if (row === undefined) {
      return yield* Effect.die(
        new Error(`sql: numbering counter ${key.seriesId}/${key.period} vanished after upsert`),
      );
    }
    return Number(row.next_counter);
  });

/** The next counter value without locking or creating the row (1 when the period is unused). */
export const peekCounter = (
  key: CounterKey,
): Effect.Effect<number, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly next_counter: number }>`
      select next_counter from numbering_counters where ${counterWhere(sql, key)}`;
    return Number(rows[0]?.next_counter ?? 1);
  });

/**
 * Moves the counter to `next`. Counters only grow: a lower value, or a counter that does not
 * exist, is a defect. Call it after `lockCounter` in the same transaction.
 */
export const setCounter = (
  key: CounterKey,
  next: number,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const updated = yield* sql`
      update numbering_counters set next_counter = ${next}
      where ${counterWhere(sql, key)} and next_counter <= ${next}
      returning next_counter`;
    if (updated.length === 0) {
      return yield* Effect.die(
        new Error(
          `sql: numbering counter ${key.seriesId}/${key.period} is missing or above ${next}`,
        ),
      );
    }
  });

export interface Reservation {
  readonly workspaceId: string;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly seriesId?: string;
  /** Document holding the number; it must exist in the same Workspace. */
  readonly documentId?: string;
}

/**
 * Reserves a number for a Workspace and kind (core-ports.md S3, rule D4). Insert-only: a
 * reservation is never released. Returns `false` when the number is already reserved; that
 * outcome never aborts the transaction (`ON CONFLICT DO NOTHING`).
 */
export const tryReserveNumber = (
  reservation: Reservation,
): Effect.Effect<boolean, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { workspaceId, kind, number } = reservation;
    const inserted = yield* sql`
      insert into number_reservations (workspace_id, kind, number, series_id, document_id)
      values (${workspaceId}, ${kind}, ${number}, ${reservation.seriesId ?? null},
        ${reservation.documentId ?? null})
      on conflict (workspace_id, kind, number) do nothing
      returning number`;
    return inserted.length > 0;
  });

/** `tryReserveNumber` for a hand-picked number (an override): a taken number is `NumberTaken`. */
export const reserveNumber = (
  reservation: Reservation,
): Effect.Effect<void, NumberTaken | SqlError, SqlClient.SqlClient> =>
  Effect.flatMap(tryReserveNumber(reservation), (reserved) =>
    reserved
      ? Effect.void
      : Effect.fail(
          new NumberTaken({
            workspaceId: reservation.workspaceId,
            kind: reservation.kind,
            number: reservation.number,
          }),
        ),
  );

/** The series as `allocateNumber` read it. */
export interface SeriesSnapshot {
  readonly kind: DocumentKind;
  /** `numbering_series.pattern`. */
  readonly pattern: string;
}

/** What the formatter sees for one candidate number. */
export interface NumberCandidate extends SeriesSnapshot {
  readonly period: string;
  readonly counter: number;
}

export interface AllocateNumberInput {
  readonly workspaceId: string;
  readonly seriesId: string;
  /**
   * Counter period for the series as read, e.g. from the issue date and the pattern's reset
   * cadence. Taking the pattern from the same locked read keeps period and format consistent.
   */
  readonly period: (series: SeriesSnapshot) => string;
  /** Pure formatter, normally core's `Numbering.format`. */
  readonly format: (candidate: NumberCandidate) => string;
  readonly documentId?: string;
  /** Reserved candidates to skip before failing with `NumberingExhausted`. Default 10000. */
  readonly maxSkips?: number;
}

export interface AllocatedNumber {
  readonly number: string;
  readonly counter: number;
  readonly period: string;
  readonly kind: DocumentKind;
}

/**
 * Allocates the next number of a series (core-ports.md S3): reads the series `FOR SHARE` (its
 * pattern cannot change until the caller commits), locks the period's counter, skips numbers
 * already reserved, reserves the first free one and moves the counter past it.
 *
 * Run it inside the issue transaction, after locking the document (S4). It opens a savepoint of
 * its own, so its failures leave nothing behind, and a rollback of the caller's transaction
 * reverts counter and reservation together: allocation never leaves a gap.
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
    const { workspaceId, seriesId } = input;
    const maxSkips = input.maxSkips ?? 10_000;

    const rows = yield* sql<SeriesSnapshot>`
      select kind, pattern from numbering_series
      where workspace_id = ${workspaceId} and id = ${seriesId}
      for share`;
    const row = rows[0];
    if (row === undefined) {
      return yield* new RowNotFound({ table: "numbering_series", workspaceId, id: seriesId });
    }
    const series: SeriesSnapshot = { kind: row.kind, pattern: row.pattern };
    const period = input.period(series);
    const key = { workspaceId, seriesId, period };
    const firstCounter = yield* lockCounter(key);

    for (let attempt = 0; attempt <= maxSkips; attempt++) {
      const counter = firstCounter + attempt;
      const number = input.format({ ...series, period, counter });
      const reserved = yield* tryReserveNumber({
        workspaceId,
        kind: series.kind,
        number,
        seriesId,
        ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      });
      if (reserved) {
        yield* setCounter(key, counter + 1);
        return { number, counter, period, kind: series.kind };
      }
    }
    return yield* new NumberingExhausted({
      seriesId,
      period,
      firstCounter,
      attempts: maxSkips + 1,
    });
  }).pipe(withSavepoint);
