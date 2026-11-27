import { documentKindValues } from "@kvitbit/db/schema";
import * as Schema from "effect/Schema";
import { revisionedTableNames } from "./tables";

const RevisionedTableName = Schema.Literals(revisionedTableNames);

/**
 * No row with this id in this Workspace. A row that exists in another Workspace is reported the
 * same way, so callers cannot probe other tenants (core-ports.md S7).
 */
export class RowNotFound extends Schema.TaggedError<
  RowNotFound,
  { readonly brand: unique symbol }
>()("RowNotFound", {
  table: RevisionedTableName,
  workspaceId: Schema.String,
  id: Schema.String,
}) {}

/** `expectedRevision` is stale (core-ports.md C2, S2); maps to `Conflict{revision_changed}`. */
export class RevisionConflict extends Schema.TaggedError<
  RevisionConflict,
  { readonly brand: unique symbol }
>()("RevisionConflict", {
  table: RevisionedTableName,
  id: Schema.String,
  // Comparisons also report caller-provided or malformed non-finite revisions.
  // @effect-diagnostics-next-line schemaNumber:off
  expectedRevision: Schema.Number,
  // @effect-diagnostics-next-line schemaNumber:off
  currentRevision: Schema.Number,
}) {}

/** The number is already reserved for this Workspace and kind (core-ports.md S3, rule D4). */
export class NumberTaken extends Schema.TaggedError<
  NumberTaken,
  { readonly brand: unique symbol }
>()("NumberTaken", {
  workspaceId: Schema.String,
  kind: Schema.Literals(documentKindValues),
  number: Schema.String,
}) {}

/**
 * Every candidate the formatter produced within the skip budget was already reserved. Usually a
 * pattern without a counter token.
 */
export class NumberingExhausted extends Schema.TaggedError<
  NumberingExhausted,
  { readonly brand: unique symbol }
>()(
  // biome-ignore lint/security/noSecrets: Public SQL error tag.
  "NumberingExhausted",
  {
    seriesId: Schema.String,
    period: Schema.String,
    firstCounter: Schema.Finite,
    attempts: Schema.Finite,
  },
) {}
