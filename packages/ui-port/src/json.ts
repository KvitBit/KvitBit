import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const stringifyJson = Fn.flow(
  Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
