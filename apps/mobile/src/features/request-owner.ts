import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Keep the persisted request owner keys compatible with existing pending writes.
export const requestOwner = Fn.flow(
  Schema.encodeOption(
    Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
  ),
  Option.getOrNull,
);
