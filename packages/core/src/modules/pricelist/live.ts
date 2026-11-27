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
import {
  Conflict,
  PriceList,
  PriceListItemId as PriceListItemIdSchema,
} from "@kvitbit/domain/contract";
/**
 * `PriceList` (core-ports 4.3). A Price List Item only supplies defaults: lines copy its values
 * when a document is drafted, so later edits never change existing documents. Not audited (no
 * tax effect).
 */
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { authorizeInWorkspace } from "../../policy/Policy";
import { canonicalJson } from "../../shared/canonicalJson";
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

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

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
    canonicalJson(strip(a)) === canonicalJson(strip(b)) &&
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
  const ids = yield* IdGenerator;
  const context = Context.make(CoreStore, store).pipe(
    Context.add(IdGenerator, ids),
    Context.add(PriceListRepo, repo),
  );

  const create = Effect.fn("create")(function* (
    workspaceId: WorkspaceId,
    fields: PriceListItemSaveFields,
  ) {
    const missing = Option.getOrUndefined(
      EffectArray.findFirst(
        ["name", "unitPrice", "currency"] as const,
        (key) => fields[key] === undefined,
      ),
    );
    if (missing !== undefined) return yield* invalidAt([missing], "request.malformed");
    const { name, unitPrice, currency } = fields;
    if (name === undefined || unitPrice === undefined || currency === undefined) {
      return yield* Effect.die("unreachable: required fields checked above");
    }
    const now = yield* nowIso;
    const row: PriceListItemRow = {
      id: yield* newId(PriceListItemIdSchema.make),
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

  const edit = Effect.fn("edit")(function* (
    workspaceId: WorkspaceId,
    id: PriceListItemId,
    expectedRevision: number | undefined,
    fields: PriceListItemSaveFields,
  ) {
    // An edit without expectedRevision is stale by definition (rule C2): report the current one.
    const current =
      expectedRevision === undefined
        ? yield* Effect.flatMap(repo.lock(workspaceId, id), (row) =>
            Effect.fail(
              Conflict.make({ reason: "revision_changed", currentRevision: row.revision }),
            ),
          )
        : yield* repo.getForUpdate(workspaceId, id, expectedRevision);
    const nowIso_1 = yield* nowIso;
    const next = applyFields(current, fields, nowIso_1);
    if (sameContent(current, next)) return current;
    return yield* repo
      .update(next, current.revision)
      .pipe(Effect.catchTag("UniqueViolation", Effect.die));
  });

  const impl: PriceListImpl = {
    save: Effect.fn("save")(
      function* (input, opts) {
        const { workspaceId } = yield* authorizeInWorkspace("priceList.write");
        // The whole input, strictly: unknown fields, a malformed id or revision are Invalid.
        const { id, expectedRevision, ...fields } = yield* decodeInput(
          PriceListItemSaveInput,
          input,
        );
        return yield* withIdempotency(
          {
            scope: { _tag: "Workspace", workspaceId },
            key: opts?.requestKey,
            method: "PriceList.save",
            payload: {
              schema: PriceListItemSavePayload,
              value: { fields, id, expectedRevision },
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
      },
      Effect.provide(context),
      (_) => orUnavailable(_),
    ),

    archive: Effect.fn("archive")(
      function* (id) {
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
      },
      Effect.provide(context),
      (_) => orUnavailable(_),
    ),

    list: Effect.fn("list")(
      function* (q) {
        const { workspaceId } = yield* authorizeInWorkspace("priceList.read");
        const rows = yield* repo.list(workspaceId, {
          text: q?.text,
          includeArchived: q?.includeArchived ?? false,
        });
        return EffectArray.map(rows, toPriceListItemView);
      },
      Effect.provide(context),
      (_) => orUnavailable(_),
    ),
  };
  return impl;
});

/** `PriceList` on CoreStore, IdGenerator and `PriceListRepo`. */
export const PriceListLive: Layer.Layer<PriceList, never, CoreStore | IdGenerator | PriceListRepo> =
  Layer.effect(PriceList, makePriceList);
