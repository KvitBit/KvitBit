/**
 * `NumberingSeries`: core-internal module behind `Workspaces.configureSeries/listSeries`
 * (agreement on the board, #331/#335) and `Documents.issue`/number override (rules D1, D4, S3).
 * It never authorizes, opens transactions or audits: its callers do (method shape in
 * src/index.ts). Writes must run inside the caller's `CoreStore.transaction`; `allocate` runs
 * after the document row lock (lock order S4: documents, then counters).
 */
import type {
  Conflict as ConflictType,
  DocumentId,
  DocumentKind,
  IsoDate,
  NumberingSeriesId,
  NumberingSeriesView,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Conflict, Invalid, NotFound } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Option, Result } from "effect";
import { Numbering, type NumberPattern } from "../../engines/numbering";
import { IdGenerator } from "../../shared/ids";
import { CoreStore, type StoreUnavailable, type UniqueViolation } from "../../store/CoreStore";
import { reserveNumber } from "../../store/numbering";
import { DEFAULT_PER_KIND, NumberingSeriesRepo, type SeriesRow } from "./repo";

/** Default patterns per kind (user-flows step 5). */
export const DEFAULT_SERIES_PATTERNS: Readonly<Record<DocumentKind, string>> = {
  invoice: "YYYY-NNNN",
  proforma: "ZF-YYYY-NNNN",
  payment_tax_document: "DD-YYYY-NNNN",
  credit_note: "OD-YYYY-NNNN",
};

export const DEFAULT_SERIES_NAMES: Readonly<Record<DocumentKind, string>> = {
  invoice: "Faktury",
  proforma: "Zálohové faktury",
  payment_tax_document: "Daňové doklady k platbě",
  credit_note: "Opravné doklady",
};

/** Exactly the domain `Workspaces.configureSeries` input. */
export interface ConfigureSeriesInput {
  readonly id?: NumberingSeriesId;
  readonly kind: DocumentKind;
  readonly name: string;
  readonly pattern: string;
  readonly nextNumber?: number;
  readonly isDefault?: boolean;
}

export interface Allocation {
  readonly number: string;
  readonly sequence: number;
  readonly seriesId: NumberingSeriesId;
}

export interface NumberingSeriesShape {
  /**
   * Creates (no `id`) or edits a series. Pattern errors are `Invalid{pattern}`; `nextNumber`
   * below the current period's next counter is `Invalid{nextNumber, reason below_used}`;
   * changing the kind, or `isDefault: false` on the kind's default, is
   * `Conflict{illegal_transition}`. The first series of a kind is its default whatever
   * `isDefault` says; `isDefault: true` demotes the previous default. `before` is the view
   * before the edit (null on create), for the caller's audit diff.
   */
  readonly configure: (
    workspaceId: WorkspaceId,
    input: ConfigureSeriesInput,
    today: IsoDate,
  ) => Effect.Effect<
    { readonly view: NumberingSeriesView; readonly before: NumberingSeriesView | null },
    Invalid | NotFound | ConflictType | StoreUnavailable
  >;
  readonly list: (
    workspaceId: WorkspaceId,
    today: IsoDate,
  ) => Effect.Effect<ReadonlyArray<NumberingSeriesView>, StoreUnavailable>;
  /** Creates a default series for each listed kind that has none (Workspaces.create). */
  readonly ensureDefaults: (
    workspaceId: WorkspaceId,
    kinds: ReadonlyArray<DocumentKind>,
  ) => Effect.Effect<void, StoreUnavailable>;
  /**
   * The series a document of `kind` numbers from: `seriesId` when given (another Workspace's
   * or another kind's series is `NotFound`), else the kind's default.
   */
  readonly resolve: (
    workspaceId: WorkspaceId,
    kind: DocumentKind,
    seriesId?: NumberingSeriesId,
  ) => Effect.Effect<SeriesRow, NotFound | StoreUnavailable>;
  /**
   * Allocates the next free number of the series for `issuedOn` (rule S3): locks the period's
   * counter, skips reserved numbers, reserves the number for the document and advances the
   * counter. A rollback of the caller's transaction reverts all of it (no gap). A series whose
   * next free number would exceed 20 characters or the counter range is exhausted:
   * `Conflict{illegal_transition, detail numbering.pattern_invalid}` (the owner edits it).
   */
  readonly allocate: (input: {
    readonly workspaceId: WorkspaceId;
    readonly kind: DocumentKind;
    readonly seriesId: NumberingSeriesId;
    readonly documentId: DocumentId;
    readonly issuedOn: IsoDate;
  }) => Effect.Effect<Allocation, NotFound | ConflictType | StoreUnavailable>;
  /**
   * Number override (rule D4): reserves `number` (trimmed) for the document. Taken in the
   * Workspace for that kind -> `Conflict{duplicate}`. The document's old number stays reserved
   * (reservations are insert-only) and the series counter does not move.
   */
  readonly override: (input: {
    readonly workspaceId: WorkspaceId;
    readonly kind: DocumentKind;
    readonly documentId: DocumentId;
    readonly number: string;
  }) => Effect.Effect<string, Invalid | ConflictType | StoreUnavailable>;
  /** The view of one series for `today` (Prague). */
  readonly view: (
    row: SeriesRow,
    today: IsoDate,
  ) => Effect.Effect<NumberingSeriesView, StoreUnavailable>;
}

