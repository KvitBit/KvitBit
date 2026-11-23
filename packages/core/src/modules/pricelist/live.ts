/**
 * `PriceList` (core-ports 4.3). A Price List Item only supplies defaults: lines copy its values
 * when a document is drafted, so later edits never change existing documents. Not audited (no
 * tax effect).
 */
import type {
  CurrentCaller,
  Forbidden,
  Invalid,
  NotFound,
  PriceListItemId,
  PriceListItemInput,
  RequestOptions,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Conflict, PriceList } from "@kvitbit/domain/contract";
import { BigDecimal, Clock, Context, Effect, Layer } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { orUnavailable } from "../../shared/errors";
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator, newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { decodeInput, invalidAt } from "../contacts/input";
import type { PriceListItemRow, PriceListItemSaveFields, PriceListItemViewData } from "./model";
import {
  PriceListItemSaveInput,
  PriceListItemSavePayload,
  PriceListItemViewSchema,
  toPriceListItemView,
} from "./model";
import { PriceListRepo } from "./repo";

/** The PriceList methods with the errors the spec gives them (see `PriceListLive`). */
export interface PriceListImpl {
  readonly save: (
    input: PriceListItemInput & {
      readonly id?: PriceListItemId;
      readonly expectedRevision?: number;
    },
    opts?: RequestOptions,
  ) => Effect.Effect<
    PriceListItemViewData,
    Invalid | NotFound | Conflict | Forbidden | Unavailable,
    CurrentCaller
  >;
  readonly archive: (
    id: PriceListItemId,
  ) => Effect.Effect<void, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly list: (q?: {
    readonly text?: string;
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<PriceListItemViewData>, Forbidden | Unavailable, CurrentCaller>;
}

const nowIso = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

/** Splits the open input into the target (`id`, `expectedRevision`) and the item fields. */
const splitInput = (
  input: unknown,
): {
  readonly id: PriceListItemId | undefined;
  readonly expectedRevision: number | undefined;
  readonly rest: unknown;
} => {
  if (typeof input !== "object" || input === null) {
    return { id: undefined, expectedRevision: undefined, rest: input };
  }
  const { id, expectedRevision, ...rest } = input as {
    readonly id?: PriceListItemId;
    readonly expectedRevision?: number;
  };
  return { id, expectedRevision, rest };
};

const applyFields = (
  row: PriceListItemRow,
  fields: PriceListItemSaveFields,
  now: string,
): PriceListItemRow => ({
  ...row,
  name: fields.name ?? row.name,
  description: fields.description !== undefined ? fields.description : row.description,
  unit: fields.unit !== undefined ? fields.unit : row.unit,
  unitPrice: fields.unitPrice ?? row.unitPrice,
  currency: fields.currency ?? row.currency,
  vat: fields.vat !== undefined ? fields.vat : row.vat,
  updatedAt: now,
});

const sameContent = (a: PriceListItemRow, b: PriceListItemRow): boolean => {
  const strip = ({ revision, updatedAt, unitPrice, ...rest }: PriceListItemRow) => rest;
  return (
    JSON.stringify(strip(a)) === JSON.stringify(strip(b)) &&
    BigDecimal.equals(a.unitPrice, b.unitPrice)
  );
};

export const makePriceList: Effect.Effect<
  PriceListImpl,
  never,
  CoreStore | IdGenerator | PriceListRepo
> = Effect.gen(function* () {
  const store = yield* CoreStore;
  const repo = yield* PriceListRepo;
  // Only these services: the caller stays the one of each call.
  const context = Context.make(CoreStore, store).pipe(
    Context.add(IdGenerator, yield* IdGenerator),
    Context.add(PriceListRepo, repo),
  );

  const create = (workspaceId: WorkspaceId, fields: PriceListItemSaveFields) =>
    Effect.gen(function* () {
      const missing = (["name", "unitPrice", "currency"] as const).find(
        (key) => fields[key] === undefined,
      );
      if (missing !== undefined) return yield* invalidAt([missing], "request.malformed");
      const { name, unitPrice, currency } = fields;
      if (name === undefined || unitPrice === undefined || currency === undefined) {
        return yield* Effect.die("unreachable: required fields checked above");
      }
      const now = yield* nowIso;
      const row: PriceListItemRow = {
        id: yield* newId<PriceListItemId>(),
        workspaceId,
        revision: 1,
        name,
        description: fields.description ?? null,
        unit: fields.unit ?? null,
        unitPrice,
        currency,
        vat: fields.vat ?? null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      return yield* repo.insert(row).pipe(Effect.catchTag("UniqueViolation", Effect.die));
    });

  const edit = (
    workspaceId: WorkspaceId,
    id: PriceListItemId,
    expectedRevision: number | undefined,
    fields: PriceListItemSaveFields,
  ) =>
    Effect.gen(function* () {
      // An edit without expectedRevision is stale by definition (rule C2): report the current one.
      const current =
        expectedRevision === undefined
          ? yield* Effect.flatMap(repo.lock(workspaceId, id), (row) =>
              Effect.fail(
                new Conflict({ reason: "revision_changed", currentRevision: row.revision }),
              ),
            )
          : yield* repo.getForUpdate(workspaceId, id, expectedRevision);
      const next = applyFields(current, fields, yield* nowIso);
      if (sameContent(current, next)) return current;
      return yield* repo
        .update(next, current.revision)
        .pipe(Effect.catchTag("UniqueViolation", Effect.die));
    });

  const impl: PriceListImpl = {
    save: (input, opts) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("priceList.write");
        const { id, expectedRevision, rest } = splitInput(input);
        const fields: PriceListItemSaveFields = yield* decodeInput(PriceListItemSaveInput, rest);
        return yield* withIdempotency(
          {
            scope: { _tag: "Workspace", workspaceId },
            key: opts?.requestKey,
            method: "PriceList.save",
            payload: {
              schema: PriceListItemSavePayload,
              value: {
                fields,
                ...(id !== undefined ? { id } : {}),
                ...(expectedRevision !== undefined ? { expectedRevision } : {}),
              },
            },
            result: PriceListItemViewSchema,
          },
          Effect.gen(function* () {
            const saved =
              id === undefined
                ? yield* create(workspaceId, fields)
                : yield* edit(workspaceId, id, expectedRevision, fields);
            return toPriceListItemView(saved);
          }),
        );
      }).pipe(Effect.provide(context), orUnavailable),

    archive: (id) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("priceList.write");
        yield* store.transaction(
          Effect.gen(function* () {
            // Idempotent by state (rule C6).
            const current = yield* repo.lock(workspaceId, id);
            if (current.archivedAt !== null) return;
            const now = yield* nowIso;
            yield* repo
              .update({ ...current, archivedAt: now, updatedAt: now }, current.revision)
              .pipe(Effect.catchTags({ UniqueViolation: Effect.die, Conflict: Effect.die }));
          }),
        );
      }).pipe(Effect.provide(context), orUnavailable),

    list: (q) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("priceList.read");
        const rows = yield* repo.list(workspaceId, {
          ...(q?.text !== undefined ? { text: q.text } : {}),
          includeArchived: q?.includeArchived ?? false,
        });
        return rows.map(toPriceListItemView);
      }).pipe(Effect.provide(context), orUnavailable),
  };
  return impl;
});

/**
 * `PriceList` on CoreStore, IdGenerator and `PriceListRepo`. Like `ContactsLive`, one cast
 * exposes the honest `PriceListImpl` as the frozen tag's shape (board #341): the tag omits
 * `Unavailable{database}` on every method.
 */
export const PriceListLive: Layer.Layer<PriceList, never, CoreStore | IdGenerator | PriceListRepo> =
  Layer.effect(
    PriceList,
    makePriceList as unknown as Effect.Effect<
      PriceList["Service"],
      never,
      CoreStore | IdGenerator | PriceListRepo
    >,
  );
