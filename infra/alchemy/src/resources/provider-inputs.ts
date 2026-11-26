import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

/**
 * A prop of a provider diff's `news` that is already a plain string. While
 * a plan runs, the props or the prop can still be an unresolved Output,
 * Config or Effect, which cannot differ yet, so it reads as `undefined`.
 */
export const resolvedStringProp = (key: string) =>
  flow(
    Schema.decodeUnknownOption(Schema.Struct({ [key]: Schema.String })),
    Option.flatMap(Record.get(key)),
  );
