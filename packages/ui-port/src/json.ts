import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const JsonText = Schema.fromJsonString(Schema.Unknown);

const encode = Schema.encodeResult(JsonText);

// biome-ignore lint/plugin/no-unknown-parameters: The encoder accepts any value and checks JSON serializability.
export const stringifyJson = (value: unknown): string => Result.getOrThrow(encode(value));
