import { Data } from "effect";
import type { DocumentKind, RevisionedTable } from "./tables";

/**
 * No row with this id in this Workspace. A row that exists in another Workspace is reported the
 * same way, so callers cannot probe other tenants (core-ports.md S7).
 */
export class RowNotFound extends Data.TaggedError("RowNotFound")<{
  readonly table: RevisionedTable | "numbering_series";
  readonly workspaceId: string;
  readonly id: string;
}> {}

/** `expectedRevision` is stale (core-ports.md C2, S2); maps to `Conflict{revision_changed}`. */
export class RevisionConflict extends Data.TaggedError("RevisionConflict")<{
  readonly table: RevisionedTable;
  readonly id: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;
}> {}

/** The number is already reserved for this Workspace and kind (core-ports.md S3, rule D4). */
export class NumberTaken extends Data.TaggedError("NumberTaken")<{
  readonly workspaceId: string;
  readonly kind: DocumentKind;
  readonly number: string;
}> {}

/**
 * Every candidate the formatter produced within the skip budget was already reserved. Usually a
 * pattern without a counter token.
 */
export class NumberingExhausted extends Data.TaggedError("NumberingExhausted")<{
  readonly seriesId: string;
  readonly period: string;
  readonly firstCounter: number;
  readonly attempts: number;
}> {}
