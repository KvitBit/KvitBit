/**
 * Row conventions for module repositories, and `MemoryTables`: the in-memory table substrate
 * that in-memory repository implementations are written on. Its operations run inside the
 * in-memory `CoreStore`'s transactions (same snapshot, same frames), so rule C1 holds in tests.
 *
 * A module repository port names its operations (e.g. `ContactsRepo.searchByName`) and keeps
 * these semantics, which its SQL implementation must also pass in the shared contract tests:
 * - every read and write is scoped by `workspaceId`; another Workspace's row is `NotFound` (R2);
 * - `getForUpdate(workspaceId, id, expectedRevision)` row-locks and fails with
 *   `Conflict{revision_changed, currentRevision}` before any state-dependent rule (C2, S2);
 *   `lock(workspaceId, id)` row-locks without a revision, for methods idempotent by state (C6);
 * - `update(next, expectedRevision)` is a compare-and-set that stores revision + 1;
 * - a broken unique index is `UniqueViolation{constraint: <index name>}`;
 * - failures of the database are `StoreUnavailable`.
 */
import type { Conflict, EntityKind, NotFound, WorkspaceId } from "@kvitbit/domain/contract";
import type { Effect, Option, Schema } from "effect";
import { Context } from "effect";
import type { StoreUnavailable, UniqueViolation } from "./CoreStore";

/** Every stored aggregate row: tenant-scoped (S7) and revisioned (C2). */
export interface Row {
  readonly id: string;
  /** The owning Workspace; a Workspace row carries its own id. */
  readonly workspaceId: WorkspaceId;
  /** Starts at 1 and grows by one on every update. */
  readonly revision: number;
}

/** Top-level fields usable in queries: scalar values only. */
export type Scalar = string | number | boolean | null;
export type ScalarKeys<A> = {
  [K in keyof A & string]-?: A[K] extends Scalar | undefined ? K : never;
}[keyof A & string];

/**
 * A unique index, named after the database index. `key` returns the indexed tuple, or `null`
 * when the row is outside the index (a NULL column or a partial-index predicate), so
 * expression and partial indexes are expressible, e.g.
 * `key: (i) => (i.status === "pending" ? [i.email.toLowerCase()] : null)`.
 */
export interface UniqueConstraint<A> {
  readonly name: string;
  /** `"workspace"`: unique per Workspace; `"global"`: unique across the install (e.g. slug). */
  readonly scope: "workspace" | "global";
  readonly key: (row: A) => ReadonlyArray<Scalar> | null;
}

/** One aggregate's table, declared once by the module that owns it. */
export interface CollectionDef<A extends Row> {
  /** Table name, e.g. `"price_list_items"`. */
  readonly name: string;
  /** `NotFound.entity` for misses. */
  readonly entity: EntityKind;
  /** Row codec; the SQL implementation encodes and decodes rows through it. */
  readonly schema: Schema.Codec<A, unknown>;
  readonly unique?: ReadonlyArray<UniqueConstraint<A>>;
}

export const defineCollection = <A extends Row>(def: CollectionDef<A>): CollectionDef<A> => def;

/**
 * The query shape every implementation maps to SQL: equality, `IN` and ranges on top-level
 * scalar fields, one sort direction, keyset paging. Anything else is a named operation.
 */
export interface Query<A> {
  readonly where?: { readonly [K in ScalarKeys<A>]?: A[K] };
  readonly whereIn?: { readonly [K in ScalarKeys<A>]?: ReadonlyArray<A[K]> };
  readonly range?: {
    readonly [K in ScalarKeys<A>]?: {
      readonly gt?: A[K];
      readonly gte?: A[K];
      readonly lt?: A[K];
      readonly lte?: A[K];
    };
  };
  /** Sort keys; `id` is always the final tie-break. Default: `id`. Strings sort by code unit. */
  readonly orderBy?: ReadonlyArray<ScalarKeys<A>>;
  readonly direction?: "asc" | "desc";
  /** Keyset cursor: the `orderBy` values then the `id` of the last row of the previous page. */
  readonly after?: ReadonlyArray<Scalar>;
  readonly limit?: number;
}

export interface Collection<A extends Row> {
  /** Another Workspace's row is `NotFound`, never visible (rule R2). */
  readonly get: (
    workspaceId: WorkspaceId,
    id: string,
  ) => Effect.Effect<A, NotFound | StoreUnavailable>;
  readonly find: (
    workspaceId: WorkspaceId,
    id: string,
  ) => Effect.Effect<Option.Option<A>, StoreUnavailable>;
  /**
   * Row-locks for the rest of the transaction and checks the caller's `expectedRevision`
   * (rules C2, S2): a stale revision fails with `Conflict{revision_changed, currentRevision}`
   * before the module runs any state-dependent rule. Only inside `transaction`.
   */
  readonly getForUpdate: (
    workspaceId: WorkspaceId,
    id: string,
    expectedRevision: number,
  ) => Effect.Effect<A, NotFound | Conflict | StoreUnavailable>;
  /** Row-lock without a revision check, for methods idempotent by state (C6). */
  readonly lock: (
    workspaceId: WorkspaceId,
    id: string,
  ) => Effect.Effect<A, NotFound | StoreUnavailable>;
  /** Stores `row` with revision 1, whatever `row.revision` says. */
  readonly insert: (row: A) => Effect.Effect<A, UniqueViolation | StoreUnavailable>;
  /**
   * Compare-and-set: stores `next` with revision `expectedRevision + 1` if the stored row is at
   * `expectedRevision` (pass the revision of the row you locked), else
   * `Conflict{revision_changed, currentRevision}`. `next.revision` is ignored.
   */
  readonly update: (
    next: A,
    expectedRevision: number,
  ) => Effect.Effect<A, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
  /** Hard delete with the same compare-and-set as `update`. */
  readonly remove: (
    workspaceId: WorkspaceId,
    id: string,
    expectedRevision: number,
  ) => Effect.Effect<void, NotFound | Conflict | StoreUnavailable>;
  readonly list: (
    workspaceId: WorkspaceId,
    query?: Query<A>,
  ) => Effect.Effect<ReadonlyArray<A>, StoreUnavailable>;
  /**
   * Cross-tenant query. Only for flows that have no Workspace yet (Account caller: memberships
   * of a user, token lookups) and core-internal maintenance; never with a Member's input alone.
   */
  readonly listGlobal: (query?: Query<A>) => Effect.Effect<ReadonlyArray<A>, StoreUnavailable>;
  /**
   * Lookup by a declared unique constraint's key tuple. `workspaceId` is required for a
   * `"workspace"` constraint and ignored for a `"global"` one.
   */
  readonly findUnique: (
    constraint: string,
    key: ReadonlyArray<Scalar>,
    workspaceId?: WorkspaceId,
  ) => Effect.Effect<Option.Option<A>, StoreUnavailable>;
}

/** In-memory tables sharing the in-memory `CoreStore`'s transactions. Tests only. */
export class MemoryTables extends Context.Service<
  MemoryTables,
  { readonly collection: <A extends Row>(def: CollectionDef<A>) => Collection<A> }
>()("kvitbit/core/testing/MemoryTables") {}