export class NumberingSeries extends Context.Service<NumberingSeries, NumberingSeriesShape>()(
  "kvitbit/core/NumberingSeries",
) {}

/** A stored pattern is valid by construction; a broken one is a defect. */
const storedPattern = (row: SeriesRow): NumberPattern =>
  Result.getOrThrowWith(Numbering.parsePattern(row.pattern), () => {
    return new Error(`numbering_series ${row.id}: stored pattern "${row.pattern}" is invalid`);
  });

const illegal = () => new Conflict({ reason: "illegal_transition" });

/** The series cannot number another document (20 characters or the counter range reached). */
const exhausted = () =>
  new Conflict({ reason: "illegal_transition", detail: "numbering.pattern_invalid" });

const nameInvalid = () =>
  new Invalid({
    issues: [{ path: ["name"], code: "request.malformed", params: { reason: "empty" } }],
  });

export const make = Effect.gen(function* () {
  const store = yield* CoreStore;
  const ids = yield* IdGenerator;
  const repo = yield* NumberingSeriesRepo;

  const counterKey = (row: SeriesRow, pattern: NumberPattern, date: IsoDate) => ({
    workspaceId: row.workspaceId,
    seriesId: row.id,
    period: Numbering.periodKey(pattern, date),
  });

  const view: NumberingSeriesShape["view"] = (row, today) =>
    Effect.gen(function* () {
      const pattern = storedPattern(row);
      const key = counterKey(row, pattern, today);
      const nextCounter = yield* store.counters.peek(key);
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        pattern: row.pattern,
        isDefault: row.isDefault,
        periodKey: key.period,
        nextCounter,
        nextNumber: Numbering.format(pattern, today, nextCounter),
      };
    });

  /** Demotes the kind's current default unless it is `keep`. */
  const demoteDefault = (workspaceId: WorkspaceId, kind: DocumentKind, keep?: NumberingSeriesId) =>
    Effect.gen(function* () {
      const current = yield* repo.findDefault(workspaceId, kind);
      if (Option.isNone(current) || current.value.id === keep) return;
      // Found in this transaction and locked before the update: a miss or a conflict is a defect.
      const locked = yield* Effect.catchTag(
        repo.lock(workspaceId, current.value.id),
        "NotFound",
        Effect.die,
      );
      yield* repo.update({ ...locked, isDefault: false }, locked.revision).pipe(
        Effect.catchTags({
          NotFound: Effect.die,
          Conflict: Effect.die,
          UniqueViolation: Effect.die,
        }),
      );
    });

  /**
   * Runs a write that may promote a default in a savepoint. Under READ COMMITTED two
   * transactions can both see the old default (or none) and race on the one-default index;
   * the loser's savepoint rolls back and it retries against the now committed default. Any
   * other unique violation, or a revision conflict or miss on rows locked in this transaction,
   * is a defect.
   */
  const defaultSafe = <A>(
    write: Effect.Effect<A, NotFound | ConflictType | UniqueViolation | StoreUnavailable>,
  ): Effect.Effect<A, StoreUnavailable> => {
    const attempt = (left: number): Effect.Effect<A, StoreUnavailable> =>
      store.transaction(write).pipe(
        Effect.catchTags({
          NotFound: Effect.die,
          Conflict: Effect.die,
          UniqueViolation: (e) =>
            e.constraint === DEFAULT_PER_KIND && left > 0 ? attempt(left - 1) : Effect.die(e),
        }),
      );
    return attempt(3);
  };

  const configure: NumberingSeriesShape["configure"] = (workspaceId, input, today) =>
    Effect.gen(function* () {
      const pattern = yield* Effect.fromResult(Numbering.parsePattern(input.pattern));
      const name = input.name.trim();
      if (name.length === 0) return yield* Effect.fail(nameInvalid());
      let before: NumberingSeriesView | null = null;
      let row: SeriesRow;
      if (input.id !== undefined) {
        const locked = yield* repo.lock(workspaceId, input.id);
        if (locked.kind !== input.kind) return yield* Effect.fail(illegal());
        if (input.isDefault === false && locked.isDefault) return yield* Effect.fail(illegal());
        before = yield* view(locked, today);
        const isDefault = locked.isDefault || input.isDefault === true;
        row = yield* defaultSafe(
          Effect.gen(function* () {
            if (isDefault && !locked.isDefault) {
              yield* demoteDefault(workspaceId, input.kind, locked.id);
            }
            return yield* repo.update(
              { ...locked, name, pattern: input.pattern, isDefault },
              locked.revision,
            );
          }),
        );
      } else {
        const id = (yield* ids.next) as NumberingSeriesId;
        row = yield* defaultSafe(
          Effect.gen(function* () {
            // Only an explicit promotion demotes. An implicit default (first of its kind) is
            // inserted as is: if a concurrent default committed after our read, the index
            // rejects it and the retry re-reads and inserts a non-default.
            const explicit = input.isDefault === true;
            const isDefault =
              explicit || Option.isNone(yield* repo.findDefault(workspaceId, input.kind));
            if (explicit) yield* demoteDefault(workspaceId, input.kind);
            return yield* repo.insert({
              id,
              workspaceId,
              revision: 1,
              kind: input.kind,
              name,
              pattern: input.pattern,
              isDefault,
            });
          }),
        );
      }
      if (input.nextNumber !== undefined) {
        const key = counterKey(row, pattern, today);
        const currentNext = yield* store.counters.lock(key);
        const requested = yield* Effect.fromResult(
          Numbering.checkNextCounter(currentNext, input.nextNumber),
        );
        if (!Numbering.fitsLength(pattern, today, requested)) {
          return yield* Effect.fail(
            new Invalid({
              issues: [
                {
                  path: ["nextNumber"],
                  code: "numbering.pattern_invalid",
                  params: { reason: "too_long" },
                },
              ],
            }),
          );
        }
        if (requested > currentNext) yield* store.counters.set(key, requested);
      } else {
        // A pattern edit keeps the period's counter: the next number must still fit.
        const next = yield* store.counters.peek(counterKey(row, pattern, today));
        if (!Numbering.fitsLength(pattern, today, next)) {
          return yield* Effect.fail(
            new Invalid({
              issues: [
                {
                  path: ["pattern"],
                  code: "numbering.pattern_invalid",
                  params: { reason: "too_long" },
                },
              ],
            }),
          );
        }
      }
      return { view: yield* view(row, today), before };
    });

  const list: NumberingSeriesShape["list"] = (workspaceId, today) =>
    Effect.flatMap(repo.list(workspaceId), (rows) =>
      Effect.forEach(rows, (row) => view(row, today)),
    );

  const ensureDefaults: NumberingSeriesShape["ensureDefaults"] = (workspaceId, kinds) =>
    Effect.forEach(
      kinds,
      (kind) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* repo.findDefault(workspaceId, kind))) return;
          const id = (yield* ids.next) as NumberingSeriesId;
          // A concurrent creator that committed the default first wins; ours is not needed.
          yield* store
            .transaction(
              repo.insert({
                id,
                workspaceId,
                revision: 1,
                kind,
                name: DEFAULT_SERIES_NAMES[kind],
                pattern: DEFAULT_SERIES_PATTERNS[kind],
                isDefault: true,
              }),
            )
            .pipe(
              Effect.catchTag("UniqueViolation", (e) =>
                e.constraint === DEFAULT_PER_KIND ? Effect.void : Effect.die(e),
              ),
            );
        }),
      { discard: true },
    );

  const resolve: NumberingSeriesShape["resolve"] = (workspaceId, kind, seriesId) =>
    Effect.gen(function* () {
      if (seriesId !== undefined) {
        const row = yield* repo.get(workspaceId, seriesId);
        if (row.kind !== kind) {
          return yield* Effect.fail(new NotFound({ entity: "NumberingSeries", id: seriesId }));
        }
        return row;
      }
      const found = yield* repo.findDefault(workspaceId, kind);
      if (Option.isNone(found)) {
        // ensureDefaults runs at Workspace creation; a kind without a default is a defect.
        return yield* Effect.die(
          new Error(`no default ${kind} series in Workspace ${workspaceId}`),
        );
      }
      return found.value;
    });

  const allocate: NumberingSeriesShape["allocate"] = (input) =>
    Effect.gen(function* () {
      const row = yield* resolve(input.workspaceId, input.kind, input.seriesId);
      const pattern = storedPattern(row);
      const key = counterKey(row, pattern, input.issuedOn);
      // The foundation's allocateNumber loop plus the 20-character and counter-range limits,
      // checked on every candidate (including after skipping a reserved number).
      for (let sequence = yield* store.counters.lock(key); ; sequence++) {
        const number =
          sequence <= Numbering.MAX_COUNTER
            ? Numbering.format(pattern, input.issuedOn, sequence)
            : null;
        if (number === null || number.length > Numbering.MAX_NUMBER_LENGTH) {
          return yield* Effect.fail(exhausted());
        }
        const reserved = yield* store.reservations.tryReserve({
          workspaceId: input.workspaceId,
          kind: input.kind,
          number,
          seriesId: row.id,
          documentId: input.documentId,
        });
        if (reserved) {
          yield* store.counters.set(key, sequence + 1);
          return { number, sequence, seriesId: row.id };
        }
      }
    });

  const override: NumberingSeriesShape["override"] = (input) =>
    Effect.gen(function* () {
      const number = yield* Effect.fromResult(Numbering.checkManualNumber(input.number));
      const reserved = yield* reserveNumber({
        workspaceId: input.workspaceId,
        kind: input.kind,
        number,
        seriesId: null,
        documentId: input.documentId,
      }).pipe(Effect.provideService(CoreStore, store));
      if (!reserved) return yield* Effect.fail(new Conflict({ reason: "duplicate" }));
      return number;
    });

  return NumberingSeries.of({ configure, list, ensureDefaults, resolve, allocate, override, view });
});

export const NumberingSeriesLive: Layer.Layer<
  NumberingSeries,
  never,
  CoreStore | IdGenerator | NumberingSeriesRepo
> = Layer.effect(NumberingSeries, make);
